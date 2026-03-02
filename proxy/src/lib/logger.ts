import { createHash } from 'crypto'

/**
 * Security Logger — Automatic API Key Sanitization
 * 
 * Prevents accidental leakage of sensitive data in logs by detecting and
 * redacting API keys, tokens, encrypted values, and other secrets.
 * 
 * Usage:
 *   import { logger } from './lib/logger'
 *   logger.info('Processing agent:', agentData)  // Keys automatically redacted
 */

const SENSITIVE_PATTERNS = [
    // OpenAI API keys
    { pattern: /sk-[a-zA-Z0-9]{48}/g, name: 'OpenAI' },
    { pattern: /sk-proj-[a-zA-Z0-9\-_]{48,}/g, name: 'OpenAI-Project' },
    
    // Anthropic API keys (more flexible length)
    { pattern: /sk-ant-api\d+-[a-zA-Z0-9\-_]{80,}/g, name: 'Anthropic' },
    
    // Google API keys
    { pattern: /AIza[a-zA-Z0-9_\-]{35}/g, name: 'Google' },
    
    // Generic API keys
    { pattern: /api[_-]?key["\s:=]+[a-zA-Z0-9\-_]{20,}/gi, name: 'Generic-API' },
    { pattern: /bearer\s+[a-zA-Z0-9\-_\.]{20,}/gi, name: 'Bearer-Token' },
    
    // Solana private keys (base58, 87-88 chars)
    { pattern: /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/g, name: 'Solana-Private' },
    
    // Our encrypted key format (hex:hex:hex)
    { pattern: /[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]{64,}/g, name: 'Encrypted' },
    
    // JWT tokens
    { pattern: /eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, name: 'JWT' },
]

/**
 * Hash a sensitive value to create a consistent identifier
 * Shows first 4 and last 4 chars + hash for debugging
 */
function hashSensitiveValue(value: string, type: string): string {
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 8)
    
    if (value.length <= 8) {
        return `[REDACTED:${type}:***${hash}]`
    }
    
    return `[REDACTED:${type}:${value.slice(0, 4)}...${value.slice(-4)}_${hash}]`
}

/**
 * Sanitize a string by replacing sensitive patterns
 */
function sanitizeString(input: string): string {
    let sanitized = input
    
    for (const { pattern, name } of SENSITIVE_PATTERNS) {
        sanitized = sanitized.replace(pattern, (match) => {
            return hashSensitiveValue(match, name)
        })
    }
    
    return sanitized
}

/**
 * Recursively sanitize an object, array, or primitive value
 */
function sanitizeObject(obj: any, depth = 0): any {
    // Prevent infinite recursion
    if (depth > 10) return '[MAX_DEPTH_EXCEEDED]'
    
    // Handle null/undefined
    if (obj === null || obj === undefined) return obj
    
    // Handle strings (might contain keys)
    if (typeof obj === 'string') {
        return sanitizeString(obj)
    }
    
    // Handle primitives
    if (typeof obj === 'number' || typeof obj === 'boolean') {
        return obj
    }
    
    // Handle Errors specially (preserve stack trace)
    if (obj instanceof Error) {
        return {
            name: obj.name,
            message: sanitizeString(obj.message),
            stack: obj.stack ? sanitizeString(obj.stack) : undefined,
            ...(obj.cause ? { cause: sanitizeObject(obj.cause, depth + 1) } : {})
        }
    }
    
    // Handle Arrays
    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeObject(item, depth + 1))
    }
    
    // Handle plain objects
    if (typeof obj === 'object') {
        // Prevent logging process.env entirely
        if (obj === process.env) {
            throw new Error('[SECURITY] Attempted to log process.env! This is forbidden.')
        }
        
        const sanitized: any = {}
        
        for (const [key, value] of Object.entries(obj)) {
            // Redact fields with sensitive names entirely
            const lowerKey = key.toLowerCase()
            if (
                lowerKey.includes('apikey') ||
                lowerKey.includes('api_key') ||
                lowerKey.includes('secret') ||
                lowerKey.includes('token') ||
                lowerKey.includes('password') ||
                lowerKey.includes('private') ||
                lowerKey.includes('encrypted')
            ) {
                sanitized[key] = `[REDACTED:field=${key}]`
            } else {
                sanitized[key] = sanitizeObject(value, depth + 1)
            }
        }
        
        return sanitized
    }
    
    // Unknown type, stringify safely
    return String(obj)
}

/**
 * Safe logger that sanitizes all output
 */
export const logger = {
    /**
     * Log informational messages
     */
    info(...args: any[]) {
        const sanitized = args.map(arg => sanitizeObject(arg))
        console.log(...sanitized)
    },
    
    /**
     * Log warning messages
     */
    warn(...args: any[]) {
        const sanitized = args.map(arg => sanitizeObject(arg))
        console.warn(...sanitized)
    },
    
    /**
     * Log error messages
     */
    error(...args: any[]) {
        const sanitized = args.map(arg => sanitizeObject(arg))
        console.error(...sanitized)
    },
    
    /**
     * Log debug messages (only in non-production)
     */
    debug(...args: any[]) {
        if (process.env.NODE_ENV !== 'production') {
            const sanitized = args.map(arg => sanitizeObject(arg))
            console.debug(...sanitized)
        }
    }
}

/**
 * Test the sanitizer with known patterns
 */
export function testSanitizer() {
    console.log('\n[Logger Security Test]\n')
    
    const tests = [
        {
            name: 'OpenAI API Key',
            value: 'sk-1234567890abcdefghijklmnopqrstuvwxyz1234567890ab'
        },
        {
            name: 'Anthropic API Key',
            value: 'sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-aBcDeFgHiJk'
        },
        {
            name: 'Bearer Token',
            value: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
        },
        {
            name: 'Object with apiKey',
            value: { apiKey: 'sk-secret123', data: 'public', nested: { token: 'abc123' } }
        },
        {
            name: 'Error with key in message',
            value: new Error('Failed with key: sk-test123456789012345678901234567890123456789012')
        },
        {
            name: 'Encrypted key format',
            value: 'abc123def456789012345678901234:def456789012345678901234567890:789ghi012345678901234567890123456789012345678901234567890123456789012'
        }
    ]
    
    tests.forEach(({ name, value }) => {
        console.log(`\nTest: ${name}`)
        console.log('Original type:', typeof value)
        console.log('Sanitized:')
        logger.info(value)
    })
    
    console.log('\n[Test Complete - All sensitive data should be redacted]\n')
}

// Run tests if executed directly
if (import.meta.main) {
    testSanitizer()
}
