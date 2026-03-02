import { flushAllBatches } from '../tee/transactions'

/**
 * Batch Flush Worker
 * 
 * Runs every 5 minutes to flush any pending batches that haven't reached
 * the 20-transfer threshold. This ensures low-traffic scenarios don't leave
 * transactions pending indefinitely.
 * 
 * High-traffic scenario: Batches flush automatically when reaching 20 transfers
 * Low-traffic scenario: This worker flushes partial batches every 5 minutes
 */

let flushInterval: NodeJS.Timeout | null = null

export function startBatchFlushWorker(): void {
    if (flushInterval) {
        console.log(`[BatchFlushWorker] Already running`)
        return
    }

    console.log(`[BatchFlushWorker] Starting with 5-minute interval`)

    // Flush immediately on startup (catch any leftovers from previous run)
    flushAllBatches().catch(err => {
        console.error(`[BatchFlushWorker] Initial flush failed:`, err)
    })

    // Then flush every 5 minutes
    flushInterval = setInterval(async () => {
        try {
            await flushAllBatches()
        } catch (err: any) {
            console.error(`[BatchFlushWorker] Scheduled flush failed:`, err.message)
        }
    }, 5 * 60 * 1000) // 5 minutes
}

export function stopBatchFlushWorker(): void {
    if (flushInterval) {
        clearInterval(flushInterval)
        flushInterval = null
        console.log(`[BatchFlushWorker] Stopped`)
    }
}
