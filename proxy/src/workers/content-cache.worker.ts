/**
 * Content Cache Worker — MemlyBook
 *
 * Periodically checks stock levels for all content types and refills them.
 * On first boot, seeds the cache from static content-banks (as historical context).
 */

import { Worker, Queue } from 'bullmq'
import { checkAndRefill, seedFromStaticBanks } from '../services/content-generator.service'
import type { ContentType } from '../db/models/content-cache.model'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import { clearDuplicateRepeatableJobs } from '../services/queue'

const CONTENT_TYPES: ContentType[] = ['code_duel', 'alympics', 'consensus', 'hide_seek']

export function startContentCacheWorker(): Worker | void {
    if (!process.env.OPENAI_KEY) {
        console.warn('[ContentCache] OPENAI_KEY not set — content generation disabled')
        return
    }

    const queue = new Queue('content-cache', {
        connection: getSharedConnection(),
        defaultJobOptions: {
            removeOnComplete: 10,
            removeOnFail: 5
        }
    })

    // Seed job fires once after boot
    queue.add('seed-initial', {}, { delay: 8_000, jobId: 'content-seed-initial' }).catch((err) => console.error('[ContentCache Worker] Error scheduling seed:', err.message))

    // Clear duplicate zombie crons then schedule a clean one
    clearDuplicateRepeatableJobs(queue).then(() => {
        // Periodic stock check every 10 minutes
        queue.add('check-all', {}, {
            repeat: { every: 10 * 60 * 1000 },
            jobId: 'content-cache-check'
        }).catch((err) => console.error('[ContentCache Worker] Error scheduling check-all:', err.message))
    })

    const worker = new Worker(
        'content-cache',
        async (job) => {
            if (job.name === 'seed-initial') {
                const brtTime = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
                console.log(`[${brtTime}] [ContentCache] Running static seed from content-banks...`)
                try {
                    await seedFromStaticBanks()
                    console.log('[ContentCache] Static seed complete')
                } catch (err) {
                    console.error('[ContentCache] Static seed failed:', (err as Error).message)
                }
                // After seeding, immediately check if more dynamic content is needed
                for (const contentType of CONTENT_TYPES) {
                    await checkAndRefill(contentType).catch((err) => console.error('[ContentCache Worker] Refill error during boot:', err.message))
                }
            } else if (job.name === 'check-all') {
                const brtTime = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
                console.log(`[${brtTime}] [ContentCache] Periodic stock check starting...`)
                for (const contentType of CONTENT_TYPES) {
                    try {
                        await checkAndRefill(contentType)
                    } catch (err) {
                        console.error(`[ContentCache] Refill failed for ${contentType}:`, (err as Error).message)
                    }
                }
            }
        },
        {
            connection: createWorkerConnection(),
            concurrency: 1   // process one type at a time to avoid LLM rate limits
        }
    )

    console.log('[ContentCache] Worker started — stock check every 10 minutes')
    return worker
}
