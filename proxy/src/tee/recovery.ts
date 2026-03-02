import { TransactionModel } from '../db'
import { scheduleTransaction } from '../services/queue'

/**
 * Recovery System for Pending Transactions
 * 
 * This function runs on server startup to handle orphaned pending transactions
 * that may have been left behind due to server crashes or restarts.
 * 
 * Two scenarios:
 * 1. Individual transactions (no batchKey): Re-enqueue to BullMQ if not already queued
 * 2. Batch transactions (has batchKey): Process individually since in-memory buffer was lost
 */
export async function recoverPendingTransactions(): Promise<void> {
    console.log('[Recovery] Checking for orphaned pending transactions...')

    try {
        // Find all pending transactions
        const pendingTxs = await TransactionModel.find({ status: 'pending' }).lean()

        if (pendingTxs.length === 0) {
            console.log('[Recovery] No pending transactions found. System clean.')
            return
        }

        console.log(`[Recovery] Found ${pendingTxs.length} pending transaction(s)`)

        let requeued = 0
        let batchRecovered = 0
        let errors = 0

        for (const tx of pendingTxs) {
            try {
                const age = Date.now() - new Date(tx.createdAt).getTime()
                const ageMinutes = Math.floor(age / 60000)

                // Log old transactions (potential stuck ones)
                if (ageMinutes > 10) {
                    console.warn(`[Recovery] ⚠️  Old pending TX: ${tx.id.slice(0, 8)} (${ageMinutes}min old, ${tx.reason})`)
                }

                // Re-enqueue to ensure it gets processed
                // BullMQ will deduplicate if already queued
                await scheduleTransaction(tx.id)

                if (tx.batchKey) {
                    batchRecovered++
                    console.log(`[Recovery] ✓ Recovered batch TX: ${tx.id.slice(0, 8)} (was in batch '${tx.batchKey}')`)
                } else {
                    requeued++
                    console.log(`[Recovery] ✓ Re-enqueued TX: ${tx.id.slice(0, 8)} (${tx.reason})`)
                }
            } catch (err: any) {
                errors++
                console.error(`[Recovery] ✗ Failed to recover TX ${tx.id.slice(0, 8)}: ${err.message}`)
            }
        }

        console.log('[Recovery] Summary:')
        console.log(`  Re-enqueued: ${requeued}`)
        console.log(`  Batch recovered: ${batchRecovered}`)
        console.log(`  Errors: ${errors}`)
        console.log(`  Total processed: ${requeued + batchRecovered}`)

    } catch (err: any) {
        console.error('[Recovery] Failed to recover pending transactions:', err.message)
        throw err
    }
}

/**
 * Cleanup old failed transactions (optional housekeeping)
 * Can be called periodically to clean up failed TXs older than 7 days
 */
export async function cleanupOldFailedTransactions(daysOld: number = 7): Promise<number> {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000)
    
    const result = await TransactionModel.deleteMany({
        status: 'failed',
        createdAt: { $lt: cutoff }
    })

    console.log(`[Cleanup] Removed ${result.deletedCount} failed transactions older than ${daysOld} days`)
    return result.deletedCount
}
