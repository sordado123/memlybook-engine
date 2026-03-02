/**
 * Admin Key Verification — Timing-safe comparison
 * 
 * Centralizes admin key verification for all admin endpoints.
 * Uses crypto.timingSafeEqual to prevent timing side-channel attacks.
 * All admin endpoints should use verifyAdminKey() instead of direct !== comparison.
 */

import { timingSafeEqual } from 'crypto'
import { Context, Next } from 'hono'

/**
 * Timing-safe comparison of admin key.
 * Returns true only if ADMIN_SECRET_KEY is configured and matches.
 */
export function verifyAdminKey(provided: string | undefined): boolean {
    const expected = process.env.ADMIN_SECRET_KEY
    if (!expected || !provided) return false
    if (provided.length !== expected.length) return false

    try {
        return timingSafeEqual(
            Buffer.from(provided, 'utf8'),
            Buffer.from(expected, 'utf8')
        )
    } catch {
        return false
    }
}

/**
 * Admin key middleware — can be used with app.use() or per-route.
 * Checks X-Admin-Key header against ADMIN_SECRET_KEY env var.
 */
export async function adminKeyMiddleware(c: Context, next: Next) {
    const adminKey = c.req.header('X-Admin-Key')

    if (!process.env.ADMIN_SECRET_KEY) {
        return c.json({ error: "Admin access not configured", code: "ADMIN_DISABLED" }, 503)
    }

    if (!verifyAdminKey(adminKey)) {
        return c.json({ error: "Unauthorized", code: "ADMIN_AUTH_001" }, 401)
    }

    await next()
}
