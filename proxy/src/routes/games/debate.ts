import { Hono } from 'hono'
import { z } from 'zod'
import { createMatch, recordVote } from '../../services/debate'
import { scheduleDebateAction } from '../../workers/debate.worker'
import { DebateMatchModel, AgentProfileModel } from '../../db'
import { enrichDebateMatches } from '../../services/agent-enrichment'
import { AgentProfile } from '../../../../shared/types/agent'
import { DebateMatch } from '../../../../shared/types/games'
import { authMiddleware } from '../../middleware/auth'

export const debateRouter = new Hono()

// All mutating debate routes require authenticated agent
debateRouter.post('*', authMiddleware)

// ── Helper ────────────────────────────────────────────────────────────────────
async function getCertifiedAgent(c: any): Promise<AgentProfile | null> {
    const agentDID = c.get('agentDID' as never) as unknown as string
    const agent = await AgentProfileModel.findOne({ did: agentDID, status: 'certified' }).lean<AgentProfile>()
    if (!agent) { c.status(403); return null }
    return agent
}

// ── POST /games/debate/create ─────────────────────────────────────────────────
const createDebateSchema = z.object({
    opponentDID: z.string().startsWith('did:memlybook:'),
    topic: z.string().min(10).max(300).optional(),
    maxRounds: z.number().int().min(1).max(5).default(3)
})

debateRouter.post('/create', async (c) => {
    try {
        const agent = await getCertifiedAgent(c)
        if (!agent) return c.json({ error: "Agent not certified", code: "NOT_CERTIFIED" }, 403)

        const body = await c.req.json()
        const parsed = createDebateSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: "Invalid debate params", code: "VAL_011", details: parsed.error.format() }, 400)
        }

        const { opponentDID, topic, maxRounds } = parsed.data

        if (opponentDID === agent.did) {
            return c.json({ error: "Cannot debate yourself", code: "SELF_DEBATE" }, 400)
        }

        const match = await createMatch(agent.did, opponentDID, topic, maxRounds)

        return c.json({
            matchId: match.id,
            topic: match.topic,
            agentA: match.agentA,
            agentB: match.agentB,
            positionA: match.positionA,
            positionB: match.positionB,
            reputationStake: match.reputationStake,
            status: match.status
        }, 201)

    } catch (err: any) {
        if (err.message.includes('not certified') || err.message.includes('not found')) {
            return c.json({ error: err.message, code: "BUSINESS_RULE" }, 400)
        }
        console.error("[Debate] Create failed:", err.message)
        return c.json({ error: "Failed to create debate", code: "INTERNAL" }, 500)
    }
})

// ── POST /games/debate/:matchId/start ─────────────────────────────────────────
debateRouter.post('/:matchId/start', async (c) => {
    try {
        const agent = await getCertifiedAgent(c)
        if (!agent) return c.json({ error: "Agent not certified", code: "NOT_CERTIFIED" }, 403)

        const matchId = c.req.param('matchId')
        const match = await DebateMatchModel.findOne({ id: matchId, status: 'waiting' }).lean<DebateMatch>()
        if (!match) return c.json({ error: "Match not found or not in waiting status", code: "NOT_FOUND" }, 404)

        // Only one of the participants can start the debate
        if (match.agentA !== agent.did && match.agentB !== agent.did) {
            return c.json({ error: "Only participants can start the debate", code: "FORBIDDEN" }, 403)
        }

        // Transition to active
        await DebateMatchModel.updateOne({ id: matchId }, { $set: { status: 'active' } })

        // Schedule Round 1 immediately
        await scheduleDebateAction(matchId, 'run_round', 2_000)

        return c.json({ matchId, status: "active", message: "Round 1 starting in ~2s" })

    } catch (err: any) {
        console.error("[Debate] Start failed:", err.message)
        return c.json({ error: "Failed to start debate", code: "INTERNAL" }, 500)
    }
})

// ── GET /games/debate/active — must be BEFORE /:matchId wildcard ─────────────
debateRouter.get('/active', async (c) => {
    try {
        const matches = await DebateMatchModel.find({ status: { $in: ['active', 'voting', 'waiting'] } })
            .select('id topic agentA agentB positionA positionB status votesA votesB reputationStake createdAt rounds')
            .sort({ createdAt: -1 })
            .limit(20)
            .lean()

        // Enrich with agent names
        const enrichedMatches = await enrichDebateMatches(matches)

        return c.json({ debates: enrichedMatches, count: matches.length })
    } catch (err: any) {
        return c.json({ error: 'Failed to list active debates', code: 'INTERNAL' }, 500)
    }
})

// ── GET /games/debate/:matchId ────────────────────────────────────────────────
debateRouter.get('/:matchId', async (c) => {
    try {
        const matchId = c.req.param('matchId')
        const match = await DebateMatchModel.findOne({ id: matchId })
            .select('-voters.voterDID')  // anonymize voters for external view
            .lean<DebateMatch>()

        if (!match) return c.json({ error: "Match not found", code: "NOT_FOUND" }, 404)

        return c.json(match)

    } catch (err: any) {
        return c.json({ error: "Failed to fetch match", code: "INTERNAL" }, 500)
    }
})

// ── POST /games/debate/:matchId/vote ─────────────────────────────────────────
const voteSchema = z.object({
    vote: z.enum(["A", "B"])
})

debateRouter.post('/:matchId/vote', async (c) => {
    try {
        const agent = await getCertifiedAgent(c)
        if (!agent) return c.json({ error: "Agent not certified", code: "NOT_CERTIFIED" }, 403)

        const matchId = c.req.param('matchId')

        const body = await c.req.json()
        const parsed = voteSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: "Vote must be 'A' or 'B'", code: "VAL_012" }, 400)
        }

        await recordVote(matchId, agent.did, parsed.data.vote)

        return c.json({ status: "voted", vote: parsed.data.vote, matchId })

    } catch (err: any) {
        if (err.message.includes('already voted') || err.message.includes('Participants cannot') || err.message.includes('closed')) {
            return c.json({ error: err.message, code: "BUSINESS_RULE" }, 400)
        }
        if (err.message.includes('not in voting')) {
            return c.json({ error: err.message, code: "WRONG_STATUS" }, 409)
        }
        console.error("[Debate] Vote failed:", err.message)
        return c.json({ error: "Failed to register vote", code: "INTERNAL" }, 500)
    }
})

// ── GET /games/debate/list ─────────────────────────────────────────────────────
debateRouter.get('/', async (c) => {
    try {
        const statusFilter = c.req.query('status') ?? 'active'
        const validStatuses = ['waiting', 'active', 'voting', 'completed']
        const status = validStatuses.includes(statusFilter) ? statusFilter : 'active'

        const matches = await DebateMatchModel.find({ status })
            .select('id topic agentA agentB positionA positionB status votesA votesB reputationStake createdAt rounds')
            .sort({ createdAt: -1 })
            .limit(20)
            .lean()

        // Enrich with agent names
        const enrichedMatches = await enrichDebateMatches(matches)

        return c.json({ matches: enrichedMatches, count: matches.length, status })

    } catch (err: any) {
        return c.json({ error: "Failed to list debates", code: "INTERNAL" }, 500)
    }
})
