/**
 * Negotiation Worker — auto-runs active match rounds
 */

import { Worker, Queue, Job } from 'bullmq'
import { NegotiationMatchModel } from '../db'
import { executeRound } from '../services/games/negotiation.service'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import { clearDuplicateRepeatableJobs } from '../services/queue'

const ROUND_INTERVAL_MS = 5 * 60 * 1000  // 5 minutes between rounds

export let negotiationQueue: Queue | null = null
export let negotiationWorker: Worker | null = null

export function startNegotiationWorker(): Worker {
    if (negotiationWorker) return negotiationWorker

    const queue = new Queue('negotiation', {
        connection: getSharedConnection(),
        defaultJobOptions: {
            attempts: 2,
            backoff: { type: 'fixed', delay: 10_000 },
            removeOnComplete: 10,
            removeOnFail: 5
        }
    })
    negotiationQueue = queue

    negotiationWorker = new Worker(
        'negotiation',
        async (job: Job) => {
            if (job.name === 'negotiation-tick') {
                await runNegotiationTick()
            }
        },
        { connection: createWorkerConnection(), concurrency: 1 }
    )

    negotiationWorker.on('failed', (job, err) => {
        console.error(`[Negotiation Worker] Job failed: ${err.message}`)
    })

    clearDuplicateRepeatableJobs(queue).then(() => {
        queue.add('negotiation-tick', {}, {
            repeat: { every: 60 * 1000 }, // Check every minute
            jobId: 'negotiation-tick-repeat'
        }).catch((err) => console.error('[Negotiation Worker] Failed to add tick repeat:', err.message))
    })

    console.log('[Negotiation Worker] Started. Checks every 60s, 5min between rounds.')
    return negotiationWorker
}

async function runNegotiationTick() {
    try {
        const activeMatches = await NegotiationMatchModel.find({ status: 'active' }).lean()

        if (activeMatches.length === 0) return

        const now = new Date()
        const brt = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        console.log(`[Negotiation Worker] [${brt}] Processing ${activeMatches.length} active matches...`)

        for (const match of activeMatches) {
            try {
                // Check if enough time has passed since last round
                const lastRound = match.rounds[match.rounds.length - 1]
                if (lastRound) {
                    const timeSinceLastRound = Date.now() - new Date(lastRound.timestamp).getTime()
                    if (timeSinceLastRound < ROUND_INTERVAL_MS) continue
                }

                await executeRound(match.id)
            } catch (err) {
                console.error(`[Negotiation Worker] Error processing match ${match.id}:`, (err as Error).message)
            }
        }
    } catch (err) {
        console.error('[Negotiation Worker] Error:', (err as Error).message)
    }
}
