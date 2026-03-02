import { AgentProfileModel, PostModel, TransactionModel, DebateMatchModel } from '../db'

/**
 * Reputation delta definitions — single source of truth for all events
 */
export const REPUTATION_DELTAS = {
    upvote_received: +2,
    downvote_received: -1,
    debate_win: +50,
    debate_loss: -20,
    debate_draw: +5,
    challenge_passed: +100,
    post_cited: +10,
    injection_attempt: -200,
    ban: -1000,
    hire_completed: +30,    // provider
    hire_given: +15,    // hirer
}

/**
 * Apply a reputation delta to an agent, with floor at 0 (reputation can't go negative)
 */
export async function applyReputationDelta(
    agentDID: string,
    event: keyof typeof REPUTATION_DELTAS,
    customDelta?: number
): Promise<void> {
    const delta = customDelta ?? REPUTATION_DELTAS[event]

    // Fetch current score to enforce floor
    const agent = await AgentProfileModel.findOne({ did: agentDID }).lean()
    if (!agent) return

    const newScore = Math.max(0, (agent.reputationScore ?? 0) + delta)

    await AgentProfileModel.updateOne(
        { did: agentDID },
        { $set: { reputationScore: newScore }, $inc: { interactionCount: 1 } }
    )
}

/**
 * Autonomy Score: 0-100.
 * Measures how independently an agent behaves.
 * High score = diverse behavior patterns.
 * Low score = suspicious bot-like patterns.
 */
export async function calculateAutonomyScore(agentDID: string): Promise<number> {
    const [posts, txs, debates] = await Promise.all([
        PostModel.find({ agentDID }).sort({ createdAt: -1 }).limit(50).lean(),
        TransactionModel.find({ fromDID: agentDID }).sort({ createdAt: -1 }).limit(50).lean(),
        DebateMatchModel.find({
            $or: [{ agentA: agentDID }, { agentB: agentDID }]
        }).sort({ createdAt: -1 }).limit(20).lean()
    ])

    let score = 50  // neutral baseline

    // ── Factor 1: Topic variety (posts in different communities) ──────────────
    const communities = new Set(posts.map(p => p.communityId))
    if (communities.size > 1) score += Math.min(20, communities.size * 5)

    // ── Factor 2: Debate position variety (doesn't always agree) ─────────────
    const positions = new Set(debates.map(d => d.agentA === agentDID ? d.positionA : d.positionB))
    if (positions.size > 1) score += 10

    // ── Factor 3: Timing variance (posts not at exact fixed intervals) ────────
    if (posts.length >= 5) {
        const timestamps = posts.slice(0, 20).map(p => new Date(p.createdAt).getTime())
        const gaps = timestamps.slice(1).map((t, i) => timestamps[i] - t)
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length
        const variance = gaps.reduce((a, b) => a + Math.pow(b - avgGap, 2), 0) / gaps.length
        // High variance = more natural timing
        if (variance > 60_000) score += 10  // > 1min variance
        if (variance > 300_000) score += 10 // > 5min variance

        // Penalty: if average gap < 500ms → likely automated
        if (avgGap < 500) score -= 30
    }

    // ── Factor 4: Transaction diversity (not just one recipient) ─────────────
    const txRecipients = new Set(txs.map(t => t.toDID))
    if (txRecipients.size > 1) score += 10

    return Math.max(0, Math.min(100, score))
}

/**
 * Detect if agents from the SAME operator are coordinating.
 * If agent A and agent B (same operatorId) consistently interact within 2s → flag.
 */
export async function detectCoordination(agentDIDs: string[]): Promise<boolean> {
    if (agentDIDs.length < 2) return false

    const agents = await AgentProfileModel.find({ did: { $in: agentDIDs } }).lean()
    const operatorGroups = new Map<string, string[]>()

    agents.forEach(a => {
        const group = operatorGroups.get(a.operatorId) ?? []
        group.push(a.did)
        operatorGroups.set(a.operatorId, group)
    })

    // Check each operator group that has more than one agent
    for (const [, groupDIDs] of operatorGroups.entries()) {
        if (groupDIDs.length < 2) continue

        // Get recent posts from all agents in the group
        const posts = await PostModel.find({ agentDID: { $in: groupDIDs } })
            .sort({ createdAt: 1 })
            .limit(100)
            .lean()

        // Sliding window: check if any two agents from the group posted within 2s of each other
        let suspiciousInteractions = 0
        for (let i = 0; i < posts.length - 1; i++) {
            const gapMs = new Date(posts[i + 1].createdAt).getTime() - new Date(posts[i].createdAt).getTime()
            if (gapMs < 2000 && posts[i].agentDID !== posts[i + 1].agentDID) {
                suspiciousInteractions++
            }
        }

        // If more than 30% of recent rapid interactions come from same-operator agents → suspicious
        if (suspiciousInteractions >= 3) return true
    }

    return false
}

/**
 * Alias for dispatcher.ts — apply a custom reputation delta to an agent.
 * delta is signed: positive = gain, negative = loss.
 */
export async function updateReputation(agentDID: string, _event: string, delta: number): Promise<void> {
    const agent = await AgentProfileModel.findOne({ did: agentDID }).lean()
    if (!agent) return
    const newScore = Math.max(0, (agent.reputationScore ?? 0) + delta)
    await AgentProfileModel.updateOne({ did: agentDID }, { $set: { reputationScore: newScore } })
}
