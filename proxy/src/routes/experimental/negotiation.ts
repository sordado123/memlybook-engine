/**
 * Experimental Routes — Negotiation Tournament + Future Games
 */

import { Hono } from 'hono'
import {
    createMatch,
    getMatches,
    getMatchDetail,
    getLeaderboard,
    getNegotiationStats,
    executeRound,
} from '../../services/games/negotiation.service'
import { verifyAdminKey } from '../../middleware/admin-key'
import { fetchAgentData, enrichDebateMatches } from '../../services/agent-enrichment'

export const experimentalRouter = new Hono()

// ── Negotiation Routes ───────────────────────────────────────────

// List matches
experimentalRouter.get('/negotiation/matches', async (c) => {
    try {
        const status = c.req.query('status')
        const matches = await getMatches({ status })
        // Enrich with agent names - matches have agentA and agentB
        const enriched = await enrichDebateMatches(matches)
        return c.json({ matches: enriched })
    } catch (err) {
        console.error('[Experimental] GET /negotiation/matches error:', (err as Error).message)
        return c.json({ error: 'Failed to fetch matches', code: 'NEG_001' }, 500)
    }
})

// Match detail
experimentalRouter.get('/negotiation/matches/:matchId', async (c) => {
    try {
        const matchId = c.req.param('matchId')
        const match = await getMatchDetail(matchId)
        if (!match) return c.json({ error: 'Match not found', code: 'NEG_002' }, 404)
        return c.json(match)
    } catch (err) {
        console.error('[Experimental] GET /negotiation/matches/:id error:', (err as Error).message)
        return c.json({ error: 'Failed to fetch match', code: 'NEG_003' }, 500)
    }
})
experimentalRouter.post('/negotiation/matches', async (c) => {
    try {
        if (!verifyAdminKey(c.req.header('X-Admin-Key'))) {
            return c.json({ error: 'Unauthorized', code: 'AUTH_001' }, 401)
        }
        const { agentA, agentB } = await c.req.json()
        if (!agentA || !agentB) {
            return c.json({ error: 'agentA and agentB DIDs required', code: 'NEG_004' }, 400)
        }
        const matchId = await createMatch(agentA, agentB)
        return c.json({ matchId }, 201)
    } catch (err) {
        console.error('[Experimental] POST /negotiation/matches error:', (err as Error).message)
        return c.json({ error: (err as Error).message, code: 'NEG_005' }, 400)
    }
})

// Manually trigger a round (admin/debug)
experimentalRouter.post('/negotiation/matches/:matchId/round', async (c) => {
    try {
        if (!verifyAdminKey(c.req.header('X-Admin-Key'))) {
            return c.json({ error: 'Unauthorized', code: 'AUTH_001' }, 401)
        }
        const matchId = c.req.param('matchId')
        const result = await executeRound(matchId)
        return c.json(result)
    } catch (err) {
        console.error('[Experimental] POST round error:', (err as Error).message)
        return c.json({ error: (err as Error).message, code: 'NEG_006' }, 400)
    }
})

// Leaderboard
experimentalRouter.get('/negotiation/leaderboard', async (c) => {
    try {
        const leaderboard = await getLeaderboard()
        // Enrich with agent names
        const dids = leaderboard.map((e: any) => e.agentDID || e.did).filter(Boolean)
        const cache = await fetchAgentData(dids)
        const enriched = leaderboard.map((e: any) => ({
            ...e,
            agent: cache.get(e.agentDID || e.did) || null
        }))
        return c.json({ leaderboard: enriched })
    } catch (err) {
        console.error('[Experimental] GET /negotiation/leaderboard error:', (err as Error).message)
        return c.json({ error: 'Failed to fetch leaderboard', code: 'NEG_007' }, 500)
    }
})

// Stats
experimentalRouter.get('/negotiation/stats', async (c) => {
    try {
        const stats = await getNegotiationStats()
        return c.json(stats)
    } catch (err) {
        console.error('[Experimental] GET /negotiation/stats error:', (err as Error).message)
        return c.json({ error: 'Failed to fetch stats', code: 'NEG_008' }, 500)
    }
})
