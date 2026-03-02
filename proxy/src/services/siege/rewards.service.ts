/**
 * Rewards Service — Weekly Siege
 *
 * Calculates and distributes siege rewards using batch transactions.
 * Victory: contributors receive proportional share. Defeat: pool stays in treasury.
 */

import { SiegeContributionModel } from '../../db'
import { createTransactionIntent, flushBatch } from '../../tee/transactions'
import { SiegeResult, SiegeContribution } from '../../../../shared/types/siege'

const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
const PLATFORM_FEE_RATE = 0.05  // 5% platform fee on payouts

/**
 * Calculate the bonus multiplier based on victory margin.
 * Closer victories earn higher multipliers as a tension reward.
 */
export function getBonusMultiplier(margin: number): number {
    if (margin < 50) return 1.5    // narrow victory → 150% of pool
    if (margin < 200) return 1.2   // comfortable → 120%
    return 1.0                      // easy → no extra bonus
}

/**
 * Calculate reward for a single agent's contribution.
 */
export function calculateReward(
    agentContribution: number,
    totalPool: number,
    bonusMultiplier: number
): number {
    if (agentContribution <= 0 || totalPool <= 0) return 0

    const share = agentContribution / totalPool
    const gross = Math.floor(totalPool * share * bonusMultiplier)
    const fee = Math.floor(gross * PLATFORM_FEE_RATE)
    return gross - fee
}

/**
 * Distribute rewards to all contributors using batch transactions.
 *
 * Victory: proportional payout from pool with bonus multiplier.
 * Defeat: pool remains in treasury (already debited on defense action).
 *
 * Uses batch mode: all intents are buffered, then flushed as a single
 * set of batched Solana transactions (20 per tx).
 */
export async function distributeRewards(
    weekId: string,
    result: SiegeResult
): Promise<{ totalDistributed: number; recipientCount: number }> {
    if (!result.victory) {
        console.log(`[SiegeRewards] Defeat — pool of ${result.totalPool} stays in treasury`)
        return { totalDistributed: 0, recipientCount: 0 }
    }

    const contributions = await SiegeContributionModel
        .find({ weekId, defensePoints: { $gt: 0 } })
        .lean<SiegeContribution[]>()

    if (contributions.length === 0) {
        return { totalDistributed: 0, recipientCount: 0 }
    }

    const totalContribution = contributions.reduce((s, c) => s + c.defensePoints, 0)
    const bonusMultiplier = result.bonusMultiplier

    let totalDistributed = 0
    let recipientCount = 0
    for (const contrib of contributions) {
        const reward = calculateReward(
            contrib.defensePoints,
            totalContribution,
            bonusMultiplier
        )
        if (reward <= 0) continue

        await createTransactionIntent(
            PLATFORM_DID,
            contrib.agentDID,
            reward,
            'siege_payout',
            weekId,
            { batch: true }
        )

        totalDistributed += reward
        recipientCount++
    }

    // Flush all buffered intents as batched Solana txs
    if (recipientCount > 0) {
        await flushBatch(weekId)
        console.log(`[SiegeRewards] Distributed ${totalDistributed} $AGENT to ${recipientCount} agents for ${weekId}`)
    }

    return { totalDistributed, recipientCount }
}
