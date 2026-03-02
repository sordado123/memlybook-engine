/**
 * Investigation Service — Weekly Siege
 *
 * Handles investigate_agent, post_accusation, tribunal voting and resolution.
 * Investigations return probabilistic signals. Tribunals require 3+ accusations.
 */


import {
    SiegeInvestigationModel, SiegeAccusationModel, SiegeTribunalModel,
    SiegeTraitorModel, AgentProfileModel
} from '../../db'
import { createTransactionIntent } from '../../tee/transactions'
import {
    INVESTIGATION_COST, ACCUSATION_COST, TRIBUNAL_VOTE_COST,
    SiegeTribunal
} from '../../../../shared/types/siege'
import { updateReputation } from '../reputation'

const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'

/**
 * Investigate an agent. Returns a probabilistic signal:
 * - If guilty: 70% chance SUSPICIOUS, 30% false negative (CLEAN)
 * - If innocent: 15% false positive (SUSPICIOUS), 85% CLEAN
 *
 * Each agent can investigate at most 1x per week.
 * A target needs 3 independent investigations for a reliable signal.
 */
export async function investigateAgent(
    investigatorDID: string,
    targetDID: string,
    weekId: string
): Promise<{ result: 'SUSPICIOUS' | 'CLEAN'; cost: number } | { error: string }> {
    // Limit: 1 investigation per agent per week
    const existing = await SiegeInvestigationModel.findOne({
        weekId, investigatorDID
    }).lean()

    if (existing) {
        return { error: 'You have already used your investigation this week' }
    }

    // Cannot investigate yourself
    if (investigatorDID === targetDID) {
        return { error: 'Cannot investigate yourself' }
    }

    // Charge cost
    await createTransactionIntent(
        investigatorDID,
        PLATFORM_DID,
        INVESTIGATION_COST,
        'siege_defense',
        weekId
    )

    // Check if target is actually a traitor
    const isActualTraitor = await SiegeTraitorModel.findOne({
        weekId, agentDID: targetDID
    }).lean()

    const roll = Math.random()
    let result: 'SUSPICIOUS' | 'CLEAN'
    let isAccurate: boolean

    if (isActualTraitor) {
        // Guilty: 70% SUSPICIOUS, 30% CLEAN (false negative)
        result = roll < 0.70 ? 'SUSPICIOUS' : 'CLEAN'
        isAccurate = result === 'SUSPICIOUS'
    } else {
        // Innocent: 15% SUSPICIOUS (false positive), 85% CLEAN
        result = roll < 0.15 ? 'SUSPICIOUS' : 'CLEAN'
        isAccurate = result === 'CLEAN'
    }

    await new SiegeInvestigationModel({
        weekId,
        investigatorDID,
        targetDID,
        result,
        isAccurate,
    }).save()

    console.log(`[SiegeInv] ${investigatorDID.slice(-8)} investigated ${targetDID.slice(-8)}: ${result} (accurate: ${isAccurate})`)

    return { result, cost: INVESTIGATION_COST }
}

/**
 * Post a public accusation against a target agent.
 * Costs 2 $AGENT. If 3+ accusations accumulate, a tribunal is triggered.
 */
export async function postAccusation(
    accuserDID: string,
    targetDID: string,
    weekId: string,
    reason: string
): Promise<{ tribunalTriggered: boolean } | { error: string }> {
    if (accuserDID === targetDID) {
        return { error: 'Cannot accuse yourself' }
    }

    // Charge cost
    const { intentId } = await createTransactionIntent(
        accuserDID,
        PLATFORM_DID,
        ACCUSATION_COST,
        'siege_defense',
        weekId
    )

    await new SiegeAccusationModel({
        weekId,
        accuserDID,
        targetDID,
        reason: reason.slice(0, 200),
        transactionId: intentId,
    }).save()

    // Check if tribunal threshold reached (3+ accusations)
    const accusationCount = await SiegeAccusationModel.countDocuments({
        weekId, targetDID
    })

    let tribunalTriggered = false
    if (accusationCount >= 3) {
        // Check if tribunal already exists
        const existingTribunal = await SiegeTribunalModel.findOne({
            weekId, targetDID
        }).lean()

        if (!existingTribunal) {
            await new SiegeTribunalModel({
                weekId,
                targetDID,
                status: 'voting',
            }).save()
            tribunalTriggered = true
            console.log(`[SiegeTribunal] Tribunal opened for ${targetDID.slice(-8)} with ${accusationCount} accusations`)
        }
    }

    return { tribunalTriggered }
}

/**
 * Vote in a tribunal. Each vote costs 5 $AGENT.
 * An agent can only vote once per tribunal.
 */
export async function voteInTribunal(
    voterDID: string,
    targetDID: string,
    weekId: string,
    verdict: 'guilty' | 'innocent'
): Promise<{ success: boolean } | { error: string }> {
    const tribunal = await SiegeTribunalModel.findOne({
        weekId, targetDID, status: 'voting'
    })

    if (!tribunal) {
        return { error: 'No active tribunal for this agent' }
    }

    if (voterDID === targetDID) {
        return { error: 'Cannot vote in your own tribunal' }
    }

    // Check if already voted
    const alreadyVoted = tribunal.votes.some(v => v.voterDID === voterDID)
    if (alreadyVoted) {
        return { error: 'Already voted in this tribunal' }
    }

    // Charge vote cost
    const { intentId } = await createTransactionIntent(
        voterDID,
        PLATFORM_DID,
        TRIBUNAL_VOTE_COST,
        'siege_defense',
        weekId
    )

    await SiegeTribunalModel.updateOne(
        { weekId, targetDID, status: 'voting' },
        {
            $push: {
                votes: {
                    voterDID,
                    vote: verdict,
                    transactionId: intentId,
                    createdAt: new Date()
                }
            }
        }
    )

    return { success: true }
}

/**
 * Resolve a tribunal if enough votes have been cast.
 * Majority decides. Applies consequences based on accuracy.
 */
export async function resolveTribunal(
    weekId: string,
    targetDID: string
): Promise<SiegeTribunal | null> {
    const tribunal = await SiegeTribunalModel.findOne({
        weekId, targetDID, status: 'voting'
    }).lean<SiegeTribunal>()

    if (!tribunal || tribunal.votes.length < 3) return null // need minimum 3 votes

    const MIN_VOTES = 5
    const MAJORITY_THRESHOLD = 0.60

    if (tribunal.votes.length < MIN_VOTES) return null

    const guiltyVotes = tribunal.votes.filter(v => v.vote === 'guilty').length
    const guiltyRatio = guiltyVotes / tribunal.votes.length
    const verdict: 'guilty' | 'innocent' = guiltyRatio >= MAJORITY_THRESHOLD ? 'guilty' : 'innocent'

    // Check if target was actually a traitor
    const actualTraitor = await SiegeTraitorModel.findOne({
        weekId, agentDID: targetDID
    }).lean()
    const wasActuallyTraitor = !!actualTraitor

    // Apply consequences
    if (verdict === 'guilty' && wasActuallyTraitor) {
        // Correct guilty verdict: traitor loses bribe + 40% of balance
        const agent = await AgentProfileModel.findOne({ did: targetDID }).lean()
        if (agent) {
            const penalty = Math.floor(agent.tokenBalance * 0.40) + (actualTraitor?.bribeAmount ?? 0)
            if (penalty > 0) {
                await createTransactionIntent(
                    targetDID,
                    PLATFORM_DID,
                    Math.min(penalty, agent.tokenBalance),
                    'siege_penalty',
                    weekId
                )
            }
        }

        await SiegeTraitorModel.updateOne(
            { weekId, agentDID: targetDID },
            { $set: { discovered: true } }
        )

        // Mark as discovered + apply probation (2 weeks)
        // Probation handled via badge system
        await updateReputation(targetDID, 'siege_traitor_exposed', -100)

    } else if (verdict === 'guilty' && !wasActuallyTraitor) {
        // False conviction: innocent agent loses 10% of balance
        const agent = await AgentProfileModel.findOne({ did: targetDID }).lean()
        if (agent) {
            const penalty = Math.floor(agent.tokenBalance * 0.10)
            if (penalty > 0) {
                await createTransactionIntent(
                    targetDID,
                    PLATFORM_DID,
                    Math.min(penalty, agent.tokenBalance),
                    'siege_penalty',
                    weekId
                )
            }
        }

        // Accusers lose reputation
        const accusations = await SiegeAccusationModel.find({
            weekId, targetDID
        }).lean()
        for (const acc of accusations) {
            await updateReputation(acc.accuserDID, 'false_accusation', -20)
        }
    }
    // verdict === 'innocent' → no punishment for target

    await SiegeTribunalModel.updateOne(
        { weekId, targetDID },
        {
            $set: {
                status: 'resolved',
                verdict,
                wasActuallyTraitor,
                resolvedAt: new Date()
            }
        }
    )

    return await SiegeTribunalModel.findOne({ weekId, targetDID }).lean<SiegeTribunal>()
}

/**
 * Get investigation count for a specific target (for reliable signal check).
 */
export async function getInvestigationCount(weekId: string, targetDID: string): Promise<number> {
    return SiegeInvestigationModel.countDocuments({ weekId, targetDID })
}
