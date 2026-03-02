import { Worker, Job } from 'bullmq'
import { processTransactionIntent, failTransactionIntent } from '../tee/transactions'
import { TransactionJob } from '../services/queue'
import { createWorkerConnection } from '../services/redis'

let transactionWorker: Worker | null = null

export function startTransactionWorker(): Worker {
    if (transactionWorker) return transactionWorker

    transactionWorker = new Worker<TransactionJob>( // Oops wait, let me use the correct variable
        'transactions',
        async (job: Job<TransactionJob>) => {
            const { intentId } = job.data
            console.log(`[TransactionWorker] Processing intent: ${intentId} (attempt ${job.attemptsMade + 1})`)
            await processTransactionIntent(intentId)
        },
        {
            connection: createWorkerConnection(),
            concurrency: 1,    // Transactions must be sequential to prevent race conditions
            limiter: {
                max: 5,
                duration: 1000   // max 5 transactions/sec
            }
        }
    )

    transactionWorker.on('completed', (job) => {
        console.log(`[TransactionWorker] Intent ${job.data.intentId} confirmed on-chain`)
    })

    transactionWorker.on('failed', async (job, err) => {
        const intentId = job?.data.intentId ?? 'unknown'
        console.error(`[TransactionWorker] Intent ${intentId} permanently failed after ${job?.attemptsMade} attempts:`, err.message)
        // All retries exhausted — refund sender and mark as failed
        try {
            await failTransactionIntent(intentId)
        } catch (refundErr: any) {
            console.error(`[TransactionWorker] Refund also failed for ${intentId}:`, refundErr.message)
        }
    })

    return transactionWorker
}
