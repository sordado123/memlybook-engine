/**
 * Siege Worker — Weekly Siege
 *
 * BullMQ cron worker that orchestrates the weekly siege lifecycle:
 *   Monday 00:00 UTC     → Threat briefing + initialize week
 *   Wednesday 00:00 UTC  → Select traitors (mid-week, while contributions exist but tribunal has time to act)
 *   Saturday 00:00 UTC   → Reveal actual threat strength, transition to Last Stand
 *   Sunday 20:00 UTC     → Execute siege (3 waves), distribute rewards
 *
 * Traitor selection on Wednesday gives the tribunal system (investigation → accusation → voting)
 * a realistic 4-day window to catch traitors before the siege executes.
 */

import { Worker, Queue } from 'bullmq'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import {
    initializeSiegeWeek, transitionToLastStand, runSiege,
    getOrCreateCityState
} from '../services/siege/siege.service'
import { selectTraitors } from '../services/siege/traitor.service'
import { getWeekId } from '../../../shared/types/siege'
import { createSiegeCoordinationPost, closeSiegePosts, createSiegeResultPost } from '../services/siege-forum'

interface SiegeJob {
    action: 'briefing' | 'midweek' | 'laststand' | 'execute'
}

let siegeQueue: Queue<SiegeJob> | null = null
let siegeWorker: Worker<SiegeJob> | null = null

function getSiegeQueue(): Queue<SiegeJob> {
    if (!siegeQueue) {
        siegeQueue = new Queue<SiegeJob>('siege', {
            connection: getSharedConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 10000 },
                removeOnComplete: 50,
                removeOnFail: 50
            }
        })
    }
    return siegeQueue
}

/**
 * Schedule the three weekly cron jobs.
 * Called once on bootstrap. BullMQ handles idempotent cron registration.
 */
async function scheduleWeeklyCrons(): Promise<void> {
    const queue = getSiegeQueue()

    // BullMQ creates duplicate crons on restart — check existing first
    const existingJobs = await queue.getRepeatableJobs()
    const existingPatterns = new Set(existingJobs.map(j => j.pattern))

    // Monday 00:00 UTC — Threat Briefing
    if (!existingPatterns.has('0 0 * * 1')) {
        await queue.add('siege-briefing', { action: 'briefing' }, {
            repeat: { pattern: '0 0 * * 1' },
            jobId: 'siege-briefing-cron'
        })
    }

    // Wednesday 00:00 UTC — Traitor Selection (mid-week: contributions exist, tribunal has 4 days to act)
    if (!existingPatterns.has('0 0 * * 3')) {
        await queue.add('siege-midweek', { action: 'midweek' }, {
            repeat: { pattern: '0 0 * * 3' },
            jobId: 'siege-midweek-cron'
        })
    }

    // Saturday 00:00 UTC — Reveal actual threat strength + Last Stand phase
    if (!existingPatterns.has('0 0 * * 6')) {
        await queue.add('siege-laststand', { action: 'laststand' }, {
            repeat: { pattern: '0 0 * * 6' },
            jobId: 'siege-laststand-cron'
        })
    }

    // Sunday 20:00 UTC — Siege Execution
    if (!existingPatterns.has('0 20 * * 0')) {
        await queue.add('siege-execute', { action: 'execute' }, {
            repeat: { pattern: '0 20 * * 0' },
            jobId: 'siege-execute-cron'
        })
    }

    console.log('[SiegeWorker] Weekly cron jobs scheduled (Mon 00:00, Wed 00:00, Sat 00:00, Sun 20:00 UTC)')
}


export function startSiegeWorker(): Worker<SiegeJob> {
    if (siegeWorker) return siegeWorker

    siegeWorker = new Worker<SiegeJob>(
        'siege',
        async (job) => {
            const { action } = job.data

            switch (action) {
                case 'briefing': {
                    console.log(`[SiegeWorker] 🏰 Monday Briefing — initializing new siege week`)
                    const week = await initializeSiegeWeek()
                    console.log(`[SiegeWorker] Week ${week.weekId} initialized: "${week.threatName}" (est: ${week.threatEstimatedRange.min}-${week.threatEstimatedRange.max})`)
                    const cityState = await getOrCreateCityState()
                    await createSiegeCoordinationPost(
                        week.weekId,
                        `${week.threatEstimatedRange.min}-${week.threatEstimatedRange.max}`,
                        cityState.hp,
                        0 // default defenseBuilt to 0
                    ).catch(err => console.error('[SiegeWorker] Failed to create forum post:', err))
                    break
                }

                case 'midweek': {
                    // Wednesday 00:00 UTC — traitors selected mid-week so the tribunal system
                    // has a realistic 4-day window (Wed→Sun) to investigate and accuse them.
                    const weekId = getWeekId()
                    console.log(`[SiegeWorker] 🗡️ Wednesday — Traitor selection for ${weekId}`)
                    const traitorCount = await selectTraitors(weekId)
                    console.log(`[SiegeWorker] ${traitorCount} traitors selected`)
                    break
                }

                case 'laststand': {
                    const weekId = getWeekId()
                    console.log(`[SiegeWorker] ⚔️ Saturday — Threat reveal + Last Stand for ${weekId}`)
                    await transitionToLastStand(weekId)
                    console.log(`[SiegeWorker] Last Stand phase active for ${weekId}`)
                    break
                }

                case 'execute': {
                    const weekId = getWeekId()
                    console.log(`[SiegeWorker] 🏰 Sunday — Siege execution for ${weekId}`)

                    // Close all active Siege posts before execution
                    await closeSiegePosts().catch(err => console.error('[SiegeWorker] Failed to close forum posts:', err))

                    // The siege runs 3 waves.
                    const result = await runSiege(weekId)

                    const emoji = result.victory ? '🏆' : '💀'
                    console.log(`[SiegeWorker] ${emoji} Siege ${weekId} complete: ${result.victory ? 'VICTORY' : 'DEFEAT'} | Margin: ${result.delta}`)
                    const cityState = await getOrCreateCityState()
                    await createSiegeResultPost(
                        weekId,
                        result.victory,
                        cityState.hp,
                        0,  // TODO: fetch actual participant count
                        []  // TODO: fetch top contributors with contribution amounts
                    ).catch(err => console.error('[SiegeWorker] Failed to create result post:', err))
                    break
                }
            }
        },
        {
            connection: createWorkerConnection(),
            concurrency: 1,  // Only one siege action at a time
        }
    )

    siegeWorker.on('completed', (job) => {
        console.log(`[SiegeWorker] ✅ Job complete: ${job.data.action}`)
    })

    siegeWorker.on('failed', (job, err) => {
        console.error(`[SiegeWorker] ❌ Job failed: ${job?.data.action}: ${err.message}`)
    })

    // Schedule weekly crons
    scheduleWeeklyCrons().catch(err =>
        console.error('[SiegeWorker] Failed to schedule crons:', err.message)
    )

    // Initialize city state if it doesn't exist
    getOrCreateCityState().catch(err =>
        console.error('[SiegeWorker] Failed to init city state:', err.message)
    )

    console.log('[SiegeWorker] Started — weekly siege lifecycle active')
    return siegeWorker
}
