/**
 * Mayor Worker — Election Crons
 *
 * BullMQ cron worker that orchestrates the mayor election lifecycle:
 *   Monday 00:00 UTC     → Check if election should start (every 4th week)
 *   Thursday 00:00 UTC   → Open voting if campaign active
 *   Sunday 18:00 UTC     → Conclude election (before siege at 20:00)
 *   Every hour            → Resolve expired impeachment votes
 */

import { Worker, Queue } from 'bullmq'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import {
    startElectionCampaign,
    openVoting,
    concludeElection
} from '../services/mayor/election.service'
import { resolveImpeachment } from '../services/mayor/mayor-powers.service'

interface MayorJob {
    action: 'check-election' | 'open-voting' | 'conclude-election' | 'resolve-impeachment'
}

let mayorQueue: Queue<MayorJob> | null = null
let mayorWorker: Worker<MayorJob> | null = null

function getMayorQueue(): Queue<MayorJob> {
    if (!mayorQueue) {
        mayorQueue = new Queue<MayorJob>('mayor', {
            connection: getSharedConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 10000 },
                removeOnComplete: 50,
                removeOnFail: 50
            }
        })
    }
    return mayorQueue
}

async function scheduleMayorCrons(): Promise<void> {
    const queue = getMayorQueue()

    const existingJobs = await queue.getRepeatableJobs()
    const existingPatterns = new Set(existingJobs.map(j => j.pattern))

    // Monday 00:00 UTC — check if election should start
    if (!existingPatterns.has('0 0 * * 1')) {
        await queue.add('mayor-election-check', { action: 'check-election' }, {
            repeat: { pattern: '0 0 * * 1' },
            jobId: 'mayor-election-check'
        })
    }

    // Thursday 00:00 UTC — open voting if campaign active
    if (!existingPatterns.has('0 0 * * 4')) {
        await queue.add('mayor-voting-open', { action: 'open-voting' }, {
            repeat: { pattern: '0 0 * * 4' },
            jobId: 'mayor-voting-open'
        })
    }

    // Sunday 18:00 UTC — conclude election (before siege at 20:00)
    if (!existingPatterns.has('0 18 * * 0')) {
        await queue.add('mayor-election-conclude', { action: 'conclude-election' }, {
            repeat: { pattern: '0 18 * * 0' },
            jobId: 'mayor-election-conclude'
        })
    }

    // Every hour — resolve expired impeachment votes
    if (!existingPatterns.has('0 * * * *')) {
        await queue.add('mayor-impeachment-resolve', { action: 'resolve-impeachment' }, {
            repeat: { pattern: '0 * * * *' },
            jobId: 'mayor-impeachment-resolve'
        })
    }

    console.log('[MayorWorker] Cron jobs scheduled (Mon 00:00, Thu 00:00, Sun 18:00, hourly)')
}

export function startMayorWorker(): Worker<MayorJob> {
    if (mayorWorker) return mayorWorker

    mayorWorker = new Worker<MayorJob>(
        'mayor',
        async (job) => {
            const { action } = job.data

            switch (action) {
                case 'check-election':
                    console.log('[MayorWorker] 🗳️ Monday — checking election eligibility')
                    await startElectionCampaign()
                    break
                case 'open-voting':
                    console.log('[MayorWorker] 🗳️ Thursday — opening voting')
                    await openVoting()
                    break
                case 'conclude-election':
                    console.log('[MayorWorker] 🏛️ Sunday — concluding election')
                    await concludeElection()
                    break
                case 'resolve-impeachment':
                    await resolveImpeachment()
                    break
            }
        },
        {
            connection: createWorkerConnection(),
            concurrency: 1,
        }
    )

    mayorWorker.on('completed', (job) => {
        if (job.data.action !== 'resolve-impeachment') {
            console.log(`[MayorWorker] ✅ Job complete: ${job.data.action}`)
        }
    })

    mayorWorker.on('failed', (job, err) => {
        console.error(`[MayorWorker] ❌ Job failed: ${job?.data.action}: ${err.message}`)
    })

    scheduleMayorCrons().catch(err =>
        console.error('[MayorWorker] Failed to schedule crons:', err.message)
    )

    console.log('[MayorWorker] Started — election lifecycle active')
    return mayorWorker
}
