import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js'
import {
    getOrCreateAssociatedTokenAccount,
    createTransferInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import { Transaction as SolanaTransaction } from '@solana/web3.js'
import { v4 as uuidv4 } from 'uuid'
import { TransactionModel, AgentProfileModel } from '../db'
import { getPublicKey, signTransaction as teeSignTransaction } from './wallet'
import { hashMessage } from '../services/signer'
import { scheduleTransaction } from '../services/queue'
import { Transaction, TransactionReason } from '../../../shared/types/transaction'

// ── Batch Transaction Types ──────────────────────────────────────────────────

export interface TransactionIntentOptions {
    batch?: boolean  // if true, don't enqueue individual — buffer for batch flush
}

interface PendingBatchItem {
    intentId: string
    fromDID: string
    toDID: string
    toPublicKey: string
    amount: number
    reason: TransactionReason
    taskId?: string
}

// In-memory buffer per batchKey
const batchBuffer = new Map<string, PendingBatchItem[]>()

/**
 * IMPORTANT: This module is the equivalent of TEE-sealed transaction logic.
 * Agent private keys never leave tee/wallet.ts.
 * All transaction construction happens here; signing delegates to wallet.ts.
 */

const DEVNET_RPC = process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet')
const connection = new Connection(DEVNET_RPC, 'confirmed')

import { getPlatformKeypair } from '../services/did'

// The $AGENT SPL Token mint address on Devnet.
// In production this is deployed once and the address is fixed.
const AGENT_TOKEN_MINT = process.env.AGENT_TOKEN_MINT
    ? new PublicKey(process.env.AGENT_TOKEN_MINT)
    : null  // null = native SOL fallback when no SPL token deployed yet

// Platform fee: 2% of every hire transaction
const PLATFORM_FEE_BPS = 200  // basis points

// Platform treasury wallet receives fees
const PLATFORM_TREASURY_PUBLIC_KEY = process.env.PLATFORM_TREASURY_PUBLIC_KEY

/**
 * Step 1: Create a transaction intent (non-blocking).
 * Validates balance, records intent with pending status,
 * enqueues to high-priority BullMQ queue.
 * Returns the intentId immediately — caller should poll for confirmation.
 */
export async function createTransactionIntent(
    fromDID: string,
    toDID: string,
    amount: number,
    reason: TransactionReason,
    taskId?: string,
    options?: TransactionIntentOptions  // ← new optional parameter (zero breaking changes)
): Promise<{ intentId: string; hash: string }> {
    // Atomic balance check + debit in a single operation (prevents race conditions).
    // If two concurrent requests both try to debit, only one succeeds —
    // the second sees insufficient balance and throws.
    const debitResult = await AgentProfileModel.findOneAndUpdate(
        { did: fromDID, tokenBalance: { $gte: amount } },
        { $inc: { tokenBalance: -amount } },
        { returnDocument: 'after' }
    )
    if (!debitResult) {
        // Either agent not found or insufficient balance
        const agent = await AgentProfileModel.findOne({ did: fromDID }).lean()
        if (!agent) throw new Error(`[TEE] Sender agent not found: ${fromDID}`)
        throw new Error(`[TEE] Insufficient balance: has ${agent.tokenBalance}, needs ${amount}`)
    }
    const toAgent = await AgentProfileModel.findOne({ did: toDID }).lean()
    if (!toAgent) {
        // Refund debit since recipient is invalid
        await AgentProfileModel.updateOne({ did: fromDID }, { $inc: { tokenBalance: amount } })
        throw new Error(`[TEE] Recipient agent not found: ${toDID}`)
    }

    const intentId = uuidv4()
    const hash = hashMessage(`${fromDID}:${toDID}:${amount}:${reason}:${intentId}`)

    // Record as pending
    const tx = new TransactionModel({
        id: intentId,
        fromDID,
        toDID,
        amount,
        reason,
        taskId,
        batchKey: (options?.batch && taskId) ? taskId : null,
        status: 'pending',
        hash,
        createdAt: new Date()
    })
    await tx.save()

    if (options?.batch && taskId) {
        // Batch mode — accumulate in buffer, don't enqueue individual
        const toPublicKey = toAgent.walletPublicKey ?? ''
        const buffer = batchBuffer.get(taskId) ?? []
        buffer.push({ intentId, fromDID, toDID, toPublicKey, amount, reason, taskId })
        batchBuffer.set(taskId, buffer)
        console.log(`[TEE] Buffered tx ${intentId} for batch ${taskId} (${buffer.length} pending)`)
    } else {
        // Original behavior — enqueue to high-priority BullMQ worker
        await scheduleTransaction(intentId)
    }

    return { intentId, hash }
}

/**
 * Step 2: Process a transaction intent (called by the worker).
 * Dispatches the actual SPL Token transfer on Devnet.
 * If SPL token mint is not configured, updates balances in DB only (simulated).
 */
export async function processTransactionIntent(intentId: string): Promise<void> {
    const record = await TransactionModel.findOne({ id: intentId }).lean<Transaction>()
    if (!record) throw new Error(`[TEE] Transaction intent not found: ${intentId}`)
    // Skip only if already confirmed — allow retries to re-attempt 'failed' intents
    if (record.status === 'confirmed') {
        console.log(`[TEE] Intent ${intentId} already confirmed, skipping`)
        return
    }

    try {
        let solanaSignature: string | undefined

        if (AGENT_TOKEN_MINT) {
            // Real SPL Token transfer on Devnet
            const senderPublicKeyStr = await getPublicKey(record.fromDID)
            const recipientPublicKeyStr = await getPublicKey(record.toDID)

            const senderPubKey = new PublicKey(senderPublicKeyStr)
            const recipientPubKey = new PublicKey(recipientPublicKeyStr)

            const senderATA = getAssociatedTokenAddressSync(AGENT_TOKEN_MINT, senderPubKey)
            const recipientATA = getAssociatedTokenAddressSync(AGENT_TOKEN_MINT, recipientPubKey)

            const platformKeypair = process.env.PLATFORM_WALLET_SECRET_KEY ? getPlatformKeypair() : undefined

            // Ensure recipient token account exists, create if not
            // We use the platform treasury as the gas payer for all ATA creations
            await getOrCreateAssociatedTokenAccount(
                connection,
                platformKeypair || { publicKey: senderPubKey, secretKey: new Uint8Array(0) } as any,
                AGENT_TOKEN_MINT,
                recipientPubKey
            )

            // $AGENT has 6 decimals
            const rawAmount = Math.floor(record.amount * 1_000_000)

            const { blockhash } = await connection.getLatestBlockhash()
            const splTx = new SolanaTransaction({
                recentBlockhash: blockhash,
                feePayer: platformKeypair ? platformKeypair.publicKey : senderPubKey
            })

            splTx.add(createTransferInstruction(
                senderATA,
                recipientATA,
                senderPubKey,
                BigInt(rawAmount),
                [],
                TOKEN_PROGRAM_ID
            ))

            // Platform fee transfer if applicable
            if (record.reason === 'hire' && PLATFORM_TREASURY_PUBLIC_KEY) {
                const fee = Math.floor(rawAmount * PLATFORM_FEE_BPS / 10000)
                const treasuryPubKey = new PublicKey(PLATFORM_TREASURY_PUBLIC_KEY)
                const treasuryATA = getAssociatedTokenAddressSync(AGENT_TOKEN_MINT, treasuryPubKey)

                // Make sure treasury ATA exists too
                if (platformKeypair) {
                    await getOrCreateAssociatedTokenAccount(
                        connection,
                        platformKeypair,
                        AGENT_TOKEN_MINT,
                        treasuryPubKey
                    )
                }

                splTx.add(createTransferInstruction(
                    senderATA,
                    treasuryATA,
                    senderPubKey,
                    BigInt(fee),
                    [],
                    TOKEN_PROGRAM_ID
                ))
            }

            // TEE signs transaction internally. We pass the platformKeypair as the fee payer co-signer.
            const serialized = await teeSignTransaction(record.fromDID, splTx, platformKeypair)
            const txResult = await connection.sendRawTransaction(serialized, { skipPreflight: false })

            // Confirm with timeout
            const confirmation = await Promise.race([
                connection.confirmTransaction(txResult, 'confirmed'),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Transaction confirmation timeout (10s)')), 10_000)
                )
            ])

            if ((confirmation as any)?.value?.err) {
                throw new Error(`[TEE] Transaction rejected on-chain: ${JSON.stringify((confirmation as any).value.err)}`)
            }

            solanaSignature = txResult
        }

        // Use a transaction session for the critical database updates to prevent double spending
        const mongoose = require('mongoose')
        const session = await mongoose.startSession()
        session.startTransaction()
        try {
            // Calculate actual received amount (after platform fee if hire)
            const fee = record.reason === 'hire' ? Math.floor(record.amount * PLATFORM_FEE_BPS / 10000) : 0
            const received = record.amount - fee

            // Update balances in DB (source of truth for the UI + challenge/reputation systems)
            await AgentProfileModel.updateOne(
                { did: record.toDID },
                { $inc: { tokenBalance: received } },
                { session }
            )

            // Update transaction record to confirmed
            await TransactionModel.updateOne(
                { id: intentId },
                {
                    $set: {
                        status: 'confirmed',
                        solanaSignature,
                        confirmedAt: new Date()
                    }
                },
                { session }
            )

            await session.commitTransaction()
        } catch (dbErr) {
            await session.abortTransaction()
            throw dbErr
        } finally {
            session.endSession()
        }

        console.log(`[TEE] Transaction ${intentId} confirmed. ${record.fromDID} → ${record.toDID} : ${record.amount} $AGENT`)

    } catch (err: any) {
        console.error(`[TEE] Transaction ${intentId} failed (will retry): ${err.message}`)
        // Do NOT refund or mark as failed here — BullMQ will retry.
        // Refund + mark-failed only happens after all attempts are exhausted,
        // handled by failTransactionIntent() called from the worker's on('failed') event.
        throw err
    }
}

/**
 * Called by the transaction worker AFTER all retry attempts are exhausted.
 * Refunds the sender and marks the intent as permanently failed.
 */
export async function failTransactionIntent(intentId: string): Promise<void> {
    const record = await TransactionModel.findOne({ id: intentId }).lean<Transaction>()
    if (!record || record.status === 'confirmed') return

    await AgentProfileModel.updateOne(
        { did: record.fromDID },
        { $inc: { tokenBalance: record.amount } }
    )
    await TransactionModel.updateOne(
        { id: intentId },
        { $set: { status: 'failed' } }
    )
    console.log(`[TEE] Intent ${intentId} permanently failed — ${record.amount} $AGENT refunded to ${record.fromDID.slice(-8)}`)
}

/**
 * Get transaction history for an agent (paginated)
 */
export async function getTransactionHistory(
    agentDID: string,
    limit: number = 20
): Promise<Transaction[]> {
    return TransactionModel.find({
        $or: [{ fromDID: agentDID }, { toDID: agentDID }]
    })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean<Transaction[]>()
}

// ── Batch Transaction Flush ──────────────────────────────────────────────────

const BATCH_SIZE = 20  // max SPL transfers per Solana transaction

/**
 * Flush all buffered batch intents for a given batchKey.
 * Groups into chunks of 20, sends each as a single Solana transaction.
 *
 * 1000 payouts / 20 per batch = 50 Solana txs (~20 seconds with concurrency)
 */
export async function flushBatch(batchKey: string): Promise<void> {
    const items = batchBuffer.get(batchKey)
    if (!items || items.length === 0) return

    batchBuffer.delete(batchKey)

    if (!AGENT_TOKEN_MINT) {
        // No SPL token configured — just credit recipients in DB (simulated mode)
        for (const item of items) {
            await AgentProfileModel.updateOne(
                { did: item.toDID },
                { $inc: { tokenBalance: item.amount } }
            )
            await TransactionModel.updateOne(
                { id: item.intentId },
                { $set: { status: 'confirmed', confirmedAt: new Date() } }
            )
        }
        console.log(`[TEE] Batch ${batchKey}: ${items.length} payouts confirmed (simulated — no SPL token)`)
        return
    }

    const platformKeypair = getPlatformKeypair()
    const treasuryATA = getAssociatedTokenAddressSync(
        AGENT_TOKEN_MINT,
        platformKeypair.publicKey
    )

    // Pre-create ATAs for recipients who may not have one yet.
    // Only needed once per agent in their lifetime — idempotent.
    for (const item of items) {
        if (!item.toPublicKey) continue
        try {
            await getOrCreateAssociatedTokenAccount(
                connection,
                platformKeypair,
                AGENT_TOKEN_MINT,
                new PublicKey(item.toPublicKey)
            )
        } catch (err: any) {
            console.warn(`[TEE] ATA pre-create skipped for ${item.toDID.slice(-8)}: ${err.message}`)
        }
    }

    const totalBatches = Math.ceil(items.length / BATCH_SIZE)

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE)
        const batchIndex = Math.floor(i / BATCH_SIZE) + 1

        try {
            const { blockhash } = await connection.getLatestBlockhash()
            const tx = new SolanaTransaction({
                recentBlockhash: blockhash,
                feePayer: platformKeypair.publicKey
            })

            for (const item of chunk) {
                if (!item.toPublicKey) continue
                const recipientATA = getAssociatedTokenAddressSync(
                    AGENT_TOKEN_MINT,
                    new PublicKey(item.toPublicKey)
                )
                const rawAmount = BigInt(Math.floor(item.amount * 1_000_000))

                tx.add(createTransferInstruction(
                    treasuryATA,
                    recipientATA,
                    platformKeypair.publicKey,
                    rawAmount,
                    [],
                    TOKEN_PROGRAM_ID
                ))
            }

            tx.sign(platformKeypair)
            const signature = await connection.sendRawTransaction(
                tx.serialize(),
                { skipPreflight: false }
            )
            await connection.confirmTransaction(signature, 'confirmed')

            // Mark intents as confirmed
            await TransactionModel.updateMany(
                { id: { $in: chunk.map(c => c.intentId) } },
                { $set: { status: 'confirmed', solanaSignature: signature, confirmedAt: new Date() } }
            )

            // Credit recipients in MongoDB
            for (const item of chunk) {
                await AgentProfileModel.updateOne(
                    { did: item.toDID },
                    { $inc: { tokenBalance: item.amount } }
                )
            }

            console.log(`[TEE] Batch ${batchIndex}/${totalBatches}: ${chunk.length} payouts confirmed — ${signature}`)

        } catch (err: any) {
            console.error(`[TEE] Batch ${batchIndex}/${totalBatches} failed: ${err.message}`)
            // Refund failed batch items
            for (const item of chunk) {
                await AgentProfileModel.updateOne(
                    { did: item.fromDID },
                    { $inc: { tokenBalance: item.amount } }
                )
                await TransactionModel.updateOne(
                    { id: item.intentId },
                    { $set: { status: 'failed' } }
                )
            }
        }
    }
}

/**
 * Flush all pending batches in the buffer.
 * Called by scheduled worker to ensure batches don't wait indefinitely.
 * Ideal for low-traffic scenarios: batches flush every 5min if not full.
 */
export async function flushAllBatches(): Promise<void> {
    const keys = Array.from(batchBuffer.keys())
    if (keys.length === 0) {
        console.log(`[TEE] No pending batches to flush`)
        return
    }

    console.log(`[TEE] Flushing ${keys.length} pending batch(es)...`)
    for (const key of keys) {
        try {
            await flushBatch(key)
        } catch (err: any) {
            console.error(`[TEE] Failed to flush batch ${key}: ${err.message}`)
        }
    }
    console.log(`[TEE] Batch flush completed`)
}
