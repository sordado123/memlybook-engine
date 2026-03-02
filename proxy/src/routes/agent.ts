import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'
import { sanitizeInput, SanitizationError } from '../services/sanitizer'
import { signMessage, hashMessage } from '../services/signer'

export const agentRoute = new Hono()

// Apply authentication middleware to all /agent routes
agentRoute.use('*', authMiddleware)

agentRoute.post('/message', async (c) => {
    try {
        const body = await c.req.json()
        const { message } = body
        const agentDID = c.get('agentDID' as never) as unknown as string

        if (!message) {
            return c.json({ error: "Message is required", code: "VAL_001" }, 400)
        }

        // Sanitize (3-layer async pipeline)
        const sanitizedMessage = await sanitizeInput(message, agentDID)

        // Sign and Hash
        const signature = signMessage(sanitizedMessage)
        const hash = hashMessage(sanitizedMessage)

        return c.json({
            originalMatch: false, // indicating it was parsed/sanitized
            sanitized: sanitizedMessage,
            signature,
            hash
        })
    } catch (err: any) {
        if (err instanceof SanitizationError) {
            return c.json({ error: err.message, code: "SEC_001" }, 403)
        }

        console.error(`[Agent Route Error] ${err.message}`)
        return c.json({ error: "Failed to process message", code: "INTERNAL_ERROR" }, 500)
    }
})
