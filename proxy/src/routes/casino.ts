/**
 * Casino Routes — Sportsbook API
 */

import { Hono } from 'hono'
import {
    getEvents,
    getEventDetail,
    placeBet,
    getAgentBets,
    getLeaderboard,
    getCasinoStats,
    resolveEvent,
    syncEvents,
} from '../services/games/casino.service'
import { authMiddleware } from '../middleware/auth'
import { verifyAdminKey } from '../middleware/admin-key'
import { fetchAgentData } from '../services/agent-enrichment'
import { createSafeError } from '../middleware/error-handler'

export const casinoRouter = new Hono()

// ── List events ──────────────────────────────────────────────────
casinoRouter.get('/events', async (c) => {
    const sport = c.req.query('sport')
    const status = c.req.query('status')
    const events = await getEvents({ sport, status })
    return c.json({ events })
})

// ── Event detail ─────────────────────────────────────────────────
casinoRouter.get('/events/:eventId', async (c) => {
    const eventId = c.req.param('eventId')
    const detail = await getEventDetail(eventId)
    if (!detail) throw createSafeError(404, 'Event not found', 'CASINO_002')
    return c.json(detail)
})

// Research endpoint removed — research is an agent-only tool via dispatcher.
// Cached research data is already embedded in getEventDetail() response.

// ── Place a bet (requires authenticated agent) ─────────────────
casinoRouter.post('/bets', authMiddleware, async (c) => {
    // Use authenticated DID from JWT — never trust the request body
    const agentDID = c.get('agentDID' as never) as unknown as string
    const body = await c.req.json()
    const { eventId, pick, amount, odds, confidence, reasoning } = body

    if (!agentDID || !eventId || !pick || !amount || odds === undefined) {
        throw createSafeError(400, 'Missing required fields: eventId, pick, amount, odds', 'CASINO_005')
    }

    try {
        const result = await placeBet(agentDID, eventId, pick, amount, odds, confidence, reasoning)
        return c.json(result, 201)
    } catch (err) {
        const msg = (err as Error).message
        if (msg.includes('not found') || msg.includes('not certified') || msg.includes('Insufficient')) {
            throw createSafeError(400, msg, 'CASINO_006')
        }
        throw createSafeError(500, 'Failed to place bet', 'CASINO_007')
    }
})

// ── Agent bet history ────────────────────────────────────────────
casinoRouter.get('/bets/:agentDID', async (c) => {
    const agentDID = decodeURIComponent(c.req.param('agentDID'))
    const limit = parseInt(c.req.query('limit') ?? '20')
    const bets = await getAgentBets(agentDID, limit)
    return c.json({ bets })
})

// ── Leaderboard ──────────────────────────────────────────────────
casinoRouter.get('/leaderboard', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '20')
    const leaderboard = await getLeaderboard(limit)

    // Enrich with agent names
    const dids = leaderboard.map((entry: any) => entry.agentDID)
    const agentCache = await fetchAgentData(dids)
    const enriched = leaderboard.map((entry: any) => ({
        ...entry,
        agent: agentCache.get(entry.agentDID) || null
    }))

    return c.json({ leaderboard: enriched })
})

// ── Stats ────────────────────────────────────────────────────────
casinoRouter.get('/stats', async (c) => {
    const stats = await getCasinoStats()
    return c.json(stats)
})

// ── Manual sync (admin) ──────────────────────────────────────────
casinoRouter.post('/sync', async (c) => {
    if (!verifyAdminKey(c.req.header('X-Admin-Key'))) {
        throw createSafeError(401, 'Unauthorized', 'AUTH_001')
    }
    const synced = await syncEvents()
    return c.json({ synced })
})

// ── Resolve event (admin) ────────────────────────────────────────
casinoRouter.post('/events/:eventId/resolve', async (c) => {
    if (!verifyAdminKey(c.req.header('X-Admin-Key'))) {
        throw createSafeError(401, 'Unauthorized', 'AUTH_001')
    }
    const eventId = c.req.param('eventId')
    const { winner, homeScore, awayScore } = await c.req.json()
    if (!winner) {
        throw createSafeError(400, 'winner required (home/away/draw)', 'CASINO_012')
    }
    const result = await resolveEvent(eventId, winner, homeScore, awayScore)
    return c.json(result)
})
