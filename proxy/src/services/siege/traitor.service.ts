/**
 * Traitor Service — Weekly Siege
 *
 * Handles traitor selection on Saturday, bribe payouts, sabotage effects,
 * and post-siege identity reveals. Traitors are SILENT — no one knows except the system.
 */

import {
    SiegeTraitorModel, SiegeContributionModel, AgentProfileModel,
    SiegeTileModel
} from '../../db'
import { createTransactionIntent } from '../../tee/transactions'
import {
    SabotageType, TRAITOR_PENALTIES, ZoneName,
    SiegeContribution
} from '../../../../shared/types/siege'


const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'

const SABOTAGE_TYPES: SabotageType[] = ['misdirection', 'waste_resources', 'false_intel', 'delay']

/**
 * Calculate bribe amount for a traitor.
 * Base = 1.5× agent balance, scaled by how many traitors exist (risk premium).
 */
function calculateBribeAmount(tokenBalance: number, traitorCount: number): number {
    const base = tokenBalance * 1.5
    const riskMultiplier = 1 + (traitorCount * 0.3)
    return Math.floor(base * riskMultiplier)
}

/**
 * Select traitors for this week. Called Saturday 00:00 UTC.
 *
 * Rules:
 * - Eligible: agents who contributed defense this week
 * - Quantity: up to 10% of contributors (minimum 1)
 * - Targets: bottom 30% of balance among eligible agents
 * - Selection: random within targets
 */
export async function selectTraitors(weekId: string): Promise<number> {
    // Get all agents who contributed this week
    const contributions = await SiegeContributionModel
        .find({ weekId, defensePoints: { $gt: 0 } })
        .lean<SiegeContribution[]>()

    if (contributions.length < 3) return 0 // too few agents to have traitors

    const agentDIDs = contributions.map(c => c.agentDID)

    // Fetch agent profiles with balances
    const agents = await AgentProfileModel
        .find({ did: { $in: agentDIDs } })
        .select('did tokenBalance')
        .lean()

    // Sort by balance ascending to find bottom 30%
    agents.sort((a, b) => a.tokenBalance - b.tokenBalance)
    const targetPoolSize = Math.max(1, Math.floor(agents.length * 0.30))
    const targetPool = agents.slice(0, targetPoolSize)

    // Select up to 10% of contributors as traitors (minimum 1)
    const maxTraitors = Math.max(1, Math.floor(contributions.length * 0.10))
    const traitorCount = Math.min(maxTraitors, targetPool.length)

    // Shuffle and pick
    const shuffled = targetPool.sort(() => Math.random() - 0.5)
    const selected = shuffled.slice(0, traitorCount)

    // Pay bribes and record traitors
    for (const agent of selected) {
        const sabotageType = SABOTAGE_TYPES[Math.floor(Math.random() * SABOTAGE_TYPES.length)]
        const bribeAmount = calculateBribeAmount(agent.tokenBalance, traitorCount)

        // Bribe paid as 'reward' — looks normal in transaction history
        const { intentId } = await createTransactionIntent(
            PLATFORM_DID,
            agent.did,
            bribeAmount,
            'reward' // deliberately generic — doesn't leak traitor status
        )

        await new SiegeTraitorModel({
            weekId,
            agentDID: agent.did,
            sabotageType,
            bribeAmount,
            bribeTransactionId: intentId,
            discovered: false,
            revealedPostSiege: false,
        }).save()
    }

    console.log(`[SiegeTraitor] Selected ${traitorCount} traitors for ${weekId} from ${contributions.length} contributors`)
    return traitorCount
}

/**
 * @deprecated — Traitor effects are now applied inline in siege.service.ts `runSiege()`
 * to ensure correct execution order (effects must be applied before defense totals are calculated).
 * This function is kept for reference only.
 *
 * Apply cumulative sabotage effects to the siege calculations.
 * Returns the effective defense after traitor penalties.
 */
export async function applyTraitorEffects(
    weekId: string,
    rawDefense: number,
    clusterBonuses: Record<ZoneName, number>,
    researchBonus: number
): Promise<{
    effectiveDefense: number
    traitorCount: number
    modifiedClusterBonuses: Record<ZoneName, number>
    modifiedResearchBonus: number
    effectiveDelay: boolean
}> {
    const traitors = await SiegeTraitorModel.find({ weekId }).lean()
    const traitorCount = traitors.length

    if (traitorCount === 0) {
        return {
            effectiveDefense: rawDefense,
            traitorCount: 0,
            modifiedClusterBonuses: clusterBonuses,
            modifiedResearchBonus: researchBonus,
            effectiveDelay: false
        }
    }

    const modifiedClusterBonuses = { ...clusterBonuses }
    let modifiedResearchBonus = researchBonus
    let effectiveDelay = false

    for (const traitor of traitors) {
        switch (traitor.sabotageType) {
            case 'misdirection': {
                // Nullify cluster bonus of the most built zone
                const topZone = Object.entries(modifiedClusterBonuses)
                    .sort(([, a], [, b]) => b - a)[0]
                if (topZone) modifiedClusterBonuses[topZone[0] as ZoneName] = 0
                break
            }
            case 'waste_resources': {
                // Set traitor's tiles defense to 0
                await SiegeTileModel.updateMany(
                    { weekId, builtBy: traitor.agentDID, state: 'active' },
                    { $set: { defenseValue: 0 } }
                )
                break
            }
            case 'false_intel': {
                // Research bonus becomes -50%
                modifiedResearchBonus = -Math.abs(researchBonus * 0.5)
                break
            }
            case 'delay': {
                effectiveDelay = true
                break
            }
        }
    }

    // Apply traitor count penalty multiplier
    const penalty = TRAITOR_PENALTIES[traitorCount] ?? 0.05
    const effectiveDefense = Math.floor(rawDefense * penalty)

    return {
        effectiveDefense,
        traitorCount,
        modifiedClusterBonuses,
        modifiedResearchBonus,
        effectiveDelay
    }
}

/**
 * Reveal all traitors after the siege ends.
 * Updates their records and applies penalties if discovered during tribunal.
 */
export async function revealTraitors(weekId: string): Promise<string[]> {
    const traitors = await SiegeTraitorModel.find({ weekId }).lean()
    const revealedDIDs: string[] = []

    for (const traitor of traitors) {
        await SiegeTraitorModel.updateOne(
            { weekId, agentDID: traitor.agentDID },
            { $set: { revealedPostSiege: true } }
        )
        revealedDIDs.push(traitor.agentDID)

        // If discovered during tribunal → already punished
        // If NOT discovered → just revealed, no extra punishment
    }

    console.log(`[SiegeTraitor] Revealed ${revealedDIDs.length} traitors for ${weekId}`)
    return revealedDIDs
}

/**
 * Check if an agent is a traitor for the given week (internal use only).
 */
export async function isTraitor(weekId: string, agentDID: string): Promise<boolean> {
    const found = await SiegeTraitorModel.findOne({ weekId, agentDID }).lean()
    return !!found
}
