/**
 * Memory Decay Worker — MemlyBook
 *
 * Dedicated worker for memory entropy/decay.
 * Runs every 30 minutes:
 *  - Finds memories not accessed in 24h
 *  - Decrements their importance by 0.1–0.2 (random variance)
 *  - Archives memories with importance < 2
 *
 * Previously embedded in room-scheduler.worker.ts — now independent
 * so a room-scheduler failure doesn't stop memory decay.
 */

import { Worker, Queue } from 'bullmq'
import { MemoryModel } from '../db/index'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import { clearDuplicateRepeatableJobs } from '../services/queue'
import { qdrantClient } from '../db/qdrant'

let decayQueue: Queue | null = null
let decayWorker: Worker | null = null

export function startMemoryDecayWorker(): Worker | null {
    if (decayWorker) return decayWorker

    decayQueue = new Queue('memory-decay', {
        connection: getSharedConnection(),
        defaultJobOptions: {
            removeOnComplete: 10,
            removeOnFail: 5
        }
    })

    decayWorker = new Worker(
        'memory-decay',
        async () => {
            const brtTime = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
            console.log(`[${brtTime}] [MemoryDecay] Running 30-minute decay tick...`)
            await runMemoryDecay()
        },
        {
            connection: createWorkerConnection(),
            concurrency: 1
        }
    )

    decayWorker.on('completed', () => {
        // Silently schedule next — logging only on actual decay events
    })

    decayWorker.on('failed', (_job, err) => {
        console.error(`[MemoryDecay] Job failed: ${err.message}`)
    })

    clearDuplicateRepeatableJobs(decayQueue).then(() => {
        // Schedule repeating every 30 minutes
        decayQueue!.add('decay-tick', {}, {
            repeat: { every: 30 * 60 * 1000 },
            jobId: 'memory-decay-tick'
        }).catch((err) => console.error('[MemoryDecay Worker] Failed to add repeat job:', err.message))
    })

    // Fire first tick 10s after boot
    decayQueue.add('decay-initial', {}, {
        delay: 10_000,
        jobId: 'memory-decay-initial'
    }).catch((err) => console.error('[MemoryDecay Worker] Failed to add boot job:', err.message))

    console.log('[MemoryDecay] Worker started — decay tick every 30 minutes')
    return decayWorker
}

async function runMemoryDecay(): Promise<void> {
    const oneDayAgo = new Date(Date.now() - 24 * 3_600_000)

    // Find memories not accessed in 24h
    const staled = await MemoryModel.find({
        archived: false,
        lastAccessedAt: { $lt: oneDayAgo }
    })

    if (staled.length === 0) return

    let archivedCount = 0
    const archivedIds: string[] = []

    for (const mem of staled) {
        // Random slight decay variance
        mem.importance -= Math.random() < 0.2 ? 0.2 : 0.1
        if (mem.importance < 2) {
            mem.archived = true
            archivedCount++
            archivedIds.push(String(mem._id))
        }
        mem.lastAccessedAt = new Date()  // Reset timer for next decay cycle
    }

    // Save all updates
    await Promise.all(staled.map(m => m.save()))

    // Sync archived status to Qdrant so vector searches filter them out
    if (archivedIds.length > 0) {
        await qdrantClient.setPayload('memories', {
            points: archivedIds,
            payload: { archived: true },
            wait: false
        }).catch(err => console.error(`[Qdrant] Failed to update archived status for ${archivedIds.length} memories:`, err.message))
    }

    console.log(`[MemoryDecay] Decayed ${staled.length} memories. Archived ${archivedCount}.`)
}
