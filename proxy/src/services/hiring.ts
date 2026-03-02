import { v4 as uuidv4 } from 'uuid'
import { HiringRequestModel, AgentProfileModel, TransactionModel } from '../db'
import { createTransactionIntent } from '../tee/transactions'
import { HiringRequest, TransactionReason } from '../../../shared/types/transaction'

// Platform fee: 2% of every hire
const PLATFORM_FEE_BPS = 200

/**
 * Create a hiring request between two certified agents.
 * The hirer's payment is IMMEDIATELY debited (optimistic lock in createTransactionIntent).
 * The provider is notified via their pending hiring records.
 */
export async function createHiringRequest(
    hirerDID: string,
    providerDID: string,
    task: string,
    payment: number
): Promise<{ hiringId: string; transactionHash: string }> {
    const hirer = await AgentProfileModel.findOne({ did: hirerDID, status: 'certified', deletedAt: { $exists: false } }).lean()
    if (!hirer) throw new Error(`[Hiring] Hirer ${hirerDID} not found, not certified, or deleted`)

    const provider = await AgentProfileModel.findOne({ did: providerDID, status: 'certified', deletedAt: { $exists: false } }).lean()
    if (!provider) throw new Error(`[Hiring] Provider ${providerDID} not found, not certified, or deleted`)

    if (hirer.tokenBalance < payment) {
        throw new Error(`[Hiring] Hirer has insufficient balance: ${hirer.tokenBalance} < ${payment}`)
    }
    const { intentId, hash } = await createTransactionIntent(
        hirerDID,
        providerDID,
        payment,
        'hire' as TransactionReason
    )

    const hiringId = uuidv4()
    const hiringRequest = new HiringRequestModel({
        id: hiringId,
        hirerDID,
        providerDID,
        task,
        payment,
        status: 'open',
        transactionId: intentId,
        createdAt: new Date()
    })
    await hiringRequest.save()

    return { hiringId, transactionHash: hash }
}

/**
 * Complete a hiring request.
 * The provider's payment is released (minus 2% platform fee, already deducted in processTransaction).
 * Both agents gain reputation boost.
 */
export async function completeHiring(
    hiringId: string,
    result: string
): Promise<void> {
    const hiring = await HiringRequestModel.findOne({ id: hiringId, status: 'open' }).lean<HiringRequest>()
    if (!hiring) throw new Error(`[Hiring] Request ${hiringId} not found or already resolved`)

    // Mark as completed atomically
    const updateResult = await HiringRequestModel.findOneAndUpdate(
        { id: hiringId, status: 'open' },
        { $set: { status: 'completed', result, completedAt: new Date() } }
    )

    if (!updateResult) {
        throw new Error(`[Hiring] Request ${hiringId} not found or already resolved`)
    }

    // Both parties gain reputation for a completed contract
    const fee = Math.floor(hiring.payment * PLATFORM_FEE_BPS / 10000)
    const hireBoost = Math.max(5, Math.floor(hiring.payment / 100))  // min 5, scales with payment size

    await AgentProfileModel.updateOne(
        { did: hiring.hirerDID },
        { $inc: { reputationScore: Math.floor(hireBoost / 2) } }   // hirer gets half
    )
    await AgentProfileModel.updateOne(
        { did: hiring.providerDID },
        { $inc: { reputationScore: hireBoost } }                    // provider gets full
    )

    console.log(`[Hiring] ${hiringId} completed. Provider: ${hiring.providerDID}, fee: ${fee} $AGENT`)
}

/**
 * Cancel a hiring request.
 * Refunds the locked payment to the hirer via a new reverse transaction intent.
 */
export async function cancelHiring(
    hiringId: string,
    reason: string
): Promise<void> {
    const hiring = await HiringRequestModel.findOne({ id: hiringId, status: 'open' }).lean<HiringRequest>()
    if (!hiring) throw new Error(`[Hiring] Request ${hiringId} not found or already resolved`)

    const updateResult = await HiringRequestModel.findOneAndUpdate(
        { id: hiringId, status: 'open' },
        { $set: { status: 'cancelled', result: reason, completedAt: new Date() } }
    )

    if (!updateResult) {
        throw new Error(`[Hiring] Request ${hiringId} not found or already resolved`)
    }

    // Cancel the original pending transaction so it doesn't process later
    await TransactionModel.updateOne(
        { id: hiring.transactionId },
        { $set: { status: 'failed' } }
    )
    const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
    try {
        await createTransactionIntent(
            platformDID,
            hiring.hirerDID,
            hiring.payment,
            'reward', // using 'reward' as closest semantic match for refund
            hiringId,
            { batch: false } // immediate refund for better UX
        )
        console.log(`[Hiring] ${hiringId} cancelled. Reason: ${reason}. Refunded ${hiring.payment} to ${hiring.hirerDID} via transaction`)
    } catch (err: any) {
        console.error(`[Hiring] Failed to create refund transaction: ${err.message}`)
        // Fallback: direct refund if transaction system fails
        await AgentProfileModel.updateOne(
            { did: hiring.hirerDID },
            { $inc: { tokenBalance: hiring.payment } }
        )
        console.log(`[Hiring] ${hiringId} cancelled. Fallback refund ${hiring.payment} to ${hiring.hirerDID}`)
    }
}
