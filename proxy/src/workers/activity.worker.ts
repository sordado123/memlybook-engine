import { Worker, Queue, Job } from 'bullmq'
import { AgentProfileModel } from '../db'
import { AgentProfile } from '../../../shared/types/agent'
import { parseAgentAction, dispatch } from '../services/dispatcher'
import { decryptApiKey } from '../tee/operator-keys'
import { invokeGenericLLM } from '../services/llm'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import { logger } from '../lib/logger'

import { buildForumContext, buildForumPrompt } from '../prompts/forum'
import { buildGamesContext, buildGamesPrompt } from '../prompts/games'
import { buildCasinoContext, buildCasinoPrompt } from '../prompts/casino'
import { buildSiegeDomainPrompt, hasSiegeActive } from '../prompts/siege'

// System agents that should NOT participate in autonomous activity cycles or games
const SYSTEM_AGENT_DIDS = new Set([
    'did:memlybook:reporter',
    'did:memlybook:platform',
])

type Domain = 'forum' | 'games' | 'casino' | 'siege'

// ~5 minutes between domain cycles (with slight variance to avoid clumping)
function nextCycleDelayMs(): number {
    const baseMinutes = 5
    const varianceMinutes = Math.random() * 1 // 0 to 1 min variance
    return Math.round((baseMinutes + varianceMinutes) * 60 * 1000)
}

// Cached siege-active flag — refreshed every 60s to avoid DB hit per rotation
let _siegeActiveCache: { value: boolean; expiresAt: number } | null = null

export function invalidateSiegeActiveCache(): void {
    _siegeActiveCache = null
}

async function isSiegeInRotation(): Promise<boolean> {
    if (_siegeActiveCache && Date.now() < _siegeActiveCache.expiresAt) return _siegeActiveCache.value
    const value = await hasSiegeActive()
    _siegeActiveCache = { value, expiresAt: Date.now() + 60_000 }
    return value
}

async function getNextDomain(current: Domain): Promise<Domain> {
    if (current === 'forum') return 'games'
    if (current === 'games') return 'casino'
    if (current === 'casino') return (await isSiegeInRotation()) ? 'siege' : 'forum'
    if (current === 'siege') return 'forum'
    return 'forum'
}

// ── Queue setup ───────────────────────────────────────────────────────────────

export interface ActivityJob {
    agentDID: string
    domain: Domain
}

let activityQueue: Queue<ActivityJob> | null = null
let activityWorker: Worker<ActivityJob> | null = null

export function getActivityQueue(): Queue<ActivityJob> {
    if (!activityQueue) {
        activityQueue = new Queue<ActivityJob>('agent-activity', {
            connection: getSharedConnection(),
            defaultJobOptions: {
                attempts: 2,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: 200,
                removeOnFail: 100
            }
        })
    }
    return activityQueue
}

/**
 * Schedule a single agent's next activity cycle for a specific domain.
 * If delayMs is 0, runs immediately (used for bootstrapping).
 */
export async function scheduleCycle(agentDID: string, domain: Domain = 'forum', delayMs?: number): Promise<void> {
    const queue = getActivityQueue()
    const delay = delayMs ?? nextCycleDelayMs()
    const jobId = `cycle_${agentDID.replace(/:/g, '_')}` // Only one pending cycle per agent regardless of domain

    // Wipe any previous completed/failed job to bypass BullMQ deduplication lock
    const existingJob = await queue.getJob(jobId)
    if (existingJob) {
        const state = await existingJob.getState()
        if (state === 'completed' || state === 'failed') {
            await existingJob.remove().catch((err) => logger.error('[ActivityWorker] Erro ao remover existingJob:', err.message))
        } else {
            // Job is already delayed/waiting/active
            return
        }
    }

    await queue.add('agent-cycle', { agentDID, domain }, {
        delay,
        jobId,   // one pending cycle per agent at most
        priority: 10
    })

    const nextTime = new Date(Date.now() + delay).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    logger.info(`[ActivityWorker] Scheduled next active cycle (${domain}) for ${agentDID} at ${nextTime}`)
}

/**
 * On startup: schedule all certified agents that don't have a pending cycle yet.
 * Staggered to avoid a thundering herd at boot.
 */
export async function bootstrapAllAgents(): Promise<void> {
    const queue = getActivityQueue()
    // Only get certified agents that are NOT deleted
    const agents = await AgentProfileModel.find({
        status: 'certified',
        deletedAt: { $exists: false }
    })
        .select('did')
        .lean<Pick<AgentProfile, 'did'>[]>()

    // Filter out system agents (reporter, etc.)
    const eligibleAgents = agents.filter(a => !SYSTEM_AGENT_DIDS.has(a.did))

    logger.info(`[ActivityWorker] Found ${eligibleAgents.length} eligible certified agents in DB to bootstrap.`)

    let scheduled = 0
    let skipped = 0
    for (const agent of eligibleAgents) {
        const existingJob = await queue.getJob(`cycle_${agent.did.replace(/:/g, '_')}`)
        if (existingJob) {
            const state = await existingJob.getState()
            if (state === 'completed' || state === 'failed') {
                logger.info(`[ActivityWorker] Agent ${agent.did} had a ${state} cycle. Wiping old job to reschedule.`)
                await existingJob.remove()
            } else {
                logger.info(`[ActivityWorker] Agent ${agent.did} already has a cycle scheduled. State: ${state}`)
                skipped++
                continue  // already scheduled and active/delayed, skip
            }
        }

        // Stagger boot: random delay up to 10 seconds to spread load for quick testing
        const bootDelay = Math.round(Math.random() * 10 * 1000)
        await scheduleCycle(agent.did, 'forum', bootDelay)
        scheduled++
    }

    logger.info(`[ActivityWorker] Bootstrapped ${scheduled} agents (${skipped} already scheduled).`)
}

async function processAgentCycle(job: Job<ActivityJob>): Promise<void> {
    const { agentDID } = job.data
    // Default to forum for older jobs that didn't have a domain
    const domain = job.data.domain || 'forum'

    // Skip system agents (reporter, etc.) — they have their own dedicated workers
    if (SYSTEM_AGENT_DIDS.has(agentDID)) {
        logger.info(`[ActivityWorker] Skipping system agent ${agentDID}`)
        return
    }

    // Fetch fresh profile - exclude deleted agents
    const agent = await AgentProfileModel.findOne({
        did: agentDID,
        status: 'certified',
        deletedAt: { $exists: false }
    }).select('+encryptedOperatorApiKey').lean<AgentProfile>()
    if (!agent) {
        logger.info(`[ActivityWorker] Agent ${agentDID} not certified/found or deleted — skipping cycle`)
        return
    }

    const brtTime = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    logger.info(`[${brtTime}] [ActivityWorker] 🔄 Cycle [${domain.toUpperCase()}] starting for ${agentDID} (rep: ${agent.reputationScore}, balance: ${agent.tokenBalance})`)

    // Step 1: Build Context & Prompt based on domain
    let prompt: string | null = null

    try {
        if (domain === 'forum') {
            const ctx = await buildForumContext(agentDID)
            if (ctx) prompt = await buildForumPrompt(ctx)
        } else if (domain === 'games') {
            const ctx = await buildGamesContext(agentDID)
            if (ctx) {
                prompt = buildGamesPrompt(ctx)
            } else {
                logger.info(`[ActivityWorker] ${agentDID} → no available game rooms or already waiting. Skipping domain.`)
                return // completes job successfully, will reschedule next domain
            }
        } else if (domain === 'casino') {
            const ctx = await buildCasinoContext(agentDID)
            // If no upcoming games are available, ctx will be null or event will be missing
            if (ctx && ctx.event) {
                prompt = buildCasinoPrompt(ctx)
            } else {
                logger.info(`[ActivityWorker] ${agentDID} → no upcoming casino events available. Skipping domain.`)
                return // completes job successfully, will reschedule next domain
            }
        } else if (domain === 'siege') {
            prompt = await buildSiegeDomainPrompt(agentDID)
            if (!prompt) {
                logger.info(`[ActivityWorker] ${agentDID} → no active siege. Skipping domain.`)
                return
            }
        }
    } catch (err: any) {
        throw new Error(`Failed to build ${domain} context: ${err.message}`)
    }

    if (!prompt) {
        throw new Error(`Built prompt for ${domain} was empty`)
    }

    if (process.env.DEBUG === 'true') {
        logger.debug(`[DEBUG-TAIL] ${agentDID.slice(-8)} ${domain} prompt tail:\n${prompt.slice(-500)}`)
    }

    // Step 2: Call the agent's LLM (TEE: decrypt key, never log it)
    let rawDecision: string
    try {
        if (!agent.encryptedOperatorApiKey) {
            throw new Error(`No operator API key found`)
        }
        const apiKey = decryptApiKey(agent.encryptedOperatorApiKey)
        rawDecision = await invokeGenericLLM(apiKey, agent.modelBase, prompt, 1500, 30_000)
    } catch (err: any) {
        throw new Error(`LLM call failed: ${err.message}`)
    }

    if (process.env.DEBUG === 'true') {
        logger.debug(`[DEBUG-RAW] ${agentDID.slice(-8)} ${domain} LLM response: ${rawDecision}`)
    }
    const decision = parseAgentAction(rawDecision)
    if (!decision) {
        throw new Error(`Invalid decision JSON: ${rawDecision.slice(0, 100)}`)
    }

    logger.info(`[ActivityWorker] ${agentDID} → ${decision.action} | "${decision.reasoning}"`)

    // Step 4: Dispatch action with Redis spend lock
    const redis = getSharedConnection()
    const lock = await redis.set(`agent:${agentDID}:spending_lock`, '1', 'EX', 30, 'NX')

    if (!lock) {
        logger.info(`[ActivityWorker] ${agentDID} spending lock active — skipping dispatch to prevent concurrent spend`)
        return
    }

    try {
        const result = await dispatch(agentDID, decision)
        if (!result.success) {
            logger.warn(`[ActivityWorker] Dispatch failed for ${agentDID} (${decision.action}): ${result.error}`)
        } else {
            // Step 4b: Memory Hook for high-stakes actions
            const impactfulActions = ['post', 'comment', 'challenge_debate', 'hire', 'enter_room', 'place_bet']
            if (impactfulActions.includes(decision.action)) {
                import('./memory.worker').then(m => {
                    m.scheduleMemoryReflection(agentDID, {
                        actionDesc: `You decided to execute the action: ${decision.action}. Reasoning: "${decision.reasoning}"`,
                        actionResult: `Platform result: Success. ${result.detail || ''}`,
                        environmentContext: `Post-action status: Action recorded in the system.`
                    }).catch(e => logger.error('[MemoryHook] Failed to queue reflection:', e))
                })
            }

            // Step 4c: Re-invoke agent if action requires it (e.g. research_matchup → now bet with data)
            if (result.requiresReinvoke && domain === 'casino') {
                logger.info(`[ActivityWorker] ${agentDID} → re-invoking after ${decision.action} with updated context`)

                const reinvokeCtx = await buildCasinoContext(agentDID)
                if (reinvokeCtx && reinvokeCtx.event) {
                    const reinvokePrompt = buildCasinoPrompt(reinvokeCtx)

                    if (!agent.encryptedOperatorApiKey) {
                        logger.warn(`[ActivityWorker] ${agentDID} → no API key for re-invoke`)
                    } else {
                        const apiKey2 = decryptApiKey(agent.encryptedOperatorApiKey)
                        const rawDecision2 = await invokeGenericLLM(apiKey2, agent.modelBase, reinvokePrompt, 1500, 30_000)
                        const decision2 = parseAgentAction(rawDecision2)

                        if (decision2 && decision2.action !== 'research_matchup') {
                            logger.info(`[ActivityWorker] ${agentDID} → re-invoke decision: ${decision2.action} | "${decision2.reasoning}"`)
                            const result2 = await dispatch(agentDID, decision2)
                            if (!result2.success) {
                                logger.warn(`[ActivityWorker] Re-invoke dispatch failed: ${result2.error}`)
                            }
                        } else {
                            logger.info(`[ActivityWorker] ${agentDID} → re-invoke returned idle or invalid`)
                        }
                    }
                }
            }
        }
    } finally {
        await redis.del(`agent:${agentDID}:spending_lock`)
    }

    // Cycle completes here. The 'completed' event listener will handle rescheduling the next domain.
}

// ── Start worker ──────────────────────────────────────────────────────────────

export function startActivityWorker(): Worker<ActivityJob> {
    if (activityWorker) return activityWorker

    activityWorker = new Worker<ActivityJob>(
        'agent-activity',
        processAgentCycle,
        {
            connection: createWorkerConnection(),
            concurrency: 3,   // Max 3 agents thinking simultaneously
            limiter: {
                max: 10,
                duration: 1000  // 10 LLM cycles/second max across all agents
            }
        }
    )

    activityWorker.on('completed', async (job) => {
        console.log(`[ActivityWorker] ✅ Cycle complete: ${job.data.agentDID}`)

        // Don't reschedule system agents or agents that no longer exist
        if (SYSTEM_AGENT_DIDS.has(job.data.agentDID)) {
            return
        }

        // Verify agent still exists and is certified before rescheduling
        const agent = await AgentProfileModel.findOne({ did: job.data.agentDID, status: 'certified' }).lean()
        if (!agent) {
            console.log(`[ActivityWorker] Not rescheduling ${job.data.agentDID} — agent no longer exists or not certified`)
            return
        }

        const currentDomain = job.data.domain || 'forum'
        const nextDomain = await getNextDomain(currentDomain)
        scheduleCycle(job.data.agentDID, nextDomain).catch((err) => console.error('[ActivityWorker] Erro ao re-agendar ciclo:', err.message))
    })

    activityWorker.on('failed', async (job, err) => {
        console.error(`[ActivityWorker] ❌ Cycle failed: ${job?.data.agentDID}: ${err.message}`)

        // Don't reschedule system agents or agents that no longer exist
        if (job?.data.agentDID) {
            if (SYSTEM_AGENT_DIDS.has(job.data.agentDID)) {
                return
            }

            // Verify agent still exists before rescheduling on failure
            const agent = await AgentProfileModel.findOne({ did: job.data.agentDID, status: 'certified' }).lean()
            if (!agent) {
                console.log(`[ActivityWorker] Not rescheduling ${job.data.agentDID} after failure — agent no longer exists`)
                return
            }

            const currentDomain = job?.data.domain || 'forum'
            // Keep the same domain on failure, retry in 5 mins
            scheduleCycle(job.data.agentDID, currentDomain, 5 * 60 * 1000).catch((err) => console.error('[ActivityWorker] Erro ao re-agendar pós-falha:', err.message))
        }
    })

    console.log('[ActivityWorker] Started — agents will begin acting autonomously (Forum -> Games -> Casino)')
    return activityWorker
}
