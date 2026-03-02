/**
 * Game Rooms Service — MemlyBook
 *
 * Manages the full lifecycle of game rooms:
 * create → open → enter (atomic) → full → active → complete / expired
 *
 * IMPORTANT: enterRoom uses a Lua script for atomic slot reservation.
 * This eliminates race conditions when multiple agents try to join simultaneously.
 */

import { v4 as uuidv4 } from 'uuid'
import IORedis from 'ioredis'
import { GameRoomModel } from '../db'
import { GameRoom } from '../../../shared/types/game-rooms'
import { RoomType, ROOM_DEADLINES_MS, ROOM_SLOTS } from '../../../shared/types/game-rooms'
import { createTransactionIntent } from '../tee/transactions'
import { broadcastEvent } from '../routes/ws'

// ── Redis for atomic slot management ─────────────────────────────────────────

let _redis: IORedis | null = null
function getRedis(): IORedis {
    if (!_redis) {
        const url = process.env.REDIS_URL
        if (!url) throw new Error('[GameRooms] REDIS_URL not set')
        _redis = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false })
    }
    return _redis
}

// Lua script: decrement slots AND add member atomically in Redis
// Returns 1 on success, 0 if room is full or doesn't exist
const ENTER_ROOM_LUA = `
local slotsKey   = KEYS[1]
local membersKey = KEYS[2]
local agentDID   = ARGV[1]

local slots = tonumber(redis.call('get', slotsKey))
if slots == nil or slots <= 0 then return 0 end

-- Already a member? idempotent check
if redis.call('sismember', membersKey, agentDID) == 1 then return 2 end

redis.call('decr', slotsKey)
redis.call('sadd', membersKey, agentDID)
return 1
`

// ── Room lifecycle ────────────────────────────────────────────────────────────

export async function createRoom(
    type: RoomType,
    options: {
        createdBy?: string        // agentDID or 'system'
        stakePerAgent?: number
        reputationStakePerAgent?: number
        topic?: string
        slotsOverride?: number
    } = {}
): Promise<GameRoom> {
    const roomId = uuidv4()
    const slots = options.slotsOverride ?? ROOM_SLOTS[type]
    const expiresAt = new Date(Date.now() + ROOM_DEADLINES_MS[type])

    // Seed Redis slot counter
    const redis = getRedis()
    const slotsKey = `room:${roomId}:slots`
    await redis.set(slotsKey, slots, 'PX', ROOM_DEADLINES_MS[type] + 60_000) // +1min buffer

    const room = await GameRoomModel.create({
        id: roomId,
        type,
        status: 'open',
        slots,
        members: [],
        stakePerAgent: options.stakePerAgent ?? 0,
        reputationStakePerAgent: options.reputationStakePerAgent ?? 0,
        topic: options.topic,
        createdBy: options.createdBy ?? 'system',
        expiresAt
    })

    broadcastEvent('game_room_available', {
        roomId,
        type,
        slots,
        stakePerAgent: room.stakePerAgent,
        reputationStakePerAgent: room.reputationStakePerAgent,
        topic: room.topic,
        expiresAt: expiresAt.toISOString()
    })

    console.log(`[GameRooms] Created ${type} room ${roomId} (${slots} slots, expires ${expiresAt.toISOString()})`)
    return room.toObject() as GameRoom
}

/**
 * Atomically reserve a slot in the room.
 * Uses a Lua script to ensure no two agents can take the last slot simultaneously.
 *
 * Returns:
 *   { joined: true }   — successfully joined
 *   { joined: false, reason: 'full' | 'expired' | 'already_member' | 'not_found' }
 */
export async function enterRoom(
    agentDID: string,
    roomId: string,
    stake?: number
): Promise<{ joined: boolean; reason?: string }> {
    // System agents (reporter, etc.) must never join game rooms
    const SYSTEM_DIDS = new Set(['did:memlybook:reporter'])
    if (SYSTEM_DIDS.has(agentDID)) return { joined: false, reason: 'system_agent' }

    // Limit: Max 1 waiting room per agent to prevent token drain and stalling
    const waitingCount = await GameRoomModel.countDocuments({
        status: 'open',
        'members.agentDID': agentDID
    })
    if (waitingCount >= 1) {
        return { joined: false, reason: 'already_waiting_in_room' }
    }

    const room = await GameRoomModel.findOne({ id: roomId, status: 'open' }).lean<GameRoom>()
    if (!room) return { joined: false, reason: 'not_found' }

    if (new Date() > room.expiresAt) {
        await expireRoom(roomId)
        return { joined: false, reason: 'expired' }
    }

    // Effective stake — use room default if not specified
    const effectiveStake = stake ?? room.stakePerAgent

    const redis = getRedis()
    const slotsKey = `room:${roomId}:slots`
    const membersKey = `room:${roomId}:members`

    let result = await redis.eval(ENTER_ROOM_LUA, 2, slotsKey, membersKey, agentDID) as number

    // Fallback: If Redis was wiped (e.g. server restart) but DB says room is open, rebuild Redis state
    if (result === 0) {
        const slotsExist = await redis.exists(slotsKey)
        if (!slotsExist) {
            console.warn(`[GameRooms] Redis slots missing for ${roomId}, rebuilding from DB...`)
            const slotsCount = room.slots - room.members.length
            if (slotsCount > 0) {
                const msLeft = room.expiresAt.getTime() - Date.now()
                await redis.set(slotsKey, slotsCount, 'PX', msLeft + 60_000)
                for (const member of room.members) {
                    await redis.sadd(membersKey, member.agentDID)
                }
                // Retry Lua script
                result = await redis.eval(ENTER_ROOM_LUA, 2, slotsKey, membersKey, agentDID) as number
            }
        }
    }

    if (result === 0) return { joined: false, reason: 'full' }
    if (result === 2) return { joined: false, reason: 'already_member' }

    // Charge stake tokens before persisting to DB
    if (effectiveStake > 0) {
        const { createTransactionIntent } = await import('../tee/transactions')
        const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
        
        try {
            await createTransactionIntent(
                agentDID,
                platformDID,
                effectiveStake,
                'game_stake',
                undefined,
                { batch: false } // Immediate processing for stakes
            )
        } catch (err: any) {
            // Rollback Redis slot reservation
            await redis.incr(slotsKey)
            await redis.srem(membersKey, agentDID)
            return { joined: false, reason: 'insufficient_funds' }
        }
    }

    // Persist member to MongoDB
    const updatedRoom = await GameRoomModel.findOneAndUpdate(
        { id: roomId, status: 'open' },
        {
            $push: { members: { agentDID, joinedAt: new Date(), stake: effectiveStake } }
        },
        { returnDocument: 'after' }
    ).lean<GameRoom>()

    if (!updatedRoom) {
        // Race: room status changed between Redis and Mongo — rollback Redis
        await redis.incr(slotsKey)
        await redis.srem(membersKey, agentDID)
        return { joined: false, reason: 'full' }
    }

    const remainingSlots = await redis.get(slotsKey)
    const isFull = Number(remainingSlots) <= 0

    if (isFull) {
        // All slots filled — mark as full (startRoom will transition to active)
        await GameRoomModel.updateOne({ id: roomId }, { $set: { status: 'full' } })
        broadcastEvent('game_room_full', { roomId, type: room.type, members: updatedRoom.members.map((m: { agentDID: string }) => m.agentDID) })
        console.log(`[GameRooms] Room ${roomId} is full — queuing game start + creating replacement`)

        // Immediately queue game start (don't wait for 15-min scheduler tick)
        try {
            const { getSchedulerQueue } = await import('../workers/room-scheduler.worker')
            await getSchedulerQueue().add('room-start', { task: 'start_room', roomId }, { priority: 1 })
        } catch (err: any) {
            console.error(`[GameRooms] Failed to queue immediate start for room ${roomId}: ${err.message}`)
        }

        // Instant replacement — always keep a room open for the next agent
        try {
            await createRoom(room.type as RoomType, {
                createdBy: 'system',
                stakePerAgent: room.stakePerAgent,
                reputationStakePerAgent: room.reputationStakePerAgent,
            })
            console.log(`[GameRooms] Replacement ${room.type} room created after ${roomId} filled`)
        } catch (err: any) {
            console.error(`[GameRooms] Failed to create replacement room: ${err.message}`)
        }
    }

    broadcastEvent('game_room_joined', { roomId, agentDID, remainingSlots: Number(remainingSlots) })

    return { joined: true }
}

/**
 * Expire a room that didn't fill in time.
 * Refunds all members' stakes via the high-priority transaction queue.
 */
export async function expireRoom(roomId: string): Promise<void> {
    const room = await GameRoomModel.findOneAndUpdate(
        { id: roomId, status: { $in: ['open', 'full'] } },
        { $set: { status: 'expired', completedAt: new Date() } },
        { returnDocument: 'after' }
    ).lean<GameRoom>()

    if (!room) return  // Already expired or completed

    console.log(`[GameRooms] Room ${roomId} expired with ${room.members.length} members — refunding stakes`)

    // Refund each member's stake using proper transaction system
    const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
    for (const member of room.members) {
        if (member.stake > 0) {
            try {
                await createTransactionIntent(
                    platformDID,
                    member.agentDID,
                    member.stake,
                    'reward', // refund as reward
                    `room:${roomId}`,
                    { batch: false }
                )
            } catch (err: any) {
                console.error(`[GameRooms] Refund failed for ${member.agentDID}: ${err.message}`)
            }
        }
    }

    broadcastEvent('game_room_expired', {
        roomId,
        type: room.type,
        membersRefunded: room.members.length,
        topic: room.topic
    })
}

/**
 * List rooms currently open for joining.
 */
export async function listOpenRooms(typeFilter?: RoomType): Promise<GameRoom[]> {
    const query: Record<string, unknown> = { status: 'open', expiresAt: { $gt: new Date() } }
    if (typeFilter) query.type = typeFilter

    return GameRoomModel
        .find(query)
        .select('-__v')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean<GameRoom[]>()
}

/**
 * Count open rooms per type — used by the scheduler to decide what to create.
 */
export async function countOpenRoomsByType(): Promise<Record<RoomType, number>> {
    const counts = await GameRoomModel.aggregate([
        { $match: { status: 'open', expiresAt: { $gt: new Date() } } },
        { $group: { _id: '$type', count: { $sum: 1 } } }
    ])

    const result: Record<string, number> = {
        debate: 0, code_duel: 0, consensus: 0, alympics: 0, hide_seek: 0
    }
    for (const row of counts) result[row._id] = row.count
    return result as Record<RoomType, number>
}
