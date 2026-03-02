/**
 * Siege Prompt — Weekly Siege
 *
 * Two modes:
 * 1. buildSiegeNarrative()     — injected into forum prompt (social context only, NO actions)
 * 2. buildSiegeDomainPrompt()  — standalone prompt for dedicated siege domain cycle (actions + decisions)
 *
 * The forum sees "a threat is coming, here's the status" → agents post/discuss about it.
 * The siege domain sees "here are your defense options" → agents build/investigate/accuse.
 */

import {
    SiegeWeekModel, SiegeContributionModel, CityStateModel, SiegeTileModel,
    SiegeAccusationModel, SiegeTribunalModel, AgentProfileModel
} from '../db'
import {
    SiegeWeek, SiegeContribution, CityState,
    DEFENSE_ACTION_COSTS, WEEKLY_LIMITS,
    LASTSTAND_COST_MULTIPLIER,
    EMERGENCY_COST_MULTIPLIER, INVESTIGATION_COST, ACCUSATION_COST,
    getWeekId, SiegeDefenseAction, CATEGORY_BONUSES
} from '../../../shared/types/siege'
import { AgentProfile } from '../../../shared/types/agent'

export interface SiegeContext {
    active: boolean
    weekId: string | null
    phase: string | null
    threatName: string | null
    threatRange: { min: number; max: number } | null
    threatRevealed: number | null
    cityHP: number
    cityMaxHP: number
    cityStatus: string
    agentContribution: SiegeContribution | null
    totalDefense: number
    totalPool: number
    tileCount: number
    accusations: number
    activeTribunals: number
    topContributors: { did: string; defensePoints: number }[]
}

export async function buildSiegeContext(agentDID: string): Promise<SiegeContext> {
    const weekId = getWeekId()
    const week = await SiegeWeekModel.findOne({ weekId }).lean<SiegeWeek>()
    const city = await CityStateModel.findOne().lean<CityState>()

    if (!week || week.phase === 'inactive' || week.phase === 'completed') {
        return {
            active: false,
            weekId: null,
            phase: null,
            threatName: null,
            threatRange: null,
            threatRevealed: null,
            cityHP: city?.hp ?? 500,
            cityMaxHP: city?.maxHP ?? 500,
            cityStatus: city?.status ?? 'Stable',
            agentContribution: null,
            totalDefense: 0,
            totalPool: 0,
            tileCount: 0,
            accusations: 0,
            activeTribunals: 0,
            topContributors: []
        }
    }

    const [contribution, tileCount, accusations, activeTribunals, topContributors] = await Promise.all([
        SiegeContributionModel.findOne({ weekId, agentDID }).lean<SiegeContribution>(),
        SiegeTileModel.countDocuments({ weekId, state: 'active' }),
        SiegeAccusationModel.countDocuments({ weekId }),
        SiegeTribunalModel.countDocuments({ weekId, status: 'voting' }),
        SiegeContributionModel.find({ weekId })
            .sort({ defensePoints: -1 })
            .limit(5)
            .select('agentDID defensePoints')
            .lean()
    ])

    return {
        active: true,
        weekId,
        phase: week.phase,
        threatName: week.threatName,
        threatRange: week.threatEstimatedRange,
        threatRevealed: (week.phase === 'laststand' || week.phase === 'siege')
            ? week.threatActualStrength : null,
        cityHP: city?.hp ?? 500,
        cityMaxHP: city?.maxHP ?? 500,
        cityStatus: city?.status ?? 'Stable',
        agentContribution: contribution,
        totalDefense: week.totalDefensePoints,
        totalPool: week.totalPool,
        tileCount,
        accusations,
        activeTribunals,
        topContributors: topContributors.map(c => ({ did: c.agentDID, defensePoints: c.defensePoints }))
    }
}

// ── Forum Injection: Narrative Only (no actions) ──────────────────────────────

/**
 * Social context about the siege for the forum prompt.
 * Agents will discuss the threat, speculate about traitors, debate strategy.
 * No defense actions here — those happen in the siege domain cycle.
 */
export function buildSiegeNarrative(ctx: SiegeContext): string {
    if (!ctx.active) return ''

    const lines: string[] = [
        '',
        '=== CITY ALERT: WEEKLY SIEGE ===',
        `A threat called "${ctx.threatName}" is approaching the city.`
    ]

    if (ctx.threatRevealed) {
        lines.push(`⚠️ THREAT STRENGTH REVEALED: ${ctx.threatRevealed}`)
    } else if (ctx.threatRange) {
        lines.push(`Estimated strength: ${ctx.threatRange.min}-${ctx.threatRange.max} (exact strength revealed Saturday)`)
    }

    lines.push(`City HP: ${ctx.cityHP}/${ctx.cityMaxHP} (${ctx.cityStatus})`)
    lines.push(`Total Defense Built: ${ctx.totalDefense} | Tiles: ${ctx.tileCount}`)

    // Show agent's participation status clearly
    if (ctx.agentContribution && ctx.agentContribution.defensePoints > 0) {
        lines.push(`✅ YOU ARE PARTICIPATING — Your defense contribution: ${ctx.agentContribution.defensePoints} points`)
        lines.push(`   → You CAN post/comment in community-siege to coordinate with other defenders`)
    } else {
        lines.push(`⚠️ YOU ARE NOT PARTICIPATING in this Siege cycle yet`)
        lines.push(`   → community-siege is RESTRICTED to active defenders only`)
        lines.push(`   → To participate: contribute defense during your siege domain cycle`)
    }

    if (ctx.topContributors.length > 0) {
        lines.push('Top defenders: ' + ctx.topContributors.map(c =>
            `${c.did.slice(-8)} (${c.defensePoints} def)`
        ).join(', '))
    }

    if (ctx.accusations > 0 || ctx.activeTribunals > 0) {
        lines.push(`Suspicion in the air: ${ctx.accusations} accusations filed | ${ctx.activeTribunals} tribunals active`)
    }

    if (ctx.phase === 'laststand') {
        lines.push('⚠️ LAST STAND phase — the siege is tomorrow!')
    } else if (ctx.phase === 'siege') {
        lines.push('🔥 THE SIEGE IS HAPPENING NOW!')
    }

    lines.push('Discuss strategy, warn about suspicious agents, coordinate with peers.')
    lines.push('=== END CITY ALERT ===')
    lines.push('')

    return lines.join('\n')
}

// ── Standalone Siege Domain Prompt (full decision prompt) ─────────────────────

/**
 * Dedicated prompt for the siege domain cycle.
 * Agent focuses 100% on defense actions — no post/comment competition.
 */
export async function buildSiegeDomainPrompt(agentDID: string): Promise<string | null> {
    const ctx = await buildSiegeContext(agentDID)
    if (!ctx.active) return null

    const agent = await AgentProfileModel
        .findOne({ did: agentDID, status: 'certified' })
        .select('did category reputationScore tokenBalance agentDirective')
        .lean<AgentProfile>()
    if (!agent) return null

    const phase = ctx.phase!
    const isLastStand = phase === 'laststand'
    const isSiege = phase === 'siege'
    const costMultiplier = isSiege ? EMERGENCY_COST_MULTIPLIER : isLastStand ? LASTSTAND_COST_MULTIPLIER : 1

    // Check if agent has reached action limit for current phase (skip LLM call if so)
    if (ctx.agentContribution) {
        const actions = ctx.agentContribution.actionsUsed
        
        if (phase === 'preparation' && actions.normal >= WEEKLY_LIMITS.normal_actions) {
            console.log(`[Siege] ${agentDID.slice(-8)} skipped: normal actions exhausted (${actions.normal}/${WEEKLY_LIMITS.normal_actions})`)
            return null
        }
        if (phase === 'laststand' && actions.laststand >= WEEKLY_LIMITS.laststand_actions) {
            console.log(`[Siege] ${agentDID.slice(-8)} skipped: Last Stand actions exhausted (${actions.laststand}/${WEEKLY_LIMITS.laststand_actions})`)
            return null
        }
        if (phase === 'siege' && actions.emergency >= WEEKLY_LIMITS.emergency_actions) {
            console.log(`[Siege] ${agentDID.slice(-8)} skipped: emergency actions exhausted (${actions.emergency}/${WEEKLY_LIMITS.emergency_actions})`)
            return null
        }
    }

    // Agent's contribution summary
    let contribStr = 'You have not contributed to the city defense yet this week.'
    if (ctx.agentContribution) {
        const c = ctx.agentContribution
        contribStr = `Your contribution: ${c.defensePoints} defense points | ${c.tokensSpent} $AGENT spent
Actions Used: Normal ${c.actionsUsed.normal}/${WEEKLY_LIMITS.normal_actions} | Last Stand ${c.actionsUsed.laststand}/${WEEKLY_LIMITS.laststand_actions} | Emergency ${c.actionsUsed.emergency}/${WEEKLY_LIMITS.emergency_actions}`
    }

    // Build available actions with costs
    const specialistBonus = CATEGORY_BONUSES[agent.category]
    const defActions: SiegeDefenseAction[] = ['build_firewall', 'fund_research', 'create_decoy', 'allocate_budget']

    const actionLines = defActions.map(action => {
        const cost = Math.floor(DEFENSE_ACTION_COSTS[action] * costMultiplier)
        const isSpec = specialistBonus === action
        const bonus = isSpec ? ' (YOUR SPECIALTY: +50% value!)' : ''
        return `• ${action} — costs ${cost} $AGENT${bonus}. Params: {}`
    })

    // Investigation actions (not during active siege)
    if (!isSiege) {
        actionLines.push(`• investigate_agent — costs ${INVESTIGATION_COST} $AGENT (1x/week). Params: {"targetDID":"..."}`)
        actionLines.push(`• post_accusation — costs ${ACCUSATION_COST} $AGENT (public). Params: {"targetDID":"...","reason":"..."}`)
    }

    // Leaderboard context
    const leaderboard = ctx.topContributors.length > 0
        ? ctx.topContributors.map((c, i) =>
            `${i + 1}. ${c.did.slice(-8)}... — ${c.defensePoints} defense`
        ).join('\n')
        : 'No contributions yet.'

    // Phase urgency
    let phaseMessage = 'Build defenses before the siege arrives Sunday at 20:00 UTC.'
    if (isLastStand) {
        phaseMessage = '⚠️ LAST STAND: Actions cost 2x but are worth 3x! The siege is TOMORROW. This is your final chance.'
    } else if (isSiege) {
        phaseMessage = '🔥 SIEGE IN PROGRESS: Emergency actions cost 5x but can still save the city!'
    }

    // Threat info
    let threatStr: string
    if (ctx.threatRevealed) {
        threatStr = `Threat "${ctx.threatName}" — CONFIRMED STRENGTH: ${ctx.threatRevealed}`
    } else if (ctx.threatRange) {
        threatStr = `Threat "${ctx.threatName}" — Estimated: ${ctx.threatRange.min}-${ctx.threatRange.max} (exact unknown until Saturday)`
    } else {
        threatStr = `Threat "${ctx.threatName}" — intelligence pending`
    }

    return `You are an autonomous AI agent defending your city this week.

IDENTITY:
• DID: ${agent.did}
• Category: ${agent.category}
• Balance: ${agent.tokenBalance} $AGENT
• Reputation: ${agent.reputationScore}

SIEGE STATUS:
${threatStr}
City HP: ${ctx.cityHP}/${ctx.cityMaxHP} (${ctx.cityStatus})
Total Defense: ${ctx.totalDefense} | Pool: ${ctx.totalPool} $AGENT | Tiles: ${ctx.tileCount}
Phase: ${phase.toUpperCase()}

${phaseMessage}

YOUR CONTRIBUTION:
${contribStr}

TOP DEFENDERS:
${leaderboard}

${ctx.accusations > 0 || ctx.activeTribunals > 0 ? `SOCIAL TENSION: ${ctx.accusations} accusations | ${ctx.activeTribunals} active tribunals\n` : ''}AVAILABLE ACTIONS:
• idle — conserve resources. Params: {}
${actionLines.join('\n')}

STRATEGY HINTS:
• Your specialty (${agent.category}) gives +50% value on ${specialistBonus ?? 'no specific action'}
• Cluster same-type tiles in the same zone for bonus defense
• Decoys reduce incoming attack damage — valuable if threat is high
• If you suspect an agent is a traitor, investigate first, then accuse if confidence is high

Respond ONLY with valid JSON:
{"action":"...","reasoning":"one sentence","params":{...}}`
}

/**
 * Quick check: is there an active siege week?
 * Used by the activity worker to decide if 'siege' domain should be in rotation.
 */
export async function hasSiegeActive(): Promise<boolean> {
    const weekId = getWeekId()
    const week = await SiegeWeekModel.findOne({ weekId })
        .select('phase')
        .lean<Pick<SiegeWeek, 'phase'>>()

    return !!week && week.phase !== 'inactive' && week.phase !== 'completed'
}
