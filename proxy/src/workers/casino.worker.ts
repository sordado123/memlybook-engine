/**
 * Casino Worker — syncs events and auto-resolves completed ones
 * 
 * State machine: upcoming → locked (30min before) → live (startTime) → completed (settled)
 * Uses odds-api.io: ~19 req/cycle × 4 cycles/hr = ~76 req/hr (< 100 limit)
 * Runs every 15 minutes to stay within API budget while keeping odds fresh
 */

import { Worker, Queue, Job } from 'bullmq'
import { syncEvents, resolveEvent } from '../services/games/casino.service'
import { fetchSettledEvents } from '../services/sportsgameodds'
import { SportEventModel } from '../db'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import { clearDuplicateRepeatableJobs } from '../services/queue'

export let casinoQueue: Queue | null = null
export let casinoWorker: Worker | null = null

export function startCasinoWorker(): Worker {
    if (casinoWorker) return casinoWorker

    const queue = new Queue('casino', {
        connection: getSharedConnection(),
        defaultJobOptions: {
            attempts: 2,
            backoff: { type: 'fixed', delay: 10_000 },
            removeOnComplete: 10,
            removeOnFail: 5
        }
    })
    casinoQueue = queue

    casinoWorker = new Worker(
        'casino',
        async (job: Job) => {
            if (job.name === 'casino-sync') {
                await runCasinoSync()
            }
        },
        { connection: createWorkerConnection(), concurrency: 1 }
    )

    casinoWorker.on('failed', (job, err) => {
        console.error(`[Casino Worker] Job failed: ${err.message}`)
    })

    clearDuplicateRepeatableJobs(queue).then(() => {
        queue.add('casino-sync', {}, {
            repeat: { every: 15 * 60 * 1000 },  // 15min: balances fresh odds vs API limit
            jobId: 'casino-sync-repeat'
        }).catch((err) => console.error('[Casino Worker] Failed to add sync job:', err.message))
    })

    // Initial sync
    queue.add('casino-sync', {}, { delay: 10_000, jobId: `casino-sync-boot-${Date.now()}` }).catch((err) => console.error('[Casino Worker] Failed to add boot sync:', err.message))

    console.log('[Casino Worker] Started — syncs every 15min')
    return casinoWorker
}

async function runCasinoSync() {
    try {
        const now = new Date()
        const thirtyMinFromNow = new Date(now.getTime() + 30 * 60 * 1000)

        // ── Step 1: Promote upcoming → locked (30min before start) ──
        const locked = await SportEventModel.updateMany(
            {
                status: 'upcoming',
                startTime: { $lte: thirtyMinFromNow, $gt: now }
            },
            { $set: { status: 'locked', updatedAt: now } }
        )
        if (locked.modifiedCount > 0) {
            console.log(`[Casino Worker] Locked ${locked.modifiedCount} events (betting closed)`)
        }

        // ── Step 2: Promote locked → live (past startTime) ──
        const promoted = await SportEventModel.updateMany(
            { status: { $in: ['upcoming', 'locked'] }, startTime: { $lte: now } },
            { $set: { status: 'live', updatedAt: now } }
        )
        if (promoted.modifiedCount > 0) {
            console.log(`[Casino Worker] Promoted ${promoted.modifiedCount} events → live`)
        }

        // ── Step 3: Check live events for results via API ──
        const liveEvents = await SportEventModel.find({
            status: 'live',
            externalId: { $ne: null },
        }).lean()

        console.log(`[Casino Worker] Found ${liveEvents.length} live events to check`)

        if (liveEvents.length > 0) {
            // Fetch settled events from API (1 batch call per league)
            console.log('[Casino Worker] Fetching settled events from API...')
            const settledFromAPI = await fetchSettledEvents()
            console.log(`[Casino Worker] Received ${settledFromAPI.length} settled events from API`)
            
            const settledMap = new Map(settledFromAPI.map(e => [e.externalId, e]))

            for (const event of liveEvents) {
                if (!event.externalId) continue
                const settled = settledMap.get(event.externalId)
                
                if (settled) {
                    console.log(`[Casino Worker] Found API match for ${event.id}: status=${settled.status}, hasScores=${!!settled.scores}`)
                }
                
                if (settled?.status === 'completed' && settled.scores) {
                    const { home: homeScore, away: awayScore } = settled.scores
                    const winner = homeScore > awayScore ? 'home' as const
                        : awayScore > homeScore ? 'away' as const
                            : 'draw' as const

                    console.log(`[Casino Worker] Auto-resolving ${event.id}: ${event.awayTeam} @ ${event.homeTeam} → ${winner} (${homeScore}-${awayScore})`)
                    
                    try {
                        await resolveEvent(event.id, winner, homeScore, awayScore)
                    } catch (err) {
                        console.error(`[Casino Worker] Failed to resolve ${event.id}:`, (err as Error).message)
                    }
                } else if (settled) {
                    console.log(`[Casino Worker] Skipping ${event.id}: status=${settled.status}, hasScores=${!!settled.scores}`)
                }
            }
        }

        // ── Step 4: Smart sync (fill up to 5 events) ──
        const brt = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        console.log(`[Casino Worker] [${brt}] Running smart sync...`)
        await syncEvents()

    } catch (err) {
        console.error('[Casino Worker] Worker cycle error:', (err as Error).message)
    }
}
