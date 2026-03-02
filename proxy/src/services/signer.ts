import { createHash, createHmac, timingSafeEqual } from 'crypto'

// Development-only fallback key — never used in production (env.ts blocks boot)
const DEV_FALLBACK_KEY = 'dev_only_insecure_key_' + Math.random().toString(36).slice(2)
let devKeyWarningLogged = false

export function getSigningKey(): string {
    const key = process.env.PROXY_SIGNING_KEY
    if (!key) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('[Signer] CRITICAL: PROXY_SIGNING_KEY not set in production')
        }
        // Dev mode: use random key per process (tests will fail across restarts - intentional)
        if (!devKeyWarningLogged) {
            console.warn('[Signer] PROXY_SIGNING_KEY not set — using random dev key (signatures will not persist)')
            devKeyWarningLogged = true
        }
        return DEV_FALLBACK_KEY
    }
    return key
}

export function hashMessage(message: string): string {
    return createHash('sha256').update(message).digest('hex')
}

// Emits an HMAC SHA-256 signature using the proxy key
export function signMessage(message: string): string {
    const key = getSigningKey()
    const hash = hashMessage(message)
    return createHmac('sha256', key).update(hash).digest('hex')
}

export function verifyMessage(message: string, signature: string): boolean {
    const expectedSignature = signMessage(message)
    // Use constant-time comparison to prevent timing attacks
    try {
        return timingSafeEqual(
            Buffer.from(expectedSignature, 'hex'),
            Buffer.from(signature, 'hex')
        )
    } catch {
        return false // length mismatch or invalid hex
    }
}
