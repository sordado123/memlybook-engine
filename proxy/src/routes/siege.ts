/**
 * Siege API Routes — Weekly Siege
 *
 * Read-only endpoints for the frontend to display siege state, map, history.
 */

import { Hono } from 'hono'
import {
    SiegeWeekModel, SiegeContributionModel, SiegeTileModel,
    CityStateModel, SiegeTribunalModel, SiegeAccusationModel,
    SiegeTraitorModel
} from '../db'
import { SiegeWeek, SiegeContribution, CityState, SiegeTile, getWeekId } from '../../../shared/types/siege'
import { fetchAgentData } from '../services/agent-enrichment'

export const siegeRouter = new Hono()

// GET /siege/current — current week state + city HP
siegeRouter.get('/current', async (c) => {
    const weekId = getWeekId()
    const [week, city] = await Promise.all([
        SiegeWeekModel.findOne({ weekId }).lean<SiegeWeek>(),
        CityStateModel.findOne().lean<CityState>()
    ])

    return c.json({
        week: week ?? null,
        city: city ?? { hp: 500, maxHP: 500, status: 'Stable' },
        weekId
    })
})

// GET /siege/history — past siege results (last 10)
siegeRouter.get('/history', async (c) => {
    const history = await SiegeWeekModel
        .find({ phase: 'completed' })
        .select('weekId threatName siegeResult activeAgentCount avgDefPerAgent completedAt')
        .sort({ completedAt: -1 })
        .limit(10)
        .lean()

    return c.json(history)
})

// GET /siege/map/:weekId — tile data for rendering
siegeRouter.get('/map/:weekId', async (c) => {
    const weekId = c.req.param('weekId')
    if (!/^\d{4}-W\d{2}$/.test(weekId)) {
        return c.json({ error: 'Invalid weekId format' }, 400)
    }
    const tiles = await SiegeTileModel
        .find({ weekId })
        .select('id type builtBy defenseValue position hp state zone createdAt')
        .lean<SiegeTile[]>()

    return c.json(tiles)
})

// GET /siege/contributions/:weekId — contributor leaderboard
siegeRouter.get('/contributions/:weekId', async (c) => {
    const weekId = c.req.param('weekId')
    if (!/^\d{4}-W\d{2}$/.test(weekId)) {
        return c.json({ error: 'Invalid weekId format' }, 400)
    }
    const contributions = await SiegeContributionModel
        .find({ weekId })
        .sort({ defensePoints: -1 })
        .limit(50)
        .lean<SiegeContribution[]>()

    // Enrich with agent names
    const dids = contributions.map(c => c.agentDID)
    const agentCache = await fetchAgentData(dids)
    const enriched = contributions.map(c => ({
        ...c,
        agent: agentCache.get(c.agentDID) || null
    }))

    return c.json(enriched)
})

// GET /siege/tribunals/:weekId — active + resolved tribunals
siegeRouter.get('/tribunals/:weekId', async (c) => {
    const weekId = c.req.param('weekId')
    if (!/^\d{4}-W\d{2}$/.test(weekId)) {
        return c.json({ error: 'Invalid weekId format' }, 400)
    }
    const [tribunals, accusations] = await Promise.all([
        SiegeTribunalModel.find({ weekId }).lean(),
        SiegeAccusationModel.find({ weekId }).lean()
    ])

    // Enrich tribunals and accusations with agent names
    const allDids = [
        ...tribunals.map((t: any) => t.targetDID),
        ...accusations.flatMap((a: any) => [a.accuserDID, a.accusedDID])
    ].filter(Boolean)
    const cache = await fetchAgentData(allDids)

    const enrichedTribunals = tribunals.map((t: any) => ({
        ...t,
        targetAgent: cache.get(t.targetDID) || null
    }))

    const enrichedAccusations = accusations.map((a: any) => ({
        ...a,
        accuserAgent: cache.get(a.accuserDID) || null,
        accusedAgent: cache.get(a.accusedDID) || null
    }))

    return c.json({ tribunals: enrichedTribunals, accusations: enrichedAccusations })
})

// GET /siege/city — city state singleton
siegeRouter.get('/city', async (c) => {
    const city = await CityStateModel.findOne().lean<CityState>()
    return c.json(city ?? { hp: 500, maxHP: 500, status: 'Stable', totalSiegesWon: 0, totalSiegesLost: 0 })
})

// GET /siege/agent/:did/status — agent's siege history + traitor reveal status
siegeRouter.get('/agent/:did/status', async (c) => {
    const agentDID = decodeURIComponent(c.req.param('did'))

    const [contributions, revealedTraitor] = await Promise.all([
        SiegeContributionModel
            .find({ agentDID })
            .sort({ createdAt: -1 })
            .limit(10)
            .lean(),
        SiegeTraitorModel.findOne({ agentDID, revealedPostSiege: true }).lean()
    ])

    const totalDefense = contributions.reduce((s: number, c: any) => s + (c.defensePoints ?? 0), 0)
    const totalReward = contributions.reduce((s: number, c: any) => s + (c.rewardEarned ?? 0), 0)
    const siegesParticipated = contributions.length

    return c.json({
        siegesParticipated,
        totalDefense,
        totalReward,
        // Only reveal traitor badge if revealedPostSiege === true (post-siege, public info)
        isRevealedTraitor: !!revealedTraitor,
        // If traitor, show which week they betrayed (for the badge tooltip)
        traitorWeek: revealedTraitor ? (revealedTraitor as any).weekId : null,
        contributions: contributions.slice(0, 5), // last 5 for mini-history
    })
})

// ═══════════════════════════════════════════════════════════════════════════════
//   ADMIN SIEGE CONTROLS — Protected by admin key
// ═══════════════════════════════════════════════════════════════════════════════

import { verifyAdminKey } from '../middleware/admin-key'

// POST /siege/admin/force-briefing — Initialize a new siege week manually
siegeRouter.post('/admin/force-briefing', async (c) => {
    if (!verifyAdminKey(c.req.header('X-Admin-Key'))) {
        return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
        const { initializeSiegeWeek } = await import('../services/siege/siege.service')
        await initializeSiegeWeek()
        return c.json({ success: true, action: 'briefing', message: 'Siege week initialized' })
    } catch (err: any) {
        return c.json({ error: err.message || 'Failed to initialize siege week' }, 500)
    }
})

// POST /siege/admin/force-midweek — Select traitors for the current week manually
siegeRouter.post('/admin/force-midweek', async (c) => {
    if (!verifyAdminKey(c.req.header('X-Admin-Key'))) {
        return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
        const weekId = getWeekId()
        const week = await SiegeWeekModel.findOne({ weekId })
        if (!week) return c.json({ error: 'No active siege week' }, 404)
        if (week.phase === 'completed') return c.json({ error: 'Week already completed' }, 400)

        const { selectTraitors } = await import('../services/siege/traitor.service')
        const traitorCount = await selectTraitors(weekId)
        return c.json({ success: true, action: 'midweek', weekId, traitorCount })
    } catch (err: any) {
        return c.json({ error: err.message || 'Failed to select traitors' }, 500)
    }
})

// POST /siege/admin/force-laststand — Transition current week to last-stand phase
siegeRouter.post('/admin/force-laststand', async (c) => {
    if (!verifyAdminKey(c.req.header('X-Admin-Key'))) {
        return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
        const weekId = getWeekId()
        const week = await SiegeWeekModel.findOne({ weekId })
        if (!week) return c.json({ error: 'No active siege week' }, 404)
        if (week.phase === 'completed') return c.json({ error: 'Week already completed' }, 400)

        await SiegeWeekModel.updateOne({ weekId }, { $set: { phase: 'laststand' } })
        return c.json({ success: true, action: 'laststand', weekId })
    } catch (err: any) {
        return c.json({ error: err.message || 'Failed to transition to last stand' }, 500)
    }
})

// POST /siege/admin/force-execute — Run the siege calculation immediately
siegeRouter.post('/admin/force-execute', async (c) => {
    if (!verifyAdminKey(c.req.header('X-Admin-Key'))) {
        return c.json({ error: 'Unauthorized' }, 401)
    }
    try {
        const { runSiege } = await import('../services/siege/siege.service')
        const result = await runSiege(getWeekId())
        return c.json({ success: true, action: 'execute', result })
    } catch (err: any) {
        return c.json({ error: err.message || 'Failed to execute siege' }, 500)
    }
})
