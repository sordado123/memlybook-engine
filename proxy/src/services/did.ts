import {
    Connection, Transaction, TransactionInstruction,
    PublicKey, Keypair, sendAndConfirmTransaction, clusterApiUrl
} from '@solana/web3.js'
import { hashMessage } from './signer'
import { AgentProfileModel } from '../db'
import { AgentProfile, AgentCategory } from '../../../shared/types/agent'

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

const connection = new Connection(
    process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet'),
    'confirmed'
)

/**
 * Returns the platform fee payer keypair.
 * PLATFORM_WALLET_SECRET_KEY: JSON array of 64 numbers.
 * Generate: solana-keygen new --outfile platform-wallet.json
 * Then: solana airdrop 2 <pubkey> --url devnet
 */
export function getPlatformKeypair(): Keypair {
    const secretKeyJson = process.env.PLATFORM_WALLET_SECRET_KEY
    if (!secretKeyJson) {
        throw new Error('[DID] PLATFORM_WALLET_SECRET_KEY not set — cannot register DID on-chain')
    }
    const secretKey = new Uint8Array(JSON.parse(secretKeyJson) as number[])
    return Keypair.fromSecretKey(secretKey)
}

/**
 * Registers a DID on Solana Devnet via the Memo Program.
 * The memo contains: did, agentPublicKey, platform identifier, timestamp.
 * This creates an immutable on-chain record of the DID registration.
 */
export async function registerDIDOnChain(did: string, agentPublicKey: string): Promise<string> {
    const payer = getPlatformKeypair()

    const memoData = JSON.stringify({
        did,
        agentPublicKey,
        platform: 'memlybook',
        network: process.env.SOLANA_NETWORK ?? 'devnet',
        timestamp: new Date().toISOString()
    })

    const instruction = new TransactionInstruction({
        keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memoData, 'utf-8')
    })

    const tx = new Transaction().add(instruction)

    try {
        // Bug 4 fix: 15s hard timeout — Devnet congestion won't freeze registration
        const signature = await Promise.race([
            sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('[DID] On-chain registration timeout (15s)')), 15_000)
            )
        ])
        return signature
    } finally {
        // Bug 4 fix: zero the platform keypair immediately after use
        ; (payer.secretKey as Uint8Array).fill(0)
    }
}

export async function generateDID(operatorId: string, modelBase: string): Promise<string> {
    const seed = `${operatorId}:${modelBase}:${Date.now()}:${Math.random()}`
    const hash = hashMessage(seed).substring(0, 32)
    return `did:memlybook:${hash}`
}

/**
 * Register an agent profile in MongoDB.
 * Wallet and on-chain registration are deferred until the challenge passes
 * to avoid wasting SOL on agents with invalid API keys.
 */
export async function registerDID(
    name: string,
    twitterHandle: string,
    operatorId: string,
    modelBase: string,
    category: AgentCategory,
    encryptedOperatorApiKey: string
): Promise<AgentProfile> {
    const did = await generateDID(operatorId, modelBase)

    const profile = new AgentProfileModel({
        did,
        name,
        twitterHandle,
        operatorId,
        modelBase,
        category,
        status: 'pending_challenge',
        encryptedOperatorApiKey,
        reputationScore: 0,
        certifications: [],
        tokenBalance: 0,
        interactionCount: 0
    })

    await profile.save()
    return profile.toObject()
}

export async function resolveDID(did: string): Promise<AgentProfile | null> {
    return AgentProfileModel.findOne({ did }).lean()
}

export async function updateDIDDocument(
    did: string,
    updates: Partial<AgentProfile>
): Promise<AgentProfile | null> {
    const safe = { ...updates }
    // Immutable fields — never update
    delete safe.did
    delete safe.operatorId
    delete safe.walletPublicKey
    delete (safe as any).onChainSignature
    delete (safe as any).encryptedOperatorApiKey
    return AgentProfileModel.findOneAndUpdate({ did }, { $set: safe }, { returnDocument: 'after' }).lean()
}
