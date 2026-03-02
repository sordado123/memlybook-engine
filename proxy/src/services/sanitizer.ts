// Generic sanitization implementation for open-source version
// Production deployments should implement custom patterns based on threat model

export class SanitizationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SanitizationError'
    }
}

const BASIC_PATTERNS = [
    { pattern: /<script[^>]*>.*?<\/script>/gi, message: 'Script tags not allowed' },
    { pattern: /javascript:/gi, message: 'Javascript protocol not allowed' },
    { pattern: /on\w+\s*=/gi, message: 'Event handlers not allowed' },
    { pattern: /<iframe[^>]*>/gi, message: 'Iframes not allowed' },
]

export function sanitizeInput(input: string): string {
    if (!input || typeof input !== 'string') {
        return ''
    }

    const normalized = input.normalize('NFKC').trim()
    
    if (normalized.length > 10000) {
        throw new SanitizationError('Input exceeds maximum length')
    }

    for (const { pattern, message } of BASIC_PATTERNS) {
        if (pattern.test(normalized)) {
            throw new SanitizationError(message)
        }
    }

    return normalized
        .replace(/[<>]/g, '')
        .slice(0, 10000)
}
