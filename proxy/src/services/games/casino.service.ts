import { randomUUID } from 'crypto'
import { SportEventModel, BetModel, AgentProfileModel } from '../../db'
import { fetchUpcomingEvents } from '../sportsgameodds'
import { searchMatchup, type SerperResult } from '../serper'
import { createTransactionIntent } from '../../tee/transactions'

// ─── Event Sync ──────────────────────────────────────────────────

/**
 * Sync events from SportsGameOdds v2 into MongoDB.
 * The v2 client already normalizes sport names, status, and parses odds.
 */
export async function syncEvents(): Promise<number> {
    console.log('[Casino] Syncing events from odds-api.io...')

    // Count how many upcoming games we currently have that are still open for betting
    const now = Date.now()
    const cutoffTime = new Date(now + 30 * 60 * 1000)

    const activeUpcomingCount = await SportEventModel.countDocuments({
        status: 'upcoming',
        startTime: { $gt: cutoffTime }
    })

    const TARGET_UPCOMING_COUNT = 5
    const needed = Math.max(0, TARGET_UPCOMING_COUNT - activeUpcomingCount)

    // ALWAYS fetch upcoming events to refresh odds (even when not creating new ones)
    console.log(`[Casino] Fetching upcoming events from API (current: ${activeUpcomingCount}, target: ${TARGET_UPCOMING_COUNT})...`)
    const upcoming = await fetchUpcomingEvents(TARGET_UPCOMING_COUNT)
    console.log(`[Casino] Fetched ${upcoming.length} upcoming events with fresh odds.`)

    // Get existing events to compare
    const existingEvents = await SportEventModel.find({
        status: 'upcoming',
        startTime: { $gt: cutoffTime }
    }).lean()

    const existingByExternalId = new Map(
        existingEvents.map(e => [e.externalId, e])
    )

    let updated = 0
    let created = 0

    for (const parsed of upcoming) {
        const existing = existingByExternalId.get(parsed.externalId)

        if (existing) {
            // Update odds for existing event
            await SportEventModel.updateOne(
                { id: existing.id },
                {
                    $set: {
                        status: parsed.status,
                        ...(parsed.odds ? { odds: parsed.odds } : {}),
                        updatedAt: new Date(),
                    }
                }
            )
            updated++
            console.log(`[Casino] Updated odds for ${existing.id}: ${parsed.awayTeam} @ ${parsed.homeTeam}`)
        } else if (created < needed) {
            await SportEventModel.create({
                id: `event-${randomUUID().slice(0, 8)}`,
                externalId: parsed.externalId,
                sport: parsed.sport,
                homeTeam: parsed.homeTeam,
                awayTeam: parsed.awayTeam,
                startTime: new Date(parsed.startTime),
                status: parsed.status,
                ...(parsed.odds ? { odds: parsed.odds } : {}),
            })
            created++
            console.log(`[Casino] Created event ${parsed.externalId}: ${parsed.awayTeam} @ ${parsed.homeTeam}`)
        }
    }

    console.log(`[Casino] Sync complete: ${created} created, ${updated} odds updated.`)
    return created
}

// ─── Research ────────────────────────────────────────────────────

/**
 * Fetch and cache research for an event via Serper.
 * Progressively builds a pool of up to 10 unique research links.
 */
export async function researchEvent(eventId: string): Promise<SerperResult[]> {
    const event = await SportEventModel.findOne({ id: eventId })
    if (!event) throw new Error('Event not found')

    let existingResearch: any[] = event.research || []

    // If we already have 10 research links, there's no need to search anymore
    if (existingResearch.length >= 10) {
        return existingResearch.map((r: any) => ({
            title: r.title ?? '',
            snippet: r.snippet ?? '',
            link: r.url ?? '',
            category: r.category ?? 'stats',
            position: 0,
        }))
    }

    // Otherwise, fetch fresh research to add to the pool
    const results = await searchMatchup(event.awayTeam, event.homeTeam, event.sport)

    // Sanitize results to prevent indirect prompt injection from the web
    const { sanitizeInput } = await import('../sanitizer')
    const safeResults: SerperResult[] = []
    const existingUrls = new Set(existingResearch.map((r: any) => r.url))

    for (const r of results) {
        // Skip if we already have this link or if we reached the max of 10
        if (existingUrls.has(r.link)) continue
        if (existingResearch.length + safeResults.length >= 10) break

        try {
            // Validates against regex and LLM semantic checks
            const safeTitle = await sanitizeInput(r.title, 'system-serper')
            const safeSnippet = await sanitizeInput(r.snippet, 'system-serper')
            safeResults.push({ ...r, title: safeTitle, snippet: safeSnippet, category: r.category })
            existingUrls.add(r.link)
        } catch (err) {
            console.warn(`[Casino] Dropped search result due to injection risk: ${r.link}`)
        }
    }

    // Only update DB if we actually found new safe results
    if (safeResults.length > 0) {
        const newResearchDocs = safeResults.map((r: SerperResult) => ({
            title: r.title,
            snippet: r.snippet,
            url: r.link,
            category: r.category,
            searchedAt: new Date(),
        }))

        await SportEventModel.updateOne(
            { id: eventId },
            {
                $push: {
                    research: { $each: newResearchDocs }
                }
            }
        )

        existingResearch = [...existingResearch, ...newResearchDocs]
    }

    return existingResearch.map((r: any) => ({
        title: r.title ?? '',
        snippet: r.snippet ?? '',
        link: r.url ?? '',
        category: r.category ?? 'stats',
        position: 0,
    }))
}

// ─── Betting ─────────────────────────────────────────────────────

const BETTING_CUTOFF_MS = 30 * 60 * 1000   // Close betting 30min before event
const PLATFORM_FEE_BPS = 500               // 5% platform fee on payouts
const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
const MAX_BET_AMOUNT = 500                  // Max 500 $AGENT per bet to prevent wallet-draining

/**
 * Place a bet for an agent.
 * Tokens are transferred on-chain: Agent → Platform Treasury via BullMQ queue.
 * See ON_CHAIN_GAMES.md for the pattern.
 */
export async function placeBet(
    agentDID: string,
    eventId: string,
    pick: string,
    amount: number,
    odds: number,
    confidence?: number,
    reasoning?: string,
): Promise<{ betId: string; intentId: string }> {
    const event = await SportEventModel.findOne({ id: eventId })
    if (!event) throw new Error('Event not found')
    if (event.status === 'completed') throw new Error('Event already completed')
    if (event.status === 'locked' || event.status === 'live') throw new Error('Betting closed — event is locked or live')

    // 30-minute cutoff before event starts
    const cutoff = new Date(event.startTime.getTime() - BETTING_CUTOFF_MS)
    if (new Date() > cutoff) {
        throw new Error('Betting closed — events lock 30 minutes before start')
    }
    const agent = await AgentProfileModel.findOne({ did: agentDID })
    if (!agent) throw new Error('Agent not found')
    if (agent.status !== 'certified') throw new Error('Agent must be certified to bet')
    if (agent.tokenBalance < amount) throw new Error('Insufficient balance')
    if (amount <= 0) throw new Error('Bet amount must be positive')
    if (amount > MAX_BET_AMOUNT) throw new Error(`Bet amount exceeds maximum of ${MAX_BET_AMOUNT} $AGENT`)

    // One bet per agent per event — prevents double-betting via concurrent requests or prompt manipulation
    const existingBet = await BetModel.findOne({ agentDID, eventId, status: 'pending' }).lean()
    if (existingBet) throw new Error('Already placed a bet on this event')

    // Valid picks
    const validPicks = ['home_ml', 'away_ml', 'over', 'under', 'home_spread', 'away_spread']
    if (!validPicks.includes(pick)) throw new Error(`Invalid pick. Valid picks: ${validPicks.join(', ')}`)
    if (!event.odds) throw new Error('Event has no odds available')

    let currentOdds: number | undefined
    switch (pick) {
        case 'home_ml':
            currentOdds = event.odds.moneyline?.home ?? undefined
            break
        case 'away_ml':
            currentOdds = event.odds.moneyline?.away ?? undefined
            break
        case 'over':
        case 'under':
            currentOdds = event.odds.overUnder ?? undefined
            break
        case 'home_spread':
            // Spread odds não são armazenados como número, use moneyline como fallback
            currentOdds = event.odds.moneyline?.home ?? undefined
            break
        case 'away_spread':
            currentOdds = event.odds.moneyline?.away ?? undefined
            break
    }

    if (!currentOdds) throw new Error(`Odds not available for ${pick}`)

    // Allow 5% tolerance for odds changes
    // For American odds (can be negative), we need to handle the math correctly:
    // - Positive odds (underdog): 100 ± 5% = 95 to 105
    // - Negative odds (favorite): -100 ± 5% = -105 to -95 (note the inversion!)
    const tolerance = 0.05
    const absCurrentOdds = Math.abs(currentOdds)
    const absTolerance = absCurrentOdds * tolerance

    let minOdds: number, maxOdds: number
    if (currentOdds >= 0) {
        // Positive odds: normal range
        minOdds = currentOdds - absTolerance
        maxOdds = currentOdds + absTolerance
    } else {
        // Negative odds: inverted range (more negative = lower)
        minOdds = currentOdds - absTolerance  // More negative (lower)
        maxOdds = currentOdds + absTolerance  // Less negative (higher)
    }

    if (odds < minOdds || odds > maxOdds) {
        // Log the validation failure for debugging
        if (process.env.DEBUG === 'true') {
            console.log(`[Casino] Odds validation failed: submitted=${odds}, current=${currentOdds}, range=[${minOdds.toFixed(2)}, ${maxOdds.toFixed(2)}]`)
        }
        throw new Error(
            `Odds mismatch: you submitted ${odds.toFixed(2)} but current odds are ${currentOdds.toFixed(2)}. ` +
            `Please refresh and try again.`
        )
    }

    // Use current odds from event (not submitted odds) to prevent manipulation
    const validatedOdds = currentOdds

    // On-chain transfer: Agent → Platform Treasury (non-blocking via BullMQ)
    const { intentId } = await createTransactionIntent(
        agentDID,
        PLATFORM_DID,
        amount,
        'bet_place',
        eventId
    )
    const betId = `bet-${randomUUID().slice(0, 8)}`
    await BetModel.create({
        id: betId,
        agentDID,
        eventId,
        pick,
        amount,
        odds: validatedOdds, // Use server-validated odds, not client-submitted
        confidence,
        reasoning,
        status: 'pending',
        transactionIntentId: intentId,
    })

    // Broadcast the action to the frontend live feed
    try {
        const { broadcastEvent } = await import('../../routes/ws')
        broadcastEvent('place_bet', {
            agentDID,
            eventId,
            pick,
            amount,
            odds: validatedOdds,
            status: 'pending',
            timestamp: new Date().toISOString()
        })
    } catch (e) {
        console.error('[Casino] Failed to broadcast place_bet', e)
    }

    // Update event stats
    await SportEventModel.updateOne(
        { id: eventId },
        { $inc: { totalBets: 1, totalWagered: amount } }
    )

    console.log(`[Casino] ${agentDID.slice(0, 20)}... bet ${amount} $AGENT on ${pick} @ ${validatedOdds.toFixed(2)} for ${eventId} (tx: ${intentId.slice(0, 8)}...)`)
    return { betId, intentId }
}

/**
 * Calculate payout for American odds
 * -150 means bet 150 to win 100 (payout = stake + 100)
 * +130 means bet 100 to win 130 (payout = stake + 130)
 */
function calculatePayout(stake: number, americanOdds: number): number {
    if (americanOdds > 0) {
        return stake + (stake * americanOdds / 100)
    } else {
        return stake + (stake * 100 / Math.abs(americanOdds))
    }
}

/**
 * Resolve all bets for a completed event.
 * Winning payouts are transferred on-chain: Platform Treasury → Winner via BullMQ queue.
 * Platform takes 5% fee. Reputation changes are direct MongoDB updates.
 */
export async function resolveEvent(eventId: string, winner: 'home' | 'away' | 'draw', homeScore?: number, awayScore?: number): Promise<{ resolved: number; totalPayout: number }> {
    const event = await SportEventModel.findOne({ id: eventId })
    if (!event) throw new Error('Event not found')

    // Update event
    await SportEventModel.updateOne(
        { id: eventId },
        {
            $set: {
                status: 'completed',
                'result.winner': winner,
                ...(homeScore !== undefined ? { 'result.homeScore': homeScore } : {}),
                ...(awayScore !== undefined ? { 'result.awayScore': awayScore } : {}),
                updatedAt: new Date(),
            }
        }
    )

    // Determine winning picks
    const totalPoints = (homeScore ?? 0) + (awayScore ?? 0)
    const winningPicks: string[] = []

    if (winner === 'home') {
        winningPicks.push('home_ml', 'home_spread')
    } else if (winner === 'away') {
        winningPicks.push('away_ml', 'away_spread')
    }

    if (event.odds?.overUnder) {
        if (totalPoints > event.odds.overUnder) {
            winningPicks.push('over')
        } else if (totalPoints < event.odds.overUnder) {
            winningPicks.push('under')
        } else {
            // Exact total = line → push: both over and under bets are refunded
            winningPicks.push('over', 'under')
        }
    }

    // Resolve bets
    const pendingBets = await BetModel.find({ eventId, status: 'pending' })
    let resolved = 0
    let totalPayout = 0

    for (const bet of pendingBets) {
        const won = winningPicks.includes(bet.pick)
        const grossPayout = won ? calculatePayout(bet.amount, bet.odds) : 0
        const fee = won ? Math.floor(grossPayout * PLATFORM_FEE_BPS / 10000) : 0
        const netPayout = grossPayout - fee

        await BetModel.updateOne(
            { id: bet.id },
            {
                $set: {
                    status: won ? 'won' : 'lost',
                    payout: won ? netPayout : 0,
                    resolvedAt: new Date(),
                }
            }
        )

        if (won && netPayout > 0) {
            // On-chain transfer: Platform Treasury → Winner (non-blocking via BullMQ)
            try {
                await createTransactionIntent(
                    PLATFORM_DID,
                    bet.agentDID,
                    netPayout,
                    'bet_payout',
                    eventId
                )
            } catch (err) {
                console.error(`[Casino] Failed to create payout intent for bet ${bet.id}:`, (err as Error).message)
                // Payout intent failed — manual resolution needed
            }

            // Reputation boost for winning (direct, not monetary)
            await AgentProfileModel.updateOne(
                { did: bet.agentDID },
                { $inc: { reputationScore: 10 } }
            )
            totalPayout += netPayout
        } else {
            // Reputation penalty for loss (direct, not monetary)
            await AgentProfileModel.updateOne(
                { did: bet.agentDID },
                { $inc: { reputationScore: -5 } }
            )
        }

        resolved++
    }

    console.log(`[Casino] Resolved ${resolved} bets for event ${eventId}, total payout: ${totalPayout} $AGENT (fee retained: ${Math.floor(totalPayout * PLATFORM_FEE_BPS / 10000)})`)
    return { resolved, totalPayout }
}

// ─── Queries ─────────────────────────────────────────────────────

export async function getEvents(filters?: { sport?: string; status?: string }): Promise<any[]> {
    const query: Record<string, any> = {}
    if (filters?.sport && filters.sport !== 'All') query.sport = filters.sport
    if (filters?.status) {
        if (filters.status.includes(',')) {
            query.status = { $in: filters.status.split(',') }
        } else {
            query.status = filters.status
        }
    }

    return SportEventModel.find(query)
        .sort({ startTime: 1 })
        .limit(50)
        .lean()
}

export async function getEventDetail(eventId: string): Promise<any> {
    const event = await SportEventModel.findOne({ id: eventId }).lean()
    if (!event) return null

    const bets = await BetModel.find({ eventId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean()

    // Enrich bets with agent names
    const enrichedBets = await Promise.all(bets.map(async (bet: any) => {
        const agent = await AgentProfileModel.findOne({ did: bet.agentDID, deletedAt: { $exists: false } }).select('did modelBase category').lean()
        return { ...bet, agent }
    }))

    return { ...event, bets: enrichedBets }
}

export async function getAgentBets(agentDID: string, limit = 20): Promise<any[]> {
    const bets = await BetModel.find({ agentDID })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean()

    // Enrich with agent and event info
    return Promise.all(bets.map(async (bet: any) => {
        const agentData = await AgentProfileModel.findOne({ did: bet.agentDID }).select('did name modelBase category').lean()
        const event = await SportEventModel.findOne({ id: bet.eventId }).select('homeTeam awayTeam sport status').lean()

        // Map to frontend convention (agentName instead of name)
        const agent = agentData ? {
            ...agentData,
            agentName: agentData.name
        } : undefined

        return { ...bet, agent, event }
    }))
}

export async function getLeaderboard(limit = 20): Promise<any[]> {
    // Aggregate by agent: total bets, wins, losses, net profit
    const results = await BetModel.aggregate([
        { $match: { status: { $in: ['won', 'lost'] } } },
        {
            $group: {
                _id: '$agentDID',
                totalBets: { $sum: 1 },
                wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
                losses: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
                totalWagered: { $sum: '$amount' },
                totalPayout: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, '$payout', 0] } },
            }
        },
        {
            $addFields: {
                netProfit: { $subtract: ['$totalPayout', '$totalWagered'] },
            }
        },
        { $sort: { netProfit: -1 } },
        { $limit: limit },
    ])

    // Enrich with agent info
    return Promise.all(results.map(async (r: any) => {
        const agentData = await AgentProfileModel.findOne({ did: r._id }).select('did name modelBase category').lean()

        // Map to frontend convention (agentName instead of name)
        const agent = agentData ? {
            ...agentData,
            agentName: agentData.name
        } : undefined

        return { ...r, agentDID: r._id, agent }
    }))
}

export async function getCasinoStats(): Promise<{
    totalWagered: number
    activeBettors: number
    betsToday: number
    activeEvents: number
}> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const [totalWagered, activeBettors, betsToday, activeEvents] = await Promise.all([
        BetModel.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]).then((r: any[]) => r[0]?.total ?? 0),
        BetModel.distinct('agentDID').then((r: string[]) => r.length),
        BetModel.countDocuments({ createdAt: { $gte: todayStart } }),
        SportEventModel.countDocuments({ status: { $in: ['upcoming', 'locked', 'live'] } }),
    ])

    return { totalWagered, activeBettors, betsToday, activeEvents }
}
