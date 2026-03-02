import { PublicKey } from '@solana/web3.js'
import nacl from 'tweetnacl'
import { hashMessage } from './signer'

export interface SignaturePayload {
    did: string
    timestamp: number
    method: string
    path: string
    bodyHash?: string
}

const SIGNATURE_TIME_WINDOW_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Parses a signature message in the format:
 * `${DID}::${timestamp}::${method}::${path}[::]${bodyHash}`
 * Uses :: as separator to avoid conflicts with : in DIDs
 */
export function parseSignatureMessage(message: string): SignaturePayload | null {
    const parts = message.split('::')
    if (parts.length < 4 || parts.length > 5) {
        return null
    }

    const [did, timestampStr, method, path, bodyHash] = parts
    const timestamp = parseInt(timestampStr, 10)

    if (!did.startsWith('did:memlybook:') || isNaN(timestamp)) {
        return null
    }

    return {
        did,
        timestamp,
        method,
        path,
        bodyHash: bodyHash || undefined
    }
}

/**
 * Validates a signature timestamp against current time.
 * Returns true if timestamp is within allowed window (±5 minutes).
 */
export function validateTimestamp(timestamp: number): boolean {
    const now = Date.now()
    const diff = Math.abs(now - timestamp)
    return diff <= SIGNATURE_TIME_WINDOW_MS
}

/**
 * Verifies an ed25519 signature using Solana wallet public key.
 * 
 * @param message - The message that was signed
 * @param signatureHex - The signature in hex format
 * @param walletPublicKeyB58 - The Solana wallet public key in base58 format
 * @returns true if signature is valid
 */
export function verifySignature(
    message: string,
    signatureHex: string,
    walletPublicKeyB58: string
): boolean {
    try {
        // Convert hex signature to Uint8Array
        const signatureBytes = Buffer.from(signatureHex, 'hex')
        if (signatureBytes.length !== 64) {
            console.warn('[SignatureValidator] Invalid signature length:', signatureBytes.length)
            return false
        }

        // Parse Solana public key (base58)
        const publicKey = new PublicKey(walletPublicKeyB58)
        const publicKeyBytes = publicKey.toBytes()

        // Hash message for signing (consistent with wallet signature behavior)
        const messageHash = hashMessage(message)
        const messageBytes = Buffer.from(messageHash, 'hex')

        // Verify ed25519 signature
        return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes)
    } catch (err) {
        console.warn('[SignatureValidator] Signature verification failed:', (err as Error).message)
        return false
    }
}

/**
 * Comprehensive signature validation combining format, timestamp, and cryptographic checks.
 * 
 * @param signatureHeader - The Signature header value
 * @param did - Expected DID from header
 * @param method - HTTP method
 * @param path - Request path
 * @param walletPublicKey - Agent's wallet public key from database
 * @param bodyHash - Optional body hash for POST/PUT requests
 * @returns true if all validations pass
 */
export function validateRequestSignature(
    signatureHeader: string,
    did: string,
    method: string,
    path: string,
    walletPublicKey: string,
    bodyHash?: string
): boolean {
    // Parse signature format: message|signature
    const separatorIndex = signatureHeader.lastIndexOf('|')
    if (separatorIndex === -1) {
        console.warn('[SignatureValidator] Invalid signature format — expected "message|signature"')
        return false
    }

    const message = signatureHeader.slice(0, separatorIndex)
    const signatureHex = signatureHeader.slice(separatorIndex + 1)

    // Parse message structure
    const payload = parseSignatureMessage(message)
    if (!payload) {
        console.warn('[SignatureValidator] Invalid message format')
        return false
    }
    if (payload.did !== did) {
        console.warn(`[SignatureValidator] DID mismatch — message: ${payload.did}, header: ${did}`)
        return false
    }
    if (payload.method !== method || payload.path !== path) {
        console.warn(`[SignatureValidator] Request mismatch — expected ${payload.method} ${payload.path}, got ${method} ${path}`)
        return false
    }
    if (!validateTimestamp(payload.timestamp)) {
        console.warn(`[SignatureValidator] Timestamp outside valid window — message age: ${Date.now() - payload.timestamp}ms`)
        return false
    }
    if (bodyHash && payload.bodyHash !== bodyHash) {
        console.warn('[SignatureValidator] Body hash mismatch')
        return false
    }

    // Verify cryptographic signature
    if (!verifySignature(message, signatureHex, walletPublicKey)) {
        console.warn('[SignatureValidator] Cryptographic signature verification failed')
        return false
    }

    return true
}
