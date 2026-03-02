/**
 * Odds-API.io Client — Sports Betting Data
 *
 * Replaces SportsGameOdds with odds-api.io v3.
 * Free tier: 100 req/hr
 * Bookmaker: Bet365
 * 
 * Whitelisted leagues (majors only):
 *   Basketball: NBA | Am. Football: NFL | Baseball: MLB | Hockey: NHL
 *   Football: Premier League, La Liga, Champions League
 */

const BASE_URL = 'https://api.odds-api.io/v3'
const BOOKMAKER = 'Bet365'

function getApiKey(): string {
    const key = process.env.ODDS_API_KEY
    if (!key) throw new Error('ODDS_API_KEY is not set')
    return key
}

// ── Whitelisted Leagues ──────────────────────────────────────────

interface LeagueConfig {
    sport: string       // API sport slug
    league: string      // API league slug
    displaySport: string // Friendly name for UI
}

const LEAGUES: LeagueConfig[] = [
    { sport: 'basketball', league: 'usa-nba', displaySport: 'NBA' },
    { sport: 'american-football', league: 'usa-nfl', displaySport: 'NFL' },
    { sport: 'baseball', league: 'usa-mlb', displaySport: 'MLB' },
    { sport: 'ice-hockey', league: 'usa-nhl', displaySport: 'NHL' },
    { sport: 'football', league: 'england-premier-league', displaySport: 'Premier League' },
    { sport: 'football', league: 'spain-laliga', displaySport: 'La Liga' },
    { sport: 'football', league: 'germany-bundesliga', displaySport: 'Bundesliga' },
]

// ── API Fetch ────────────────────────────────────────────────────

async function apiFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`)
    url.searchParams.set('apiKey', getApiKey())
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, v)
        }
    }

    const res = await fetch(url.toString(), {
        headers: { 'Accept': 'application/json' },
    })

    if (!res.ok) {
        const body = await res.text().catch(() => 'no body')
        throw new Error(`OddsAPI error ${res.status}: ${body}`)
    }

    return res.json() as Promise<T>
}

// ── API Response Types ───────────────────────────────────────────

interface OddsApiEvent {
    id: number
    home: string
    away: string
    homeId: number
    awayId: number
    date: string           // ISO 8601
    status: string         // "pending" | "live" | "settled"
    league: { name: string; slug: string }
    sport: { name: string; slug: string }
    scores?: { home: number; away: number }
}

interface OddsApiMarket {
    name: string           // "ML", "Spread", "Totals"
    updatedAt: string
    odds: OddsApiOddEntry[]
}

interface OddsApiOddEntry {
    home?: string          // ML decimal odds
    away?: string
    hdp?: number           // Handicap / total line
    over?: string          // Totals
    under?: string
}

interface OddsApiOddsResponse {
    id: number
    home: string
    away: string
    date: string
    status: string
    league: { name: string; slug: string }
    sport: { name: string; slug: string }
    bookmakers: Record<string, OddsApiMarket[]>
}

// ── Parsed Types (same interface as before) ──────────────────────

export interface ParsedEvent {
    externalId: string
    sport: string
    homeTeam: string
    awayTeam: string
    startTime: string
    status: 'upcoming' | 'live' | 'completed'
    odds?: {
        moneyline: { home: number; away: number }
        spread: { home: string; away: string }
        overUnder: number
    }
    scores?: { home: number; away: number }
}

// ── Mappers ──────────────────────────────────────────────────────

function mapStatus(apiStatus: string): 'upcoming' | 'live' | 'completed' {
    switch (apiStatus) {
        case 'pending': return 'upcoming'
        case 'live': return 'live'
        case 'settled': return 'completed'
        default: return 'upcoming'
    }
}

/** Convert decimal odds to American odds */
function decimalToAmerican(decimal: number): number {
    if (decimal >= 2.0) {
        return Math.round((decimal - 1) * 100)   // +130
    } else {
        return Math.round(-100 / (decimal - 1))   // -150
    }
}

function parseOddsFromBet365(markets: OddsApiMarket[]): ParsedEvent['odds'] | undefined {
    let homeML = 0, awayML = 0
    let homeSpread = 'N/A', awaySpread = 'N/A'
    let overUnder = 0

    for (const market of markets) {
        if (market.name === 'ML' && market.odds[0]) {
            const o = market.odds[0]
            homeML = decimalToAmerican(parseFloat(o.home ?? '0'))
            awayML = decimalToAmerican(parseFloat(o.away ?? '0'))
        }
        if (market.name === 'Spread' && market.odds[0]) {
            const o = market.odds[0]
            const hdp = o.hdp ?? 0
            homeSpread = hdp >= 0 ? `+${hdp}` : `${hdp}`
            awaySpread = hdp >= 0 ? `${-hdp}` : `+${-hdp}`
        }
        if (market.name === 'Totals' && market.odds[0]) {
            overUnder = market.odds[0].hdp ?? 0
        }
    }

    if (homeML === 0 && awayML === 0) return undefined

    return {
        moneyline: { home: homeML, away: awayML },
        spread: { home: homeSpread, away: awaySpread },
        overUnder,
    }
}

function findDisplaySport(leagueSlug: string): string {
    return LEAGUES.find(l => l.league === leagueSlug)?.displaySport ?? 'Other'
}

function parseEvent(ev: OddsApiEvent): ParsedEvent {
    return {
        externalId: String(ev.id),
        sport: findDisplaySport(ev.league.slug),
        homeTeam: ev.home,
        awayTeam: ev.away,
        startTime: ev.date,
        status: mapStatus(ev.status),
        scores: ev.scores,
    }
}

// ── API Functions ────────────────────────────────────────────────

/**
 * Fetch upcoming events from whitelisted leagues with odds.
 * Strategy: 5 soonest events across all leagues, max 2 per sport.
 * Uses ~7 requests (1 per league) + 1 per event for odds = ~12 requests max.
 */
export async function fetchUpcomingEvents(limit: number = 5): Promise<ParsedEvent[]> {
    if (limit <= 0) return []

    const allEvents: (ParsedEvent & { _bet365Markets?: OddsApiMarket[] })[] = []

    for (const cfg of LEAGUES) {
        try {
            const events = await apiFetch<OddsApiEvent[]>('/events', {
                sport: cfg.sport,
                league: cfg.league,
                status: 'pending',
                limit: '5',
            })

            for (const ev of events) {
                allEvents.push(parseEvent(ev))
            }
        } catch (err) {
            console.error(`[OddsAPI] Error fetching ${cfg.displaySport}:`, (err as Error).message)
        }
    }

    // Sort by soonest, filter within 24h window
    const now = Date.now()
    const cutoff = now + 30 * 60 * 1000     // 30min from now
    const maxTime = now + 48 * 60 * 60 * 1000 // 48h window

    const filtered = allEvents
        .filter(e => {
            const t = new Date(e.startTime).getTime()
            return t > cutoff && t < maxTime
        })
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

    // Max 2 per sport for variety
    const sportCount = new Map<string, number>()
    const selected: ParsedEvent[] = []

    for (const ev of filtered) {
        if (selected.length >= limit) break
        const count = sportCount.get(ev.sport) ?? 0
        if (count >= 2) continue
        sportCount.set(ev.sport, count + 1)
        selected.push(ev)
    }

    // Fetch Bet365 odds for selected events (1 request each)
    for (const ev of selected) {
        try {
            const oddsResp = await apiFetch<OddsApiOddsResponse>('/odds', {
                eventId: ev.externalId,
                bookmakers: BOOKMAKER,
            })
            // Find Bet365 markets (might be "Bet365" or "Bet365 (no latency)")
            const bet365Key = Object.keys(oddsResp.bookmakers || {}).find(k => k.includes('Bet365'))
            if (bet365Key) {
                ev.odds = parseOddsFromBet365(oddsResp.bookmakers[bet365Key])
            }
        } catch (err) {
            console.error(`[OddsAPI] Error fetching odds for ${ev.externalId}:`, (err as Error).message)
        }
    }

    return selected
}

/**
 * Fetch a single event by its external ID to check status/scores.
 * Note: odds-api.io events endpoint doesn't filter by ID directly,
 * so we search settled events from the event's league.
 */
export async function fetchEvent(externalId: string): Promise<ParsedEvent | null> {
    // We need the sport to query — try each league
    for (const cfg of LEAGUES) {
        try {
            const events = await apiFetch<OddsApiEvent[]>('/events', {
                sport: cfg.sport,
                league: cfg.league,
                status: 'settled',
                limit: '20',
            })
            const match = events.find(e => String(e.id) === externalId)
            if (match) return parseEvent(match)
        } catch {
            // Skip — try next league
        }
    }
    return null
}

/**
 * Fetch recently settled events across all whitelisted leagues.
 * Used by worker to auto-resolve events.
 */
export async function fetchSettledEvents(): Promise<ParsedEvent[]> {
    const settled: ParsedEvent[] = []

    for (const cfg of LEAGUES) {
        try {
            const events = await apiFetch<OddsApiEvent[]>('/events', {
                sport: cfg.sport,
                league: cfg.league,
                status: 'settled',
                limit: '10',
            })
            settled.push(...events.map(parseEvent))
        } catch (err) {
            console.error(`[OddsAPI] Error fetching settled ${cfg.displaySport}:`, (err as Error).message)
        }
    }

    return settled
}

/**
 * Fetch live events (for status checking only — no betting on live).
 */
export async function fetchLiveEvents(): Promise<ParsedEvent[]> {
    const live: ParsedEvent[] = []

    for (const cfg of LEAGUES) {
        try {
            const events = await apiFetch<OddsApiEvent[]>('/events', {
                sport: cfg.sport,
                league: cfg.league,
                status: 'live',
                limit: '10',
            })
            live.push(...events.map(parseEvent))
        } catch {
            // Skip
        }
    }

    return live
}

/**
 * Fetch odds for a specific event (used by event detail page).
 */
export async function fetchEventOdds(eventId: string): Promise<ParsedEvent['odds'] | undefined> {
    try {
        const oddsResp = await apiFetch<OddsApiOddsResponse>('/odds', {
            eventId,
            bookmakers: BOOKMAKER,
        })
        const bet365Key = Object.keys(oddsResp.bookmakers || {}).find(k => k.includes('Bet365'))
        if (bet365Key) {
            return parseOddsFromBet365(oddsResp.bookmakers[bet365Key])
        }
    } catch (err) {
        console.error(`[OddsAPI] fetchEventOdds error:`, (err as Error).message)
    }
    return undefined
}

/**
 * Fetch completed events (alias for backward compat).
 */
export async function fetchCompletedEvents(): Promise<ParsedEvent[]> {
    return fetchSettledEvents()
}
