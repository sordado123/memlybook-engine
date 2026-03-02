/**
 * Games Worker — MemlyBook
 *
 * Single consolidated BullMQ worker that handles all game mode orchestration.
 * Routes jobs to the correct game service based on job type.
 */

import { Worker, Queue, Job } from 'bullmq'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import { startCodeDuel, runCodeDuel } from '../services/games/code-duel.service'
import { startConsensus, runConsensus } from '../services/games/consensus.service'
import { startAlympics, progressAlympics } from '../services/games/alympics.service'
import { startHideSeek, runHideSeek } from '../services/games/hide-seek.service'
import { ConsensusModel } from '../db'
import { AlympicsModel } from '../db'
import { HideSeekModel } from '../db'

export type GameJobType =
    | 'run_code_duel'
    | 'run_consensus'
    | 'run_alympics'
    | 'run_hide_seek'

export interface GameJob {
    type: GameJobType
    gameId: string
    matchId?: string  // alias for matchId used by code_duel
}

let gamesQueue: Queue<GameJob> | null = null
let gamesWorker: Worker<GameJob> | null = null

export function getGamesQueue(): Queue<GameJob> {
    if (!gamesQueue) {
        gamesQueue = new Queue<GameJob>('games', {
            connection: getSharedConnection(),
            defaultJobOptions: {
                attempts: 2,
                backoff: { type: 'exponential', delay: 10_000 },
                removeOnComplete: 200,
                removeOnFail: 100
            }
        })
    }
    return gamesQueue
}

export async function scheduleGame(type: GameJobType, gameId: string, delayMs: number = 0): Promise<void> {
    const queue = getGamesQueue()
    await queue.add('game-job', { type, gameId }, {
        delay: delayMs,
        priority: 5
    })
}

export function startGamesWorker(): Worker<GameJob> {
    if (gamesWorker) return gamesWorker

    gamesWorker = new Worker<GameJob>(
        'games',
        async (job: Job<GameJob>) => {
            const { type, gameId } = job.data
            console.log(`[GamesWorker] ${type} — gameId: ${gameId}`)

            switch (type) {
                case 'run_code_duel': {
                    const match = await startCodeDuel(gameId)  // gameId = roomId
                    await runCodeDuel(match.id)                // match.id = actual matchId
                    break
                }
                case 'run_consensus': {
                    // gameId = roomId on first call from scheduler
                    // runConsensus expects the Consensus game's own UUID, not roomId
                    const existingConsensus = await ConsensusModel.findOne({ id: gameId }).lean()
                    const consensusId = existingConsensus ? gameId : (await startConsensus(gameId)).id
                    await runConsensus(consensusId)
                    break
                }
                case 'run_alympics': {
                    // gameId = roomId on first call; rounds 2/3 use the actual Alympics game UUID
                    const existingAlympics = await AlympicsModel.findOne({ id: gameId }).lean()
                    const alympicsId = existingAlympics ? gameId : (await startAlympics(gameId)).id
                    await progressAlympics(alympicsId)
                    break
                }
                case 'run_hide_seek': {
                    // gameId = roomId on first call
                    const existingHideSeek = await HideSeekModel.findOne({ id: gameId }).lean()
                    const hideSeekId = existingHideSeek ? gameId : (await startHideSeek(gameId)).id
                    await runHideSeek(hideSeekId)
                    break
                }
                default:
                    console.warn(`[GamesWorker] Unknown job type: ${type}`)
            }
        },
        {
            connection: createWorkerConnection(),
            concurrency: 4   // 4 games can run in parallel
        }
    )

    gamesWorker.on('completed', (job) => {
        console.log(`[GamesWorker] ✅ ${job.data.type} complete — ${job.data.gameId}`)
    })

    gamesWorker.on('failed', (job, err) => {
        console.error(`[GamesWorker] ❌ ${job?.data.type} failed — ${job?.data.gameId}: ${err.message}`)
    })

    console.log('[GamesWorker] Started — all game modes active')
    return gamesWorker
}
