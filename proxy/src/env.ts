/**
 * Environment Variable Validation
 * 
 * This module validates all critical environment variables at boot time.
 * In production, missing required variables will cause the process to exit.
 * In development, warnings are logged but the process continues.
 */

interface EnvRule {
    name: string
    required: boolean          // Required in production
    requiredDev?: boolean      // Also required in development
    validator?: (value: string) => boolean
    description: string
}

const ENV_RULES: EnvRule[] = [
    {
        name: 'MONGODB_URI',
        required: true,
        requiredDev: true,
        description: 'MongoDB Atlas connection string'
    },
    {
        name: 'REDIS_URL',
        required: true,
        description: 'Redis connection string for BullMQ workers'
    },
    {
        name: 'WALLET_ENCRYPTION_KEY',
        required: true,
        validator: (v) => /^[a-fA-F0-9]{64}$/.test(v),
        description: 'AES-256 key (64 hex chars). Generate with: openssl rand -hex 32'
    },
    {
        name: 'JWT_SECRET',
        required: true,
        validator: (v) => v.length >= 32,
        description: 'JWT signing secret (min 32 chars). Generate with: openssl rand -base64 32'
    },
    {
        name: 'ADMIN_SECRET_KEY',
        required: true,
        validator: (v) => v.length >= 32,
        description: 'Admin API key (min 32 chars). Generate with: openssl rand -base64 32'
    },
    {
        name: 'PROXY_SIGNING_KEY',
        required: true,
        validator: (v) => v.length >= 32,
        description: 'HMAC signing key (min 32 chars). Generate with: openssl rand -hex 32'
    },
    {
        name: 'PLATFORM_DID',
        required: true,
        description: 'DID of the platform treasury agent (e.g. did:memlybook:platform). Must exist in MongoDB.'
    },
    {
        name: 'PLATFORM_WALLET_SECRET_KEY',
        required: true,
        description: 'Solana platform keypair as JSON number array. Generate: solana-keygen new --outfile platform-wallet.json'
    },
    {
        name: 'OPENAI_KEY',
        required: true,
        description: 'OpenAI API key — required for Code Duel judge, Alympics judge, and game content generation'
    },
    {
        name: 'VOYAGE_API_KEY',
        required: false,
        description: 'Voyage AI API key for embeddings (optional but recommended)'
    },
    {
        name: 'SOLANA_RPC_URL',
        required: false,
        description: 'Solana RPC URL (defaults to devnet)'
    }
]

export function validateEnv(): void {
    const isProduction = process.env.NODE_ENV === 'production'
    const errors: string[] = []
    const warnings: string[] = []

    for (const rule of ENV_RULES) {
        const value = process.env[rule.name]
        const isRequired = isProduction ? rule.required : rule.requiredDev

        if (!value) {
            if (isRequired) {
                errors.push(`❌ ${rule.name}: ${rule.description}`)
            } else if (rule.required) {
                warnings.push(`⚠️  ${rule.name} not set (required in production): ${rule.description}`)
            }
            continue
        }

        if (rule.validator && !rule.validator(value)) {
            errors.push(`❌ ${rule.name} invalid format: ${rule.description}`)
        }
    }

    // Log warnings first
    if (warnings.length > 0) {
        console.warn('\n[Env] Missing environment variables (will fail in production):')
        warnings.forEach(w => console.warn(w))
        console.warn('')
    }

    // Fail on errors
    if (errors.length > 0) {
        console.error('\n[Env] CRITICAL: Missing required environment variables:\n')
        errors.forEach(e => console.error(e))
        console.error('\nSet these variables and restart the server.\n')
        process.exit(1)
    }

    if (isProduction) {
        console.log('[Env] All required environment variables validated ✓')
    }
}
