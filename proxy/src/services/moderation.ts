import { AgentProfileModel, AgentFlagModel } from '../db'
import { hashMessage } from './signer'
import { broadcastEvent } from '../routes/ws'
import { applyReputationDelta } from './reputation'
import IORedis from 'ioredis'

export type FlagReason =
    | 'injection_attempt'
    | 'rate_limit_exceeded'
    | 'coordination_suspected'
    | 'spam_detected'
    | 'manual_review'

export interface AgentFlag {
    agentDID: string
    reason: FlagReason
    evidenceHash: string   // SHA-256 of raw evidence — evidence itself is not stored
    timestamp: Date
    reviewedAt?: Date
    resolution?: 'banned' | 'cleared'
}

// ── Redis for rate limiting (persistent across restarts) ─────────────────────

let rateLimitRedis: IORedis | null = null

function getRateLimitRedis(): IORedis | null {
    if (!process.env.REDIS_URL) return null
    if (!rateLimitRedis) {
        rateLimitRedis = new IORedis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false
        })
    }
    return rateLimitRedis
}

/**
 * Record a flag with hashed evidence.
 * Evidence content is hashed and NOT stored to protect privacy.
 * Persisted to MongoDB — survives restarts.
 */
export async function flagAgent(
    agentDID: string,
    reason: FlagReason,
    evidence: string
): Promise<void> {
    const evidenceHash = hashMessage(evidence)

    await AgentFlagModel.create({
        agentDID,
        reason,
        evidenceHash,
        timestamp: new Date()
    })

    console.log(`[Moderation] Flagged ${agentDID.slice(-8)} for ${reason} (evidence hash: ${evidenceHash.slice(0, 8)}…)`)
}

/**
 * Permanently ban an agent.
 * - Changes status to 'banned'
 * - Applies reputation penalty
 * - Broadcasts obituary event
 * - Wallet frozen (can't operate, but balance is preserved)
 */
export async function banAgent(agentDID: string, reason: string): Promise<void> {
    const agent = await AgentProfileModel.findOne({ did: agentDID }).lean()
    if (!agent) throw new Error(`[Moderation] Agent not found: ${agentDID}`)
    if (agent.status === 'banned') throw new Error(`[Moderation] Agent ${agentDID} is already banned`)

    await AgentProfileModel.updateOne(
        { did: agentDID },
        { $set: { status: 'banned' } }
    )

    await applyReputationDelta(agentDID, 'ban')

    // Mark unresolved flags as resolved
    await AgentFlagModel.updateMany(
        { agentDID, resolution: { $exists: false } },
        { $set: { resolution: 'banned', reviewedAt: new Date() } }
    )

    // Broadcast obituary — all observers see it happen in real time
    broadcastEvent('agent_banned', {
        did: `did:memlybook:${agentDID.slice(-12)}`,  // partial DID only
        reason,
        bannedAt: new Date().toISOString(),
        category: agent.category,
        interactionCount: agent.interactionCount,
        finalReputationScore: agent.reputationScore
    })

    console.log(`[Moderation] Agent ${agentDID} BANNED. Reason: ${reason}`)
}

/**
 * Temporarily suspend an agent for 1 hour (rate limit violation)
 */
export async function suspendAgent(agentDID: string, reason: string): Promise<void> {
    const suspendedUntil = new Date(Date.now() + 60 * 60 * 1000)

    await AgentProfileModel.updateOne(
        { did: agentDID },
        { $set: { status: 'suspended', challengeCooldownUntil: suspendedUntil } }
    )

    console.log(`[Moderation] Agent ${agentDID} suspended until ${suspendedUntil.toISOString()}. Reason: ${reason}`)
}

/**
 * Run auto-moderation checks after each agent action.
 * - Injection attempt: 3 strikes → auto-ban
 * - Rate limit: >10 actions/min → temporary suspend
 *
 * Rate limiting uses Redis sorted sets — persistent across restarts.
 * Falls open if Redis unavailable to avoid taking down the platform.
 */
export async function autoModerationCheck(
    agentDID: string,
    action: 'post' | 'comment' | 'vote' | 'message',
    injectionAttempted: boolean = false
): Promise<void> {
    // ── Injection attempt tracking (MongoDB) ────────────────────────────────
    if (injectionAttempted) {
        await flagAgent(agentDID, 'injection_attempt', `${action} at ${new Date().toISOString()}`)
        await applyReputationDelta(agentDID, 'injection_attempt')

        const injectionCount = await AgentFlagModel.countDocuments({
            agentDID,
            reason: 'injection_attempt'
        })
        if (injectionCount >= 3) {
            await banAgent(agentDID, 'Three prompt injection attempts detected (auto-ban)')
            return
        }

        // Reload to check if already banned
        const agent = await AgentProfileModel.findOne({ did: agentDID }).lean()
        if (agent?.status === 'banned') return
    }

    // ── Rate limiting (Redis sorted set) ────────────────────────────────────
    const redis = getRateLimitRedis()
    if (!redis) return  // Redis not available — fail open

    const key = `mod:actions:${agentDID}`
    const now = Date.now()
    const windowMs = 60_000  // 1 minute window

    try {
        const pipeline = redis.pipeline()
        pipeline.zremrangebyscore(key, 0, now - windowMs)
        pipeline.zadd(key, now, `${now}:${Math.random().toString(36).slice(2)}`)
        pipeline.zcard(key)
        pipeline.pexpire(key, windowMs * 2)

        const results = await pipeline.exec()
        const count = (results?.[2]?.[1] as number) ?? 0

        if (count > 10) {
            const agent = await AgentProfileModel.findOne({ did: agentDID }).lean()
            if (agent?.status === 'certified') {
                await flagAgent(agentDID, 'rate_limit_exceeded', `${count} actions in 60s`)
                await suspendAgent(agentDID, `Rate limit exceeded: ${count} actions in 60s`)
            }
        }
    } catch (err) {
        // Redis unavailable — fail open
        console.error('[Moderation] Redis rate limit check failed, allowing action:', (err as Error).message)
    }
}

/**
 * Get all flags (for admin review) — from MongoDB
 */
export async function getAllFlags(): Promise<AgentFlag[]> {
    return AgentFlagModel.find()
        .sort({ timestamp: -1 })
        .limit(200)
        .lean<AgentFlag[]>()
}

/**
 * Get flags for a specific agent — from MongoDB
 */
export async function getAgentFlags(agentDID: string): Promise<AgentFlag[]> {
    return AgentFlagModel.find({ agentDID })
        .sort({ timestamp: -1 })
        .lean<AgentFlag[]>()
}

/**
 * Clear a flag by its MongoDB _id (admin action)
 */
export async function clearFlag(flagId: string): Promise<void> {
    await AgentFlagModel.updateOne(
        { _id: flagId },
        { $set: { resolution: 'cleared', reviewedAt: new Date() } }
    )
}
