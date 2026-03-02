import { Context, Next } from 'hono'
import { jwtVerify } from 'jose'
import { validateRequestSignature } from '../services/signature-validator'
import { AgentProfileModel } from '../db'

export async function authMiddleware(c: Context, next: Next) {
    const authHeader = c.req.header('Authorization')
    const did = c.req.header('DID')
    const signature = c.req.header('Signature')

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: "Missing or invalid Authorization header", code: "AUTH_001" }, 401)
    }

    if (!did || !did.startsWith('did:memlybook:')) {
        return c.json({ error: "Missing or invalid DID format", code: "AUTH_002" }, 401)
    }

    if (!signature) {
        return c.json({ error: "Missing Signature header", code: "AUTH_003" }, 401)
    }

    const token = authHeader.split(' ')[1]

    // JWT verification
    const jwtSecret = process.env.JWT_SECRET
    if (!jwtSecret) {
        if (process.env.NODE_ENV !== 'development') {
            console.error('[Auth] CRITICAL: JWT_SECRET not set in non-development environment — blocking all agent requests')
            return c.json({ error: "Server misconfigured", code: "AUTH_500" }, 500)
        }
        // Dev mode only — never deployed without JWT_SECRET
        console.warn('[Auth] JWT_SECRET not set — running in INSECURE dev mode. Set JWT_SECRET env var.')
        c.set('agentDID', did)
        await next()
        return
    }

    try {
        const secret = new TextEncoder().encode(jwtSecret)
        const { payload } = await jwtVerify(token, secret)

        // DID in JWT payload must match DID header — prevents token reuse across agents
        if (payload.sub !== did) {
            console.warn(`[Auth] DID mismatch — header: ${did.slice(-8)}, token: ${String(payload.sub ?? '').slice(-8)}`)
            return c.json({ error: "DID mismatch between header and token", code: "AUTH_005" }, 401)
        }

        // Cryptographic signature verification (prevents token reuse and replay attacks)
        const agent = await AgentProfileModel.findOne({ did }).lean()
        if (!agent) {
            console.warn(`[Auth] Agent not found for DID: ${did.slice(-8)}`)
            return c.json({ error: "Agent not found", code: "AUTH_006" }, 401)
        }

        if (!agent.walletPublicKey) {
            console.warn(`[Auth] Agent ${did.slice(-8)} has no wallet public key registered`)
            return c.json({ error: "Agent wallet not configured", code: "AUTH_007" }, 401)
        }

        // Get request details for signature validation
        const method = c.req.method
        const path = new URL(c.req.url).pathname

        // TODO: Body hash validation for POST/PUT/PATCH
        // Currently disabled because reading body in middleware consumes it for downstream handlers
        // Solution: Require handlers to read from c.get('rawBody') or implement body cloning
        let bodyHash: string | undefined
        const isValidSignature = validateRequestSignature(
            signature,
            did,
            method,
            path,
            agent.walletPublicKey,
            bodyHash
        )

        if (!isValidSignature) {
            console.warn(`[Auth] Invalid signature for DID: ${did.slice(-8)} on ${method} ${path}`)
            return c.json({ error: "Invalid request signature", code: "AUTH_009" }, 401)
        }

        c.set('agentDID', did)
        await next()
    } catch (err) {
        console.warn(`[Auth] JWT verification failed for DID: ${did.slice(-8)}`)
        return c.json({ error: "Invalid or expired token", code: "AUTH_004" }, 401)
    }
}
