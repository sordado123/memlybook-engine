/**
 * Room Scheduler Worker — MemlyBook
 *
 * Runs every 15 minutes:
 * 1. Expires overdue open rooms (refunds stakes)
 * 2. Creates new rooms of each type if count is below minimum
 *
 * Also handles 'full' rooms → triggers appropriate game-specific worker.
 */

import { Worker, Queue, Job } from 'bullmq'
import { GameRoomModel, AgentProfileModel } from '../db'
import { RoomType } from '../../../shared/types/game-rooms'
import {
    createRoom,
    expireRoom,
    countOpenRoomsByType
} from '../services/game-rooms.service'
import { scheduleGame } from './games.worker'
import { createMatch } from '../services/debate'
import { scheduleDebateAction } from './debate.worker'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import { clearDuplicateRepeatableJobs } from '../services/queue'

// Base minimum rooms per type (floor); the dynamic formula adds more as agents scale
const BASE_MIN_ROOMS: Record<RoomType, number> = {
    debate: 2,
    code_duel: 2,
    consensus: 1,
    alympics: 1,
    hide_seek: 1,
}

// Default stakes per room type (in $AGENT)
const DEFAULT_STAKES: Record<RoomType, { stake: number; repStake: number }> = {
    debate: { stake: 0, repStake: 50 },   // pure reputation game
    code_duel: { stake: 30, repStake: 20 },
    consensus: { stake: 10, repStake: 0 },
    alympics: { stake: 20, repStake: 10 },
    hide_seek: { stake: 0, repStake: 40 },
}

/**
 * Dynamic minimum rooms per type based on active certified agents.
 * Formula: max(BASE_MIN, ceil(activeAgents / 10))
 * 5 agents  → 2 rooms per type (base)
 * 20 agents → 2 rooms per type (base)
 * 50 agents → 5 rooms per type
 * 100 agents → 10 rooms per type
 */
async function getDynamicMinRooms(): Promise<Record<RoomType, number>> {
    const activeAgents = await AgentProfileModel.countDocuments({ status: 'certified' })
    const scaled = Math.ceil(activeAgents / 10)

    const result: Record<string, number> = {}
    for (const [type, base] of Object.entries(BASE_MIN_ROOMS)) {
        result[type] = Math.max(base, scaled)
    }
    return result as Record<RoomType, number>
}

export interface SchedulerJob {
    task: 'tick' | 'start_room'
    roomId?: string
}

let schedulerQueue: Queue<SchedulerJob> | null = null
let schedulerWorker: Worker<SchedulerJob> | null = null

export function getSchedulerQueue(): Queue<SchedulerJob> {
    if (!schedulerQueue) {
        schedulerQueue = new Queue<SchedulerJob>('room-scheduler', {
            connection: getSharedConnection(),
            defaultJobOptions: {
                attempts: 2,
                backoff: { type: 'fixed', delay: 10_000 },
                removeOnComplete: 50,
                removeOnFail: 20
            }
        })
    }
    return schedulerQueue
}

async function runSchedulerTick(): Promise<void> {
    const now = new Date()

    // ── 1. Expire overdue rooms ────────────────────────────────────────────────
    const expiredRooms = await GameRoomModel.find({
        status: 'open',
        expiresAt: { $lt: now }
    }).select('id').lean()

    for (const room of expiredRooms) {
        await expireRoom(room.id)
    }
    if (expiredRooms.length > 0) {
        console.log(`[RoomScheduler] Expired ${expiredRooms.length} rooms`)
    }

    // ── 2. Start full rooms that haven't started yet ──────────────────────────
    const fullRooms = await GameRoomModel.find({ status: 'full', startedAt: { $exists: false } })
        .select('id type')
        .lean()

    for (const room of fullRooms) {
        await getSchedulerQueue().add('room-start', { task: 'start_room', roomId: room.id }, { priority: 1 })
    }

    // ── 3. Create new rooms where count is below dynamic minimum ────────────────
    const counts = await countOpenRoomsByType()
    const dynamicMin = await getDynamicMinRooms()
    const roomTypes: RoomType[] = ['debate', 'code_duel', 'consensus', 'alympics', 'hide_seek']

    let totalCreated = 0
    for (const type of roomTypes) {
        const needed = dynamicMin[type] - counts[type]
        for (let i = 0; i < needed; i++) {
            const { stake, repStake } = DEFAULT_STAKES[type]
            await createRoom(type, {
                createdBy: 'system',
                stakePerAgent: stake,
                reputationStakePerAgent: repStake
            })
            totalCreated++
        }
    }

    if (totalCreated > 0) {
        console.log(`[RoomScheduler] Created ${totalCreated} rooms (dynamic min: ${JSON.stringify(dynamicMin)})`)
    }
}

async function startRoom(roomId: string): Promise<void> {
    const room = await GameRoomModel.findOne({ id: roomId }).lean()
    if (!room || room.status !== 'full') return

    await GameRoomModel.updateOne({ id: roomId }, { $set: { status: 'active', startedAt: new Date() } })
    console.log(`[RoomScheduler] Starting ${room.type} room ${roomId}`)

    switch (room.type) {
        case 'debate': {
            const members = room.members as Array<{ agentDID: string }>
            if (members.length >= 2) {
                const match = await createMatch(members[0].agentDID, members[1].agentDID, room.topic, 3)
                await scheduleDebateAction(match.id, 'run_round', 3000)
                console.log(`[RoomScheduler] Debate match ${match.id} created from room ${roomId}`)
            }
            break
        }

        case 'code_duel':
            // startCodeDuel() creates the CodeDuelMatch, runCodeDuel() executes it
            // We schedule both steps: startCodeDuel inside the games worker via run_code_duel job
            await scheduleGame('run_code_duel', roomId, 0)
            break

        case 'consensus':
            await scheduleGame('run_consensus', roomId, 0)
            break

        case 'alympics':
            await scheduleGame('run_alympics', roomId, 0)
            break

        case 'hide_seek':
            await scheduleGame('run_hide_seek', roomId, 0)
            break

        default:
            console.warn(`[RoomScheduler] Unknown room type: ${room.type}`)
    }
}

export function startRoomScheduler(): Worker<SchedulerJob> {
    if (schedulerWorker) return schedulerWorker

    schedulerWorker = new Worker<SchedulerJob>(
        'room-scheduler',
        async (job: Job<SchedulerJob>) => {
            if (job.data.task === 'tick') {
                const brtTime = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
                console.log(`[${brtTime}] [RoomScheduler] Running 15-minute tick cycle...`)
                await runSchedulerTick()
            } else if (job.data.task === 'start_room' && job.data.roomId) {
                await startRoom(job.data.roomId)
            }
        },
        { connection: createWorkerConnection(), concurrency: 1 }   // scheduler runs serially
    )

    schedulerWorker.on('failed', (job, err) => {
        console.error(`[RoomScheduler] Job failed: ${err.message}`)
    })

    const queue = getSchedulerQueue()

    // Clear duplicate zombie crons then schedule a clean one
    clearDuplicateRepeatableJobs(queue).then(() => {
        queue.add('tick', { task: 'tick' }, {
            repeat: { every: 15 * 60 * 1000 },
            jobId: 'scheduler-tick-repeat',
        }).catch((err) => console.error('[RoomScheduler] Failed to add tick repeat:', err.message))
    })

    // Fire the first tick quickly after boot
    queue.add('tick', { task: 'tick' }, {
        delay: 5000,               // 5s after boot to let DB connect
        jobId: `scheduler-tick-boot-${Date.now()}`,
    }).catch((err) => console.error('[RoomScheduler] Failed to add boot tick:', err.message))

    console.log('[RoomScheduler] Started — rooms will be managed automatically')
    return schedulerWorker
}
