/**
 * Serper API Client (Google Search)
 * 
 * Free: 2500 credits on signup
 * Base URL: https://google.serper.dev/search
 * Auth: X-API-KEY header
 */

const SERPER_URL = 'https://google.serper.dev/search'

function getApiKey(): string {
    const key = process.env.SERPER_API_KEY
    if (!key) throw new Error('SERPER_API_KEY is not set')
    return key
}

// ─── Types ───────────────────────────────────────────────────────

export interface SerperResult {
    title: string
    link: string
    snippet: string
    date?: string
    position: number
    category?: string // 'injury', 'stats', or 'prediction'
}

export interface SerperResponse {
    organic: SerperResult[]
    searchParameters: { q: string }
}

// ─── API Functions ───────────────────────────────────────────────

/**
 * Raw Google search via Serper
 */
async function search(query: string, numResults = 5): Promise<SerperResult[]> {
    try {
        const res = await fetch(SERPER_URL, {
            method: 'POST',
            headers: {
                'X-API-KEY': getApiKey(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                q: query,
                num: numResults,
            }),
        })

        if (!res.ok) {
            const body = await res.text().catch(() => 'no body')
            throw new Error(`Serper API error ${res.status}: ${body}`)
        }

        const data = await res.json() as SerperResponse
        return data.organic ?? []
    } catch (err) {
        console.error('[Serper] search error:', (err as Error).message)
        return []
    }
}

/**
 * Search for a matchup between two teams
 * Returns combined results from multiple search angles
 */
export async function searchMatchup(
    teamA: string,
    teamB: string,
    sport: string
): Promise<SerperResult[]> {
    // Run searches in parallel for different angles
    const [injury, stats, prediction] = await Promise.all([
        search(`${teamA} vs ${teamB} ${sport} injury report ${new Date().getFullYear()}`, 5),
        search(`${teamA} vs ${teamB} ${sport} head to head stats`, 5),
        search(`${teamA} vs ${teamB} ${sport} prediction analysis`, 5),
    ])

    // Assign categories to results
    injury.forEach(r => r.category = 'injury')
    stats.forEach(r => r.category = 'stats')
    prediction.forEach(r => r.category = 'prediction')

    // Deduplicate by link
    const seen = new Set<string>()
    const results: SerperResult[] = []

    for (const r of [...injury, ...stats, ...prediction]) {
        if (!seen.has(r.link)) {
            seen.add(r.link)
            results.push(r)
        }
    }

    return results.slice(0, 15) // Top 15 unique
}

/**
 * Search info about a specific team
 */
export async function searchTeam(team: string, sport: string): Promise<SerperResult[]> {
    return search(`${team} ${sport} season ${new Date().getFullYear()} roster stats`)
}

/**
 * Generic sports news search
 */
export async function searchSportsNews(sport: string): Promise<SerperResult[]> {
    return search(`${sport} latest news today ${new Date().getFullYear()}`)
}
