import { Hono } from 'hono'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { OperatorModel } from '../db/models/operator.model'
import { operatorAuthMiddleware } from '../middleware/operator-auth'

type OperatorEnv = {
    Variables: { operatorId: string, operatorEmail: string }
}

export const operatorAuthRouter = new Hono<OperatorEnv>()

// Instantiate Supabase outside the handler (using ANON_KEY, not SERVICE_KEY)
const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || '').trim()
const supabaseAdmin = (supabaseUrl && supabaseAnonKey)
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null

// ── Validation Schemas ──────────────────────────────────────────────────────

const syncSchema = z.object({
    displayName: z.string().trim().max(60).regex(/^[^\$\{\}<>]+$/).optional()
})

// ── POST /operator/sync ──────────────────────────────────────────────────────
// This endpoint is called once by the frontend immediately after a successful 
// Supabase Login (Email or OAuth). It ensures the MongoDB operator profile exists.

operatorAuthRouter.post('/sync', operatorAuthMiddleware, async (c) => {
    try {
        const operatorId = c.get('operatorId')
        const operatorEmail = c.get('operatorEmail') || ''

        // Try to get full user data from Supabase (may fail with ES256 tokens)
        let twitterId: string | null = null
        let twitterHandle: string | null = null
        let userEmail: string | null = operatorEmail || null
        let userDisplayName: string | null = null

        try {
            const authHeader = c.req.header('Authorization')
            if (authHeader && supabaseAdmin) {
                const token = authHeader.split(' ')[1]
                const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

                if (!error && user) {
                    userEmail = user.email || userEmail
                    userDisplayName = user.user_metadata?.displayName
                        || user.user_metadata?.full_name
                        || user.user_metadata?.name
                        || null

                    const twitterIdentity = user.identities?.find(i => i.provider === 'twitter')
                    if (twitterIdentity) {
                        twitterId = twitterIdentity.id ?? null
                        twitterHandle = twitterIdentity.identity_data?.user_name
                            || twitterIdentity.identity_data?.preferred_username
                            || null
                    }
                } else {
                    console.warn(`[Auth Sync] getUser failed (continuing with JWT data):`, error?.message)
                }
            }
        } catch (supaErr: any) {
            console.warn(`[Auth Sync] Supabase lookup failed (continuing):`, supaErr.message)
        }

        const body = await c.req.json().catch(() => ({}))
        const parsed = syncSchema.safeParse(body)
        const bodyDisplayName = parsed.success ? parsed.data.displayName : undefined

        const displayName = userDisplayName
            || twitterHandle
            || bodyDisplayName
            || (userEmail ? userEmail.split('@')[0] : null)
            || `User_${operatorId.slice(0, 6)}`

        // Upsert operator profile
        const updateFields: Record<string, any> = {
            lastLoginAt: new Date(),
            ...(twitterId && { twitterId }),
            ...(twitterHandle && { twitterHandle }),
            ...(userEmail && { email: userEmail }),
            displayName
        }

        const operator = await OperatorModel.findOneAndUpdate(
            { operatorId },
            {
                $setOnInsert: { operatorId, createdAt: new Date(), agentCount: 0 },
                $set: updateFields
            },
            { upsert: true, returnDocument: 'after' }
        ).select('operatorId displayName').lean()

        return c.json({ success: true, operator })
    } catch (err: any) {
        console.error(`[Auth Sync] Error syncing operator ${c.get('operatorId')}:`, err)
        return c.json({ error: "Failed to sync operator profile", code: "SYNC_500" }, 500)
    }
})

// ── GET /operator/me — requires auth ────────────────────────────────────────

operatorAuthRouter.get('/me', operatorAuthMiddleware, async (c) => {
    try {
        const operatorId = c.get('operatorId') as string
        const operator = await OperatorModel.findOne({ operatorId }).lean()

        if (!operator) {
            return c.json({ error: "Operator not found", code: "ME_001" }, 404)
        }

        return c.json({ operator })
    } catch (err: any) {
        return c.json({ error: "Failed to fetch profile", code: "ME_500" }, 500)
    }
})
