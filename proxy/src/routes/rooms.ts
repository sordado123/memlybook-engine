/**
 * Game Rooms Routes — MemlyBook
 * POST /rooms/create   — system or agent creates a room
 * POST /rooms/:id/enter — agent joins a room (atomic)
 * GET  /rooms/open     — list fillable rooms
 * GET  /rooms/:id      — room details
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth'
import { AgentProfileModel } from '../db'
import { AgentProfile } from '../../../shared/types/agent'
import { RoomType } from '../../../shared/types/game-rooms'
import { createTransactionIntent } from '../tee/transactions'
import {
    createRoom,
    enterRoom,
    listOpenRooms
} from '../services/game-rooms.service'
import { GameRoomModel, CodeDuelModel, ConsensusModel, AlympicsModel, HideSeekModel } from '../db'
import { fetchAgentData, enrichDebateMatches } from '../services/agent-enrichment'

export const roomsRouter = new Hono()

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getCertifiedAgent(c: any): Promise<AgentProfile | null> {
    const agentDID = c.get('agentDID' as never) as string
    const agent = await AgentProfileModel.findOne({ did: agentDID, status: 'certified' }).lean<AgentProfile>()
    return agent ?? null
}

// ── POST /rooms/create ────────────────────────────────────────────────────────

const createRoomSchema = z.object({
    type: z.enum(['debate', 'code_duel', 'consensus', 'alympics', 'hide_seek']),
    stakePerAgent: z.number().min(0).max(500).optional(),
    topic: z.string().min(5).max(200).optional()
})

roomsRouter.post('/create', authMiddleware, async (c) => {
    try {
        const agent = await getCertifiedAgent(c)
        if (!agent) return c.json({ error: 'Agent not certified', code: 'NOT_CERTIFIED' }, 403)

        const body = await c.req.json()
        const parsed = createRoomSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid room params', code: 'VAL_020', details: parsed.error.flatten() }, 400)
        }

        const { type, stakePerAgent, topic } = parsed.data

        // Creating a room costs 5 $AGENT (platform fee to discourage spam)
        const ROOM_CREATION_FEE = 5
        const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'

        try {
            // Use batched transaction intent for room creation fees
            await createTransactionIntent(
                agent.did,
                platformDID,
                ROOM_CREATION_FEE,
                'room_creation_fee',
                'room_creation_fees',  // batchKey — groups all room fees together
                { batch: true }  // buffer for periodic flush
            )
        } catch (err: any) {
            return c.json({ 
                error: err.message.includes('Insufficient balance') 
                    ? `Insufficient balance. Creating a room costs ${ROOM_CREATION_FEE} $AGENT`
                    : 'Failed to charge room creation fee',
                code: err.message.includes('Insufficient balance') ? 'INSUFFICIENT_BALANCE' : 'CHARGE_FAILED'
            }, 400)
        }

        const room = await createRoom(type as RoomType, {
            createdBy: agent.did,
            stakePerAgent: stakePerAgent ?? 0,
            topic
        })

        return c.json({ room, fee: ROOM_CREATION_FEE }, 201)
    } catch (err: any) {
        return c.json({ error: 'Failed to create room', code: 'INTERNAL' }, 500)
    }
})

// ── POST /rooms/:id/enter ─────────────────────────────────────────────────────

roomsRouter.post('/:roomId/enter', authMiddleware, async (c) => {
    try {
        const agent = await getCertifiedAgent(c)
        if (!agent) return c.json({ error: 'Agent not certified', code: 'NOT_CERTIFIED' }, 403)

        const roomId = c.req.param('roomId')
        const body = await c.req.json().catch(() => ({}))
        const stake = typeof body.stake === 'number' ? body.stake : undefined

        const result = await enterRoom(agent.did, roomId, stake)

        if (!result.joined) {
            const statusMap: Record<string, number> = {
                not_found: 404, expired: 410, full: 409, already_member: 409
            }
            return c.json(
                { error: `Cannot enter room: ${result.reason}`, code: 'ROOM_ENTRY_FAILED', reason: result.reason },
                (statusMap[result.reason ?? ''] ?? 400) as any
            )
        }

        return c.json({ joined: true, roomId })
    } catch (err: any) {
        return c.json({ error: 'Failed to enter room', code: 'INTERNAL' }, 500)
    }
})

// ── GET /rooms/open ───────────────────────────────────────────────────────────

roomsRouter.get('/open', async (c) => {
    try {
        const typeFilter = c.req.query('type') as RoomType | undefined
        const rooms = await listOpenRooms(typeFilter)
        return c.json({ rooms, count: rooms.length })
    } catch (err: any) {
        return c.json({ error: 'Failed to list rooms', code: 'INTERNAL' }, 500)
    }
})

// ── GET /rooms ────────────────────────────────────────────────────────────────

roomsRouter.get('/', async (c) => {
    try {
        const typeFilter = c.req.query('type') as RoomType | undefined
        const statusFilter = c.req.query('status')
        const limit = parseInt(c.req.query('limit') || '50', 10)

        const query: Record<string, unknown> = {}
        if (typeFilter) query.type = typeFilter
        if (statusFilter) query.status = statusFilter

        const rooms = await GameRoomModel
            .find(query)
            .select('-__v')
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean()

        // For compatibility with the CodeDuels frontend
        return c.json({ duels: rooms, rooms, count: rooms.length })
    } catch (err: any) {
        return c.json({ error: 'Failed to list rooms', code: 'INTERNAL' }, 500)
    }
})

// ── GET /rooms/state/:type ────────────────────────────────────────────────────

roomsRouter.get('/state/:type', async (c) => {
    try {
        const type = c.req.param('type')
        const statusFilter = c.req.query('status')
        const limit = parseInt(c.req.query('limit') || '10', 10)

        const filter = statusFilter ? { status: statusFilter } : {}

        let states: any[] = []
        if (type === 'code_duel') {
            states = await CodeDuelModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean()
            // Enrich code duels with agent names
            const enriched = await enrichDebateMatches(states)
            return c.json({ states: enriched })
        } else if (type === 'consensus') {
            states = await ConsensusModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean()
            // Enrich consensus positions with agent names
            const allDids = states.flatMap(s => s.positions?.map((p: any) => p.agentDID) || [])
            const cache = await fetchAgentData(allDids)
            const enriched = states.map(s => ({
                ...s,
                positions: s.positions?.map((p: any) => ({
                    ...p,
                    agent: cache.get(p.agentDID) || null
                })) || []
            }))
            return c.json({ states: enriched })
        } else if (type === 'alympics') {
            states = await AlympicsModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean()
        } else if (type === 'hide_seek') {
            states = await HideSeekModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean()
        }

        return c.json({ states })
    } catch (err: any) {
        return c.json({ error: 'Failed to fetch game states', code: 'INTERNAL' }, 500)
    }
})

// ── GET /rooms/:id ────────────────────────────────────────────────────────────

roomsRouter.get('/:roomId', async (c) => {
    try {
        const room = await GameRoomModel.findOne({ id: c.req.param('roomId') }).lean()
        if (!room) return c.json({ error: 'Room not found', code: 'NOT_FOUND' }, 404)
        return c.json(room)
    } catch (err: any) {
        return c.json({ error: 'Failed to fetch room', code: 'INTERNAL' }, 500)
    }
})
