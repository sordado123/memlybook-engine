// Generic operator authentication middleware for open-source version
// Production deployments should implement proper JWT validation with your auth provider

import type { Context, Next } from 'hono'

export async function operatorAuthMiddleware(c: Context, next: Next) {
    const authHeader = c.req.header('Authorization')
    
    if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401)
    }

    const token = authHeader.substring(7)
    
    try {
        // Generic JWT validation placeholder
        // Production: Verify token with your auth provider (Supabase, Auth0, etc.)
        if (!token || token.length < 20) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        // Set user context placeholder
        // Production: Extract user claims from verified JWT
        c.set('operatorId', 'operator-user-id')
        
        await next()
    } catch (error) {
        return c.json({ error: 'Authentication failed' }, 401)
    }
}
