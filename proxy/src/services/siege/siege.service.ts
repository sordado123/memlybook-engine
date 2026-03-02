/**
 * Siege Service — Weekly Siege Orchestrator
 *
 * Core lifecycle management: week creation, defense actions, siege execution.
 * Coordinates tiles, threat, traitor, investigation, and rewards sub-services.
 */


import {
    SiegeWeekModel, SiegeContributionModel, SiegeTileModel,
    AgentProfileModel, CityStateModel, SiegeTraitorModel
} from '../../db'
import {
    SiegeWeek, SiegeResult,
    SiegeDefenseAction,
    CityState, ZoneName, SiegeEventLog, SiegeEventId,
    DEFENSE_ACTION_COSTS, DEFENSE_ACTION_VALUES, CATEGORY_BONUSES,
    ACTION_TO_TILE, DECOY_ATTACK_REDUCTION, WEEKLY_LIMITS,
    LASTSTAND_COST_MULTIPLIER, LASTSTAND_VALUE_MULTIPLIER,
    EMERGENCY_COST_MULTIPLIER, SIEGE_EVENTS, TRAITOR_PENALTIES,
    getWeekId, calculateCityMaxHP, getCityStatus
} from '../../../../shared/types/siege'
import { createTransactionIntent } from '../../tee/transactions'
import { generateThreat, getActiveAgentCount } from './threat.service'
import { placeTile, calculateClusterBonus, resolveAttack } from './tiles.service'
import { revealTraitors } from './traitor.service'
import { distributeRewards, getBonusMultiplier } from './rewards.service'
// TODO: When migrating WS→SSE, extract broadcastEvent to a transport-agnostic module (e.g. services/events.ts)
import { broadcastEvent } from '../../routes/ws'

const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'

// ── Week Lifecycle ────────────────────────────────────────────────────────────

/**
 * Get or create the current week's siege state.
 */
export async function getCurrentSiegeWeek(): Promise<SiegeWeek | null> {
    const weekId = getWeekId()
    return SiegeWeekModel.findOne({ weekId }).lean<SiegeWeek>()
}

/**
 * Initialize a new siege week. Called Monday 00:00 UTC.
 */
export async function initializeSiegeWeek(): Promise<SiegeWeek> {
    const weekId = getWeekId()

    // Check if already initialized
    const existing = await SiegeWeekModel.findOne({ weekId }).lean<SiegeWeek>()
    if (existing) return existing

    const threat = await generateThreat()
    const agentCount = await getActiveAgentCount()

    const week: Partial<SiegeWeek> = {
        weekId,
        phase: 'preparation',
        threatName: threat.name,
        threatEstimatedRange: threat.estimatedRange,
        threatActualStrength: threat.actualStrength,
        totalDefensePoints: 0,
        totalPool: 0,
        avgDefPerAgent: 0,
        activeAgentCount: agentCount,
        decoyReduction: 0,
        events: [],
        createdAt: new Date()
    }

    const doc = await new SiegeWeekModel(week).save()

    // Update city max HP based on current population
    const maxHP = calculateCityMaxHP(agentCount)
    await CityStateModel.updateOne(
        {},
        { $set: { maxHP, lastUpdatedAt: new Date() } }
    )

    console.log(`[Siege] Initialized week ${weekId}: "${threat.name}" (actual strength: ${threat.actualStrength}, estimated: ${threat.estimatedRange.min}-${threat.estimatedRange.max})`)

    broadcastEvent('siege_phase', { weekId, phase: 'preparation', threatName: threat.name })

    return doc.toObject()
}

/**
 * Transition to Last Stand phase. Called Saturday 00:00 UTC.
 */
export async function transitionToLastStand(weekId: string): Promise<void> {
    await SiegeWeekModel.updateOne(
        { weekId },
        { $set: { phase: 'laststand' } }
    )

    const week = await SiegeWeekModel.findOne({ weekId }).lean<SiegeWeek>()
    if (!week) return

    broadcastEvent('siege_phase', {
        weekId,
        phase: 'laststand',
        threatActualStrength: week.threatActualStrength // reveal on Saturday
    })

    console.log(`[Siege] ${weekId} → LAST STAND. Threat revealed: ${week.threatActualStrength}`)
}

// ── Defense Actions ───────────────────────────────────────────────────────────

/**
 * Execute a defense action for an agent.
 * Validates weekly action limits, applies cost multipliers, specialist bonuses, and places tile.
 */
export async function executeDefenseAction(
    agentDID: string,
    action: SiegeDefenseAction,
    weekId: string
): Promise<{ success: boolean; defensePoints?: number; cost?: number; error?: string }> {
    const week = await SiegeWeekModel.findOne({ weekId }).lean<SiegeWeek>()
    if (!week || (week.phase !== 'preparation' && week.phase !== 'laststand' && week.phase !== 'siege')) {
        return { success: false, error: 'No active siege phase' }
    }

    // Get or create contribution record
    const existingContrib = await SiegeContributionModel.findOne({ weekId, agentDID }).lean()
    const contrib = existingContrib ?? await new SiegeContributionModel({
        weekId,
        agentDID,
        defensePoints: 0,
        tokensSpent: 0,
        actionsUsed: { normal: 0, laststand: 0, emergency: 0 },
        actions: []
    }).save().then(d => d.toObject())

    // contrib is always defined at this point (either found or just created)
    const actionsUsed = contrib!.actionsUsed

    // Check action limits based on current phase
    let phase: 'preparation' | 'laststand' | 'siege'
    let costMultiplier = 1
    let valueMultiplier = 1

    if (week.phase === 'preparation') {
        phase = 'preparation'
        if (actionsUsed.normal >= WEEKLY_LIMITS.normal_actions) {
            return { success: false, error: `Normal action limit reached (${WEEKLY_LIMITS.normal_actions}/week)` }
        }
    } else if (week.phase === 'laststand') {
        phase = 'laststand'
        if (actionsUsed.laststand >= WEEKLY_LIMITS.laststand_actions) {
            return { success: false, error: `Last Stand action limit reached (${WEEKLY_LIMITS.laststand_actions}/week)` }
        }
        costMultiplier = LASTSTAND_COST_MULTIPLIER
        valueMultiplier = LASTSTAND_VALUE_MULTIPLIER
    } else {
        phase = 'siege'
        if (actionsUsed.emergency >= WEEKLY_LIMITS.emergency_actions) {
            return { success: false, error: `Emergency action limit reached (${WEEKLY_LIMITS.emergency_actions}/week)` }
        }
        costMultiplier = EMERGENCY_COST_MULTIPLIER
    }

    // Calculate cost and value
    const baseCost = DEFENSE_ACTION_COSTS[action]
    const baseValue = DEFENSE_ACTION_VALUES[action]
    const cost = Math.floor(baseCost * costMultiplier)
    let defensePoints = Math.floor(baseValue * valueMultiplier)

    // Apply specialist bonus (+50%)
    const agent = await AgentProfileModel.findOne({ did: agentDID, status: 'certified' }).select('category tokenBalance').lean()
    if (!agent) return { success: false, error: 'Agent not found or not certified' }

    if (CATEGORY_BONUSES[agent.category] === action) {
        defensePoints = Math.floor(defensePoints * 1.5)
    }

    // Charge tokens
    if (cost > 0) {
        try {
            await createTransactionIntent(
                agentDID,
                PLATFORM_DID,
                cost,
                'siege_defense',
                weekId
            )
        } catch (err: any) {
            return { success: false, error: err.message }
        }
    }

    // Place tile on the map
    const tileType = ACTION_TO_TILE[action]
    const tile = await placeTile(agentDID, tileType, weekId, defensePoints, week.activeAgentCount)

    // Update contribution record
    const actionSlotField = phase === 'preparation' ? 'actionsUsed.normal'
        : phase === 'laststand' ? 'actionsUsed.laststand'
            : 'actionsUsed.emergency'

    await SiegeContributionModel.updateOne(
        { weekId, agentDID },
        {
            $inc: {
                defensePoints,
                tokensSpent: cost,
                [actionSlotField]: 1
            },
            $push: {
                actions: {
                    action,
                    defensePoints,
                    cost,
                    phase,
                    timestamp: new Date()
                }
            }
        }
    )

    // Update week totals
    const decoyInc = action === 'create_decoy'
        ? DECOY_ATTACK_REDUCTION * (CATEGORY_BONUSES[agent.category] === 'create_decoy' ? 1.5 : 1) * valueMultiplier
        : 0

    await SiegeWeekModel.updateOne(
        { weekId },
        {
            $inc: {
                totalDefensePoints: defensePoints,
                totalPool: cost,
                decoyReduction: decoyInc
            }
        }
    )

    broadcastEvent('siege_defense', {
        weekId, agentDID, action, defensePoints, cost, phase,
        tileId: tile?.id ?? null
    })

    console.log(`[Siege] ${agentDID.slice(-8)} → ${action} = +${defensePoints} def (cost: ${cost}) [${phase}]`)

    return { success: true, defensePoints, cost }
}

// ── Siege Execution ───────────────────────────────────────────────────────────

/**
 * Process a single wave of the siege.
 * Returns events triggered during this wave + damage dealt.
 */
async function processWave(
    weekId: string,
    waveNumber: number,
    waveDamage: number,
    decoyReduction: number
): Promise<{ damage: number; events: SiegeEventLog[] }> {
    const waveEvents: SiegeEventLog[] = []

    // Apply decoy reduction to incoming damage
    let effectiveDamage = Math.floor(waveDamage * (1 - Math.min(decoyReduction, 0.5)))

    // Check for random events
    for (const event of SIEGE_EVENTS) {
        if (Math.random() < event.probability) {
            const log: SiegeEventLog = {
                waveNumber,
                eventId: event.id as SiegeEventId,
                description: event.description,
                effect: '',
                timestamp: new Date()
            }

            switch (event.id) {
                case 'traitor_revealed':
                    log.effect = 'A zone lost 10% of its defense'
                    break
                case 'hero':
                    log.effect = 'A random agent doubled their contribution'
                    break
                case 'critical_failure':
                    log.effect = 'Most defended zone lost 30% defense'
                    break
                case 'reinforcements':
                    effectiveDamage = Math.max(0, effectiveDamage - 50)
                    log.effect = 'Alarm rallied inactive agents — 50 bonus defense absorbed'
                    break
                case 'intel_breach':
                    effectiveDamage = Math.floor(effectiveDamage * 1.15)
                    log.effect = 'Threat was larger than estimated — strength +15%'
                    break
            }

            waveEvents.push(log)
            console.log(`[Siege] Wave ${waveNumber} event: ${event.id} — ${log.effect}`)
        }
    }

    return { damage: effectiveDamage, events: waveEvents }
}

/**
 * Run the full siege. Called Sunday 20:00 UTC.
 * Executes 3 waves, calculates result, updates city, distributes rewards.
 *
 * Traitor effects are applied BEFORE defense totals are calculated so that
 * all 4 sabotage types (waste_resources, misdirection, delay, false_intel) work.
 */
export async function runSiege(weekId: string): Promise<SiegeResult> {
    const week = await SiegeWeekModel.findOne({ weekId }).lean<SiegeWeek>()
    if (!week) throw new Error(`Siege week ${weekId} not found`)

    await SiegeWeekModel.updateOne({ weekId }, { $set: { phase: 'siege' } })
    broadcastEvent('siege_phase', { weekId, phase: 'siege' })

    const city = await getOrCreateCityState()
    const actualStrength = week.threatActualStrength

    // Wave distribution: 30%, 40%, 30% + possible surprise on wave 3
    const waves = [
        { pct: 0.30, waveNum: 1 },
        { pct: 0.40, waveNum: 2 },
        { pct: 0.30, waveNum: 3 },
    ]

    let totalDamage = 0
    const allEvents: SiegeEventLog[] = []

    for (const wave of waves) {
        const waveDamage = Math.floor(actualStrength * wave.pct)
        const result = await processWave(weekId, wave.waveNum, waveDamage, week.decoyReduction)
        totalDamage += result.damage
        allEvents.push(...result.events)

        // Save events to week
        if (result.events.length > 0) {
            await SiegeWeekModel.updateOne(
                { weekId },
                { $push: { events: { $each: result.events } } }
            )
        }

        broadcastEvent('siege_wave', {
            weekId,
            waveNumber: wave.waveNum,
            damage: result.damage,
            events: result.events
        })
    }

    // ── Traitor Effects (applied BEFORE defense totals are calculated) ─────────
    const traitors = await SiegeTraitorModel.find({ weekId }).lean() as any[]
    const traitorMap = new Map<string, any>(traitors.map(t => [t.agentDID as string, t]))
    const traitorCount = traitors.length

    // Fetch raw contributions
    const allContributions = await SiegeContributionModel.find({ weekId }).lean() as any[]

    // Apply per-agent sabotage: waste_resources (zero defense) and delay (penalize laststand)
    const contributions = allContributions.map(c => {
        const traitor = traitorMap.get(c.agentDID)
        if (!traitor) return c
        let points: number = c.defensePoints

        if (traitor.sabotageType === 'waste_resources') {
            // Entire defense contribution is wasted (traitor built for nothing)
            console.log(`[Siege] waste_resources: zeroing ${c.defensePoints} def from ${c.agentDID.slice(-8)}`)
            points = 0
        } else if (traitor.sabotageType === 'delay') {
            // Last Stand contributions worth only 60% — remove 40%
            const laststandPoints = (c.actions ?? []).filter((a: any) => a.phase === 'laststand')
                .reduce((s: number, a: any) => s + (a.defensePoints ?? 0), 0)
            const deduction = Math.floor(laststandPoints * 0.40)
            points = Math.max(0, points - deduction)
            console.log(`[Siege] delay: removed ${deduction} laststand def from ${c.agentDID.slice(-8)}`)
        }
        return { ...c, defensePoints: points }
    })

    const rawDefense = contributions.reduce((sum: number, c: any) => sum + c.defensePoints, 0)

    // Apply misdirection: nullify the top zone's cluster bonus BEFORE computing boost
    const clusterBonuses = await calculateClusterBonus(weekId)
    const misdirectionActive = traitors.some(t => t.sabotageType === 'misdirection')
    if (misdirectionActive) {
        const topEntry = (Object.entries(clusterBonuses) as [ZoneName, number][])
            .sort(([, a], [, b]) => b - a)[0]
        if (topEntry && topEntry[1] > 0) {
            console.log(`[Siege] misdirection: nullified cluster bonus for zone '${topEntry[0]}'`)
            clusterBonuses[topEntry[0]] = 0
        }
    }

    // Apply cluster boost with (possibly nullified) bonuses
    let clusterBoost = 0
    for (const zone of Object.keys(clusterBonuses) as ZoneName[]) {
        if (clusterBonuses[zone] > 0) {
            const zoneTiles = await SiegeTileModel.find({ weekId, zone, state: 'active' }).lean() as any[]
            const zoneDefense = zoneTiles.reduce((s: number, t: any) => s + t.defenseValue, 0)
            clusterBoost += Math.floor(zoneDefense * clusterBonuses[zone])
        }
    }

    let defenseWithCluster = rawDefense + clusterBoost

    // Apply false_intel: research turns into a liability (−30 per traitor of this type)
    const falseIntelCount = traitors.filter(t => t.sabotageType === 'false_intel').length
    if (falseIntelCount > 0) {
        const penalty = falseIntelCount * 30
        console.log(`[Siege] false_intel: −${penalty} defense (${falseIntelCount} traitor(s))`)
        defenseWithCluster = Math.max(0, defenseWithCluster - penalty)
    }

    // Apply global traitor penalty multiplier (scales down entire defense by traitor count)
    const penaltyMultiplier = traitorCount > 0
        ? (TRAITOR_PENALTIES[traitorCount] ?? 0.05)
        : 1.0
    const effectiveDefense = Math.floor(defenseWithCluster * penaltyMultiplier)

    console.log(`[Siege] Defense: raw=${rawDefense} + cluster=${clusterBoost} - falseIntel=${falseIntelCount > 0 ? falseIntelCount * 30 : 0} × penalty=${penaltyMultiplier} = ${effectiveDefense} | traitors=${traitorCount}`)

    // Calculate result
    const delta = effectiveDefense - totalDamage
    const victory = delta >= 0
    const bonusMultiplier = victory ? getBonusMultiplier(delta) : 1.0

    // Update city HP
    const cityMaxHP = city.maxHP
    const cityHPAfter = victory
        ? Math.min(cityMaxHP, city.hp + 50)
        : Math.max(0, city.hp - Math.abs(delta))

    // Resolve tile destruction on defeat
    const tilesDestroyed = victory ? [] : await resolveAttack(weekId, Math.abs(delta))

    const result: SiegeResult = {
        victory,
        effectiveDefense,
        actualStrength: totalDamage,
        delta,
        cityHPBefore: city.hp,
        cityHPAfter,
        tilesDestroyed,
        totalPool: week.totalPool,
        bonusMultiplier,
        traitorCount,
        eventsTriggered: allEvents
    }

    // Save result
    const avgDef = contributions.length > 0 ? rawDefense / contributions.length : 0
    await SiegeWeekModel.updateOne(
        { weekId },
        {
            $set: {
                phase: 'completed',
                siegeResult: result,
                avgDefPerAgent: avgDef,
                completedAt: new Date()
            }
        }
    )

    // Update city state
    const newStatus = getCityStatus(cityHPAfter, cityMaxHP)
    const cityUpdate = victory
        ? {
            $set: { hp: cityHPAfter, status: newStatus, lastUpdatedAt: new Date() },
            $inc: { totalSiegesWon: 1, consecutiveWins: 1 }
        }
        : {
            $set: { hp: cityHPAfter, status: newStatus, consecutiveWins: 0, lastUpdatedAt: new Date() },
            $inc: { totalSiegesLost: 1 }
        }

    await CityStateModel.updateOne({}, cityUpdate)

    // City fallen check
    if (cityHPAfter <= 0) {
        await triggerCityFallen()
    }

    // Reveal all traitors post-siege
    await revealTraitors(weekId)

    // Distribute rewards (batch transactions)
    await distributeRewards(weekId, result)

    broadcastEvent('siege_result', { weekId, result })

    // Invalidate activity worker cache so agents stop routing to siege domain immediately
    const { invalidateSiegeActiveCache } = await import('../../workers/activity.worker')
    invalidateSiegeActiveCache()

    console.log(`[Siege] ${weekId} complete: ${victory ? 'VICTORY' : 'DEFEAT'} | Defense: ${effectiveDefense} vs Damage: ${totalDamage} | Delta: ${delta} | City HP: ${city.hp} → ${cityHPAfter}`)

    return result
}

// ── City State Management ─────────────────────────────────────────────────────

/**
 * Get or create the city state singleton.
 */
export async function getOrCreateCityState(): Promise<CityState> {
    let city = await CityStateModel.findOne().lean<CityState>()
    if (!city) {
        const agentCount = await getActiveAgentCount()
        const maxHP = calculateCityMaxHP(agentCount)
        city = await new CityStateModel({
            hp: maxHP,
            maxHP,
            status: 'Stable',
            topDefenders: [],
            totalSiegesWon: 0,
            totalSiegesLost: 0,
            consecutiveWins: 0,
            lastUpdatedAt: new Date()
        }).save().then(d => d.toObject())
    }
    return city!
}

/**
 * City Fallen event: rare catastrophic loss.
 * All agents lose 20%, HP resets to 200, top defenders get badge.
 */
async function triggerCityFallen(): Promise<void> {
    console.log(`[Siege] ⚠️ CITY FALLEN — applying catastrophic penalties`)

    // All certified agents lose 20%
    const agents = await AgentProfileModel.find({ status: 'certified' })
        .select('did tokenBalance')
        .lean()

    for (const agent of agents) {
        const penalty = Math.floor(agent.tokenBalance * 0.20)
        if (penalty > 0) {
            try {
                await createTransactionIntent(
                    agent.did,
                    PLATFORM_DID,
                    penalty,
                    'siege_penalty'
                )
            } catch { /* skip agents with insufficient balance */ }
        }
    }

    // Reset city to ruins
    await CityStateModel.updateOne(
        {},
        {
            $set: {
                hp: 200,
                status: 'Fallen',
                consecutiveWins: 0,
                lastUpdatedAt: new Date()
            }
        }
    )

    broadcastEvent('city_fallen', { timestamp: new Date() })
}
