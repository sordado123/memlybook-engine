import { Keypair, Connection, PublicKey, Transaction, clusterApiUrl } from '@solana/web3.js'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { WalletModel } from '../db/models/wallet.model'

// TEE: Keys encrypted with AES-256-GCM, zeroed after use. No private key exports.
const ALGO = 'aes-256-gcm'

const connection = new Connection(
    process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet'),
    'confirmed'
)

function getEncryptionKey(): Buffer {
    const hex = process.env.WALLET_ENCRYPTION_KEY
    if (!hex || hex.length !== 64) {
        throw new Error('[TEE] WALLET_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Run: openssl rand -hex 32')
    }
    return Buffer.from(hex, 'hex')
}

function encryptKey(secretKey: Uint8Array): string {
    const KEY = getEncryptionKey()
    const iv = randomBytes(16)
    const cipher = createCipheriv(ALGO, KEY, iv)
    const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

function decryptKey(stored: string): Uint8Array {
    const KEY = getEncryptionKey()
    const parts = stored.split(':')
    if (parts.length !== 3) throw new Error('[TEE] Invalid encrypted wallet format')
    const [ivHex, tagHex, encHex] = parts
    const decipher = createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encHex, 'hex')),
        decipher.final()
    ])
    return new Uint8Array(decrypted)
}

// ── Public API — private key NEVER leaves this module ────────────────────────

export async function generateAgentWallet(agentDID: string): Promise<string> {
    const existing = await WalletModel.findOne({ agentDID }).lean()
    if (existing) throw new Error(`[TEE] Wallet already exists for: ${agentDID}`)

    const keypair = Keypair.generate()
    const encryptedKey = encryptKey(keypair.secretKey)
    const publicKey = keypair.publicKey.toBase58()

    await WalletModel.create({ agentDID, encryptedKey, publicKey })

    // SOL + $AGENT provisioning happens in airdrop.ts after the Challenge Gate.
    // No faucet call here — treasury funds the agent directly.
    console.log(`[TEE] Wallet created for ${agentDID.slice(-8)} → ${publicKey}`)

    // Zero the keypair bytes immediately — encrypted copy is in MongoDB
    keypair.secretKey.fill(0)

    return publicKey
}

/**
 * Ensures the platform wallet exists in TEE storage (WalletModel).
 * Uses the existing PLATFORM_WALLET_SECRET_KEY from environment.
 * This is required for transaction intents FROM the platform (airdrops, payouts).
 */
export async function ensurePlatformWallet(platformDID: string, platformSecretKeyJson: string): Promise<void> {
    const existing = await WalletModel.findOne({ agentDID: platformDID }).lean()
    if (existing) {
        console.log(`[TEE] Platform wallet already exists: ${platformDID}`)
        return
    }

    // Parse and encrypt the platform's existing keypair
    const secretKey = new Uint8Array(JSON.parse(platformSecretKeyJson) as number[])
    const keypair = Keypair.fromSecretKey(secretKey)
    const encryptedKey = encryptKey(secretKey)
    const publicKey = keypair.publicKey.toBase58()

    await WalletModel.create({ agentDID: platformDID, encryptedKey, publicKey })

    console.log(`[TEE] Platform wallet registered: ${platformDID} → ${publicKey}`)

    // Zero sensitive data immediately
    secretKey.fill(0)
}

export async function getPublicKey(agentDID: string): Promise<string> {
    const wallet = await WalletModel.findOne({ agentDID }).lean()
    if (!wallet) throw new Error(`[TEE] Wallet not found for: ${agentDID}`)
    return wallet.publicKey
}

export async function signTransaction(agentDID: string, transaction: Transaction, feePayerKeypair?: Keypair): Promise<Buffer> {
    const wallet = await WalletModel.findOne({ agentDID }).lean()
    if (!wallet) throw new Error(`[TEE] Wallet not found for: ${agentDID}`)

    // Decrypt in memory, sign, then zero immediately
    const secretKey = decryptKey(wallet.encryptedKey)
    const keypair = Keypair.fromSecretKey(secretKey)

    try {
        const { blockhash } = await connection.getLatestBlockhash()
        transaction.recentBlockhash = blockhash

        if (feePayerKeypair) {
            transaction.feePayer = feePayerKeypair.publicKey
            transaction.partialSign(keypair)
            transaction.partialSign(feePayerKeypair)
        } else {
            transaction.feePayer = keypair.publicKey
            transaction.partialSign(keypair)
        }

        return transaction.serialize()
    } finally {
        // Zero both references — even if an error occurs
        secretKey.fill(0)
            ; (keypair.secretKey as Uint8Array).fill(0)
    }
}

export async function getBalance(agentDID: string): Promise<number> {
    const publicKey = await getPublicKey(agentDID)
    const balance = await connection.getBalance(new PublicKey(publicKey))
    return balance / 1e9  // lamports → SOL
}
