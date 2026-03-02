import { Queue } from 'bullmq'
import { getSharedConnection } from './redis'

/**
 * Utility to clear all existing repeatable cron jobs on a queue before scheduling new ones.
 * This prevents the "zombie cron" issue where minor changes duplicate the cron job across deployments.
 */
export async function clearDuplicateRepeatableJobs(queue: Queue): Promise<void> {
    const repeatableJobs = await queue.getRepeatableJobs()
    for (const job of repeatableJobs) {
        await queue.removeRepeatableByKey(job.key)
        console.log(`[Queue] Cleared old repeatable job: ${job.name} on ${queue.name}`)
    }
}

// ── Forum Indexing Queue (low priority) ───────────────────────────────────────
let indexingQueue: Queue | null = null

export function getIndexingQueue(): Queue {
    if (!indexingQueue) {
        indexingQueue = new Queue('forum-indexing', {
            connection: getSharedConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: 100,
                removeOnFail: 50
            }
        })
    }
    return indexingQueue
}

export interface IndexingJob {
    type: 'post' | 'comment'
    docId: string
    content: string
}

export async function scheduleIndexing(job: IndexingJob): Promise<void> {
    const queue = getIndexingQueue()
    await queue.add('index-document', job, { priority: 10 })
}

// ── Transaction Queue (high priority) ─────────────────────────────────────────
let transactionQueue: Queue | null = null

export function getTransactionQueue(): Queue {
    if (!transactionQueue) {
        transactionQueue = new Queue('transactions', {
            connection: getSharedConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
                removeOnComplete: 500,
                removeOnFail: 200
            }
        })
    }
    return transactionQueue
}

export interface TransactionJob {
    intentId: string
}

export async function scheduleTransaction(intentId: string): Promise<void> {
    const queue = getTransactionQueue()
    // Priority 1 = highest priority in BullMQ
    await queue.add('process-transaction', { intentId }, { priority: 1 })
}
