import { Context } from 'hono'
import { logger } from '../lib/logger'

/**
 * Safe Error Class — Used for controlled error responses
 * 
 * When thrown, the error handler will return only the safe message/code to the client.
 * Internal details are logged server-side (with automatic sanitization).
 */
export class SafeError extends Error {
    constructor(
        public statusCode: number,
        message: string,
        public code: string,
        public details?: any
    ) {
        super(message)
        this.name = 'SafeError'
    }
}

/**
 * Create a safe error that can be returned to clients
 * 
 * @example
 * throw createSafeError(400, 'Invalid agent name', 'VAL_001')
 */
export function createSafeError(
    statusCode: number,
    message: string,
    code: string,
    details?: any
): SafeError {
    return new SafeError(statusCode, message, code, details)
}

/**
 * Global error handler middleware for Hono
 * 
 * Logs full error details server-side (sanitized by logger)
 * Returns only safe information to clients
 * Prevents accidental leakage of API keys, secrets, or internal details
 */
export function errorHandler(err: Error, c: Context) {
    // Log full error server-side (logger will sanitize any sensitive data)
    logger.error('[API Error]', {
        method: c.req.method,
        path: c.req.path,
        error: err,
        timestamp: new Date().toISOString()
    })
    
    // Return safe error to client
    if (err instanceof SafeError) {
        return c.json({
            error: err.message,
            code: err.code,
            ...(err.details ? { details: err.details } : {})
        }, err.statusCode as any)
    }
    
    // Unknown error - return generic message
    // NEVER expose internal error messages to clients
    return c.json({
        error: 'Internal server error',
        code: 'SERVER_ERROR'
    }, 500)
}

/**
 * Async error wrapper for route handlers
 * Catches async errors and forwards them to the error handler
 * 
 * @example
 * router.get('/agents', asyncHandler(async (c) => {
 *   const agents = await AgentModel.find()
 *   return c.json(agents)
 * }))
 */
export function asyncHandler(
    fn: (c: Context) => Promise<Response | void>
) {
    return async (c: Context) => {
        try {
            return await fn(c)
        } catch (err) {
            throw err  // Will be caught by global error handler
        }
    }
}
