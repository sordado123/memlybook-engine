import { Worker, Job, Queue } from 'bullmq'
import { executeRound, openVoting, finalizeMatch } from '../services/debate'
import { DebateMatchModel } from '../db'
import { getSharedConnection, createWorkerConnection } from '../services/redis'

export interface DebateJob {
    matchId: string
    action: 'run_round' | 'open_voting' | 'finalize'
}

let debateQueue: Queue | null = null
let debateWorker: Worker | null = null

export function getDebateQueue(): Queue {
    if (!debateQueue) {
        debateQueue = new Queue<DebateJob>('debates', {
            connection: getSharedConnection(),
            defaultJobOptions: {
                attempts: 2,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: 100,
                removeOnFail: 50
            }
        })
    }
    return debateQueue
}

/**
 * Schedule the next debate action with a delay.
 * This is how we orchestra multi-round debates asynchronously.
 */
export async function scheduleDebateAction(matchId: string, action: DebateJob['action'], delayMs: number = 0): Promise<void> {
    const queue = getDebateQueue()
    await queue.add('debate-action', { matchId, action }, {
        delay: delayMs,
        priority: 5
    })
}

export function startDebateWorker(): Worker {
    if (debateWorker) return debateWorker

    debateWorker = new Worker<DebateJob>(
        'debates',
        async (job: Job<DebateJob>) => {
            const { matchId, action } = job.data
            console.log(`[DebateWorker] ${action} for match ${matchId}`)

            if (action === 'run_round') {
                const match = await DebateMatchModel.findOne({ id: matchId }).lean()
                if (!match || match.status !== 'active') {
                    console.log(`[DebateWorker] Match ${matchId} not active, skipping round`)
                    return
                }

                await executeRound(matchId)

                // Refetch to get updated rounds count
                const updated = await DebateMatchModel.findOne({ id: matchId }).lean()
                if (!updated) return

                if (updated.rounds.length >= updated.maxRounds) {
                    // All rounds done — open voting with a small delay for drama
                    await scheduleDebateAction(matchId, 'open_voting', 5_000)
                } else {
                    // Schedule next round: 60 seconds between rounds
                    await scheduleDebateAction(matchId, 'run_round', 60_000)
                }

            } else if (action === 'open_voting') {
                await openVoting(matchId)
                // Schedule finalization after 5 minutes voting window
                await scheduleDebateAction(matchId, 'finalize', 5 * 60 * 1000)

            } else if (action === 'finalize') {
                await finalizeMatch(matchId)
            }
        },
        {
            connection: createWorkerConnection(),
            concurrency: 5      // Debates are independent, can process multiple concurrently
        }
    )

    debateWorker.on('completed', (job) => {
        console.log(`[DebateWorker] Job completed: ${job.data.action} for match ${job.data.matchId}`)
    })

    debateWorker.on('failed', (job, err) => {
        console.error(`[DebateWorker] Job failed: ${job?.data.action} for match ${job?.data.matchId}:`, err.message)
    })

    return debateWorker
}
