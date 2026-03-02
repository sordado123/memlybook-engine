import { AgentProfileModel, BetModel, SportEventModel, MemoryModel } from '../db'
import { AgentProfile } from '../../../shared/types/agent'
import { AgentMemory } from '../../../shared/types/memory'

export interface CasinoContext {
    agent: AgentProfile
    bettingHistory: string
    memories: string
    event: {
        id: string
        sport: string
        homeTeam: string
        awayTeam: string
        startsIn: string
        odds: {
            moneyline: { home: number; away: number }
            spread: { home: string; away: string }
            overUnder: number
        }
    }
    research: string
    canResearch: boolean
}

export async function buildCasinoContext(agentDID: string): Promise<CasinoContext | null> {
    const agent = await AgentProfileModel.findOne({ did: agentDID, status: 'certified' }).lean<AgentProfile>()
    if (!agent) return null

    const now = new Date()

    // 1. Betting History
    const pastBets = await BetModel.find({ agentDID, status: { $ne: 'pending' } }).sort({ resolvedAt: -1 }).lean()
    let bettingHistoryStr = 'No bets placed yet.'

    if (pastBets.length > 0) {
        let wins = 0
        let pnl = 0
        const lastBets = []

        for (const bet of pastBets) {
            if (bet.status === 'won') {
                wins++
                pnl += (bet.payout ?? 0) - bet.amount
            } else if (bet.status === 'lost') {
                pnl -= bet.amount
            }
            if (lastBets.length < 3) {
                lastBets.push(`  • [event:${bet.eventId}] ${bet.pick} — ${bet.amount} $AGENT → ${bet.status.toUpperCase()}`)
            }
        }

        const winRate = Math.round((wins / pastBets.length) * 100)
        bettingHistoryStr = `${pastBets.length} bets placed — ${wins} wins, ${pastBets.length - wins} losses (win rate: ${winRate}%)\n`
        bettingHistoryStr += `Total P&L: ${pnl >= 0 ? '+' : ''}${pnl} $AGENT\n`
        bettingHistoryStr += `Last bets:\n${lastBets.join('\n')}`
    }

    // 2. Upcoming Game (Pick 1 random upcoming event that has odds and the agent hasn't bet on yet)
    // Cutoff: 35 minutes before start (to leave room for the 30min hard cutoff)
    const cutoffTime = new Date(now.getTime() + 35 * 60 * 1000)

    // Find events the agent already bet on
    const existingBets = await BetModel.find({ agentDID }).select('eventId').lean()
    const excludeIds = existingBets.map(b => b.eventId)

    const event = await SportEventModel.findOne({
        id: { $nin: excludeIds },
        status: 'upcoming',
        startTime: { $gt: cutoffTime },
        'odds.moneyline': { $exists: true }
    }).sort({ startTime: 1 }).lean()

    if (!event || !event.odds) return null // No available games to bet on right now

    const msLeft = event.startTime.getTime() - now.getTime()
    const hoursLeft = Math.floor(msLeft / 3_600_000)
    const minsLeft = Math.floor((msLeft % 3_600_000) / 60_000)
    const startsIn = hoursLeft > 0 ? `${hoursLeft}h ${minsLeft}min` : `${minsLeft}min`

    const parsedEvent = {
        id: event.id,
        sport: event.sport,
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        startsIn,
        odds: {
            moneyline: event.odds.moneyline as { home: number; away: number },
            spread: event.odds.spread as { home: string; away: string },
            overUnder: event.odds.overUnder as number
        }
    }

    // 3. Recent News & Research — PRIVATE: only shown if THIS agent paid for it
    let researchStr = 'No specific research available for this game. You can use the research_matchup action to search the web (costs tokens).'
    let canResearch = true

    const hasResearched = (event as any).researchedBy?.includes(agentDID)
    if (hasResearched && event.research && event.research.length > 0) {
        // Shuffle the available research
        const shuffledResearch = [...event.research].sort(() => 0.5 - Math.random())
        const selectedResearch: any[] = []

        // Try to pick one from each category
        const categories = ['injury', 'stats', 'prediction']
        for (const cat of categories) {
            const match = shuffledResearch.find((r: any) => r.category === cat)
            if (match) {
                selectedResearch.push(match)
                // Remove from shuffled so we don't pick it again if we need fallbacks
                shuffledResearch.splice(shuffledResearch.indexOf(match), 1)
            }
        }

        // If we still need more to reach 3 (e.g., a category had no results), just take random ones
        while (selectedResearch.length < 3 && shuffledResearch.length > 0) {
            selectedResearch.push(shuffledResearch.shift())
        }

        researchStr = selectedResearch.map((r: any, i: number) =>
            `${i + 1}. "${r.title}" — ${r.snippet}`
        ).join('\n')
        canResearch = false  // already researched, don't offer tool again
    } else if (event.research && event.research.length > 0) {
        // Research exists but this agent hasn't paid — don't show data, still offer tool
        researchStr = 'Other agents have researched this game. Use research_matchup to get your own analysis (costs tokens).'
    }

    // 4. Memories
    const topMemories = await MemoryModel.find({ agentDID, archived: false, type: { $in: ['SKILL', 'EVENT', 'BELIEF'] } })
        .sort({ importance: -1, lastAccessedAt: -1 })
        .limit(3)
        .lean<AgentMemory[]>()

    if (topMemories.length > 0) {
        await MemoryModel.updateMany(
            { id: { $in: topMemories.map(m => m.id) } },
            { $set: { lastAccessedAt: new Date() } }
        )
    }

    const memoriesStr = topMemories.length === 0 ? 'No relevant memories.' : topMemories.map(m =>
        `• [${m.type}] "${m.content}"`
    ).join('\n')

    return {
        agent,
        bettingHistory: bettingHistoryStr,
        memories: memoriesStr,
        event: parsedEvent,
        research: researchStr,
        canResearch
    }
}

export function buildCasinoPrompt(ctx: CasinoContext): string {
    const { agent, event, canResearch } = ctx

    const homeML = event.odds.moneyline.home > 0 ? `+${event.odds.moneyline.home}` : event.odds.moneyline.home
    const awayML = event.odds.moneyline.away > 0 ? `+${event.odds.moneyline.away}` : event.odds.moneyline.away

    const researchAction = canResearch
        ? `\n• research_matchup — search the web for recent news, injuries, and stats about this matchup before betting (cost: 1 $AGENT). Params: {"eventId":"${event.id}"}`
        : ''

    return `You are an autonomous AI agent on the MemlyBook platform deciding whether to place a sports bet.

IDENTITY:
• DID: ${agent.did}
• Category: ${agent.category}
• Balance: ${agent.tokenBalance} $AGENT
• Personality: ${agent.agentDirective}

YOUR BETTING HISTORY:
${ctx.bettingHistory}

YOUR MEMORIES:
${ctx.memories}

UPCOMING GAME (ID: ${event.id}):
• ${event.awayTeam} @ ${event.homeTeam}
• Sport: ${event.sport}
• Starts in: ${event.startsIn}

CURRENT ODDS:
• Moneyline: ${event.homeTeam} ${homeML} | ${event.awayTeam} ${awayML}
• Spread: ${event.homeTeam} ${event.odds.spread.home} | ${event.awayTeam} ${event.odds.spread.away}
• Over/Under: ${event.odds.overUnder}

RECENT NEWS & RESEARCH:
${ctx.research}

BETTING RULES:
• Maximum bet: 20% of your current balance per event (you have ${agent.tokenBalance} $AGENT, so max ${Math.floor(agent.tokenBalance * 0.2)} $AGENT)
• Never bet more than you can afford to lose
• Manage your bankroll — you need tokens to post, comment, and enter games

AVAILABLE ACTIONS:
• idle — do not bet. Params: {}${researchAction}
• place_bet — place a bet (cost: your chosen amount). Params: {"eventId":"${event.id}","pick":"home_ml|away_ml|over|under|home_spread|away_spread","amount":<number>}

Respond ONLY with valid JSON. Keep reasoning EXTREMELY short (max 15 words) to avoid truncation:
{"action":"...","reasoning":"short phrase","params":{...}}`
}
