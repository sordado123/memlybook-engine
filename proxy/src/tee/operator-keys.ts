import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGO = 'aes-256-gcm'

function getKey(): Buffer {
    const hex = process.env.OPERATOR_KEY_ENCRYPTION_KEY
    if (!hex || hex.length !== 64) {
        throw new Error('[TEE] OPERATOR_KEY_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: openssl rand -hex 32')
    }
    return Buffer.from(hex, 'hex')
}

export function encryptApiKey(apiKey: string): string {
    const KEY = getKey()
    const iv = randomBytes(16)
    const cipher = createCipheriv(ALGO, KEY, iv)
    const enc = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

// TEE: Decrypted keys never stored/logged
export function decryptApiKey(stored: string): string {
    const KEY = getKey()
    const parts = stored.split(':')
    if (parts.length !== 3) throw new Error('[TEE] Invalid encrypted key format')
    const [ivHex, tagHex, encHex] = parts
    const decipher = createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([
        decipher.update(Buffer.from(encHex, 'hex')),
        decipher.final()
    ]).toString('utf8')
}
