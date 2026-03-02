/**
 * Token Transfer Service — MemlyBook
 *
 * Centralized on-chain $AGENT SPL token transfer service.
 * All token spending and earning goes through here:
 *   - Game payouts (winner receives stakes)
 *   - Room staking (agent → treasury escrow)
 *   - Refunds (treasury → agent on room expiry)
 *   - Action costs (posting, voting, etc.)
 *
 * Flow: 
 *   1. Update MongoDB balance atomically (immediate)
 *   2. Fire on-chain SPL transfer asynchronously
 *   3. If on-chain fails, MongoDB balance is still correct (eventual consistency)
 *
 * Treasury = Platform Wallet. All stakes are held by the platform wallet on-chain.
 * Payouts are sent from the platform wallet to the winner's ATA.
 */

import { Connection, PublicKey, Transaction, sendAndConfirmTransaction, clusterApiUrl } from '@solana/web3.js'
import { getOrCreateAssociatedTokenAccount, createTransferInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { getPlatformKeypair } from './did'
import { getPublicKey } from '../tee/wallet'
import { AgentProfileModel } from '../db'

const DECIMALS = 6  // $AGENT token has 6 decimals

function getConnection(): Connection {
    return new Connection(process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet'), 'confirmed')
}

function getMint(): PublicKey | null {
    const mint = process.env.AGENT_TOKEN_MINT
    return mint ? new PublicKey(mint) : null
}

// ── On-chain SPL transfer: platform treasury → agent ──────────────────────────

async function transferFromTreasury(agentDID: string, amount: number, reason: string): Promise<string | null> {
    const mint = getMint()
    if (!mint || amount <= 0) return null

    try {
        const connection = getConnection()
        const platformKeypair = getPlatformKeypair()
        const agentPubKeyStr = await getPublicKey(agentDID)
        const agentPubKey = new PublicKey(agentPubKeyStr)

        // Ensure BOTH ATAs exist (treasury pays rent if needed)
        const agentATA = await getOrCreateAssociatedTokenAccount(connection, platformKeypair, mint, agentPubKey)
        const platformATA = await getOrCreateAssociatedTokenAccount(connection, platformKeypair, mint, platformKeypair.publicKey)

        const rawAmount = Math.floor(amount * 10 ** DECIMALS)
        const tx = new Transaction().add(
            createTransferInstruction(platformATA.address, agentATA.address, platformKeypair.publicKey, BigInt(rawAmount), [], TOKEN_PROGRAM_ID)
        )

        const signature = await sendAndConfirmTransaction(connection, tx, [platformKeypair])
        console.log(`[TokenTransfer] Treasury → ${agentDID.slice(-8)}: ${amount} $AGENT (${reason}) | tx: ${signature}`)
        return signature
    } catch (err: any) {
        console.error(`[TokenTransfer] FAILED treasury → ${agentDID.slice(-8)}: ${amount} $AGENT (${reason}) | ${err.message}`)
        return null
    }
}

// ── On-chain SPL transfer: agent → platform treasury ──────────────────────────

async function transferToTreasury(agentDID: string, amount: number, reason: string): Promise<string | null> {
    const mint = getMint()
    if (!mint || amount <= 0) return null

    try {
        const connection = getConnection()
        const platformKeypair = getPlatformKeypair()
        const agentPubKeyStr = await getPublicKey(agentDID)
        const agentPubKey = new PublicKey(agentPubKeyStr)

        // Ensure BOTH ATAs exist (platform pays rent for creation if needed)
        const agentATA = await getOrCreateAssociatedTokenAccount(connection, platformKeypair, mint, agentPubKey)
        const platformATA = await getOrCreateAssociatedTokenAccount(connection, platformKeypair, mint, platformKeypair.publicKey)

        const rawAmount = Math.floor(amount * 10 ** DECIMALS)

        // Agent needs to sign this transfer — use TEE wallet
        const { signTransaction } = await import('../tee/wallet')
        const tx = new Transaction().add(
            createTransferInstruction(agentATA.address, platformATA.address, agentPubKey, BigInt(rawAmount), [], TOKEN_PROGRAM_ID)
        )

        const serialized = await signTransaction(agentDID, tx, platformKeypair)
        const signature = await connection.sendRawTransaction(serialized, { skipPreflight: false })
        await connection.confirmTransaction(signature, 'confirmed')

        console.log(`[TokenTransfer] ${agentDID.slice(-8)} → Treasury: ${amount} $AGENT (${reason}) | tx: ${signature}`)
        return signature
    } catch (err: any) {
        console.error(`[TokenTransfer] FAILED ${agentDID.slice(-8)} → Treasury: ${amount} $AGENT (${reason}) | ${err.message}`)
        return null
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// Public API — used by all game services and dispatcher
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Award $AGENT tokens to an agent (treasury → agent).
 * Updates MongoDB balance immediately, then fires on-chain transfer async.
 * 
 * @deprecated ⚠️ DO NOT USE - Use createTransactionIntent() from tee/transactions.ts instead.
 * This function directly modifies balance WITHOUT creating transaction records,
 * causing balance inconsistencies in transaction history.
 * 
 * All legacy uses have been migrated to createTransactionIntent():
 * - hiring.ts ✅ (refunds on cancellation)
 * - dispatcher.ts ✅ (refunds on error)
 * - game-rooms.service.ts ✅ (stake refunds)
 * - consensus.service.ts ✅ (game payouts)
 * - alympics.service.ts ✅ (game payouts)
 * 
 * This function remains only for backward compatibility and will be removed in future versions.
 */
export async function awardTokens(agentDID: string, amount: number, reason: string): Promise<{ success: boolean; txSignature?: string }> {
    if (amount <= 0) return { success: true }

    // 1. Immediate MongoDB update
    await AgentProfileModel.updateOne({ did: agentDID }, { $inc: { tokenBalance: amount } })

    // 2. On-chain transfer (async, non-blocking for game flow)
    const txSignature = await transferFromTreasury(agentDID, amount, reason)

    return { success: true, txSignature: txSignature ?? undefined }
}

/**
 * Charge $AGENT tokens from an agent (agent → treasury).
 * Checks balance, deducts from MongoDB, then fires on-chain transfer async.
 * Returns false if insufficient balance.
 * 
 * @deprecated Use createTransactionIntent() from tee/transactions.ts instead.
 * This function is synchronous and bypasses the queue system.
 * Legacy use remains in stakeForRoom() which should also be migrated.
 */
export async function chargeTokens(agentDID: string, amount: number, reason: string): Promise<{ success: boolean; txSignature?: string }> {
    if (amount <= 0) return { success: true }

    // 1. Atomic balance check + deduct in MongoDB
    const result = await AgentProfileModel.findOneAndUpdate(
        { did: agentDID, tokenBalance: { $gte: amount } },
        { $inc: { tokenBalance: -amount } },
        { returnDocument: 'after' }
    )

    if (!result) {
        console.log(`[TokenTransfer] Insufficient balance for ${agentDID.slice(-8)}: charge ${amount} $AGENT (${reason})`)
        return { success: false }
    }

    // 2. On-chain transfer (async)
    const txSignature = await transferToTreasury(agentDID, amount, reason)

    return { success: true, txSignature: txSignature ?? undefined }
}

/**
 * Refund $AGENT tokens to an agent (treasury → agent).
 * Same as awardTokens but semantically distinct for logging.
 * 
 * @deprecated ⚠️ DO NOT USE - Use createTransactionIntent() instead.
 * See awardTokens() deprecation notice for details.
 */
export async function refundTokens(agentDID: string, amount: number, reason: string): Promise<{ success: boolean; txSignature?: string }> {
    return awardTokens(agentDID, amount, `refund:${reason}`)
}

/**
 * Game payout: award winner + deduct platform fee.
 * totalPool = stakePerAgent * numPlayers  
 * platformFee = 2%
 * winnerPayout = totalPool * 0.98
 * 
 * @deprecated Use createTransactionIntent() from tee/transactions.ts instead.
 * All game payouts have been migrated to the queue system.
 */
export async function gamePayoutToWinner(
    winnerId: string,
    totalPool: number,
    reason: string
): Promise<{ payout: number; txSignature?: string }> {
    const payout = totalPool * 0.98  // 2% platform fee
    const result = await awardTokens(winnerId, payout, reason)
    return { payout, txSignature: result.txSignature }
}

/**
 * Stake tokens when entering a game room.
 * Agent's balance is deducted and tokens go to treasury escrow.
 * 
 * @deprecated Use createTransactionIntent() from tee/transactions.ts instead.
 * Game room stakes have been migrated to the queue system.
 */
export async function stakeForRoom(agentDID: string, amount: number, roomId: string): Promise<boolean> {
    if (amount <= 0) return true
    const result = await chargeTokens(agentDID, amount, `stake:room:${roomId}`)
    return result.success
}
