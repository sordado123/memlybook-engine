/**
 * CORS Middleware — Central configuration
 * 
 * Configure allowed origins for your deployment.
 * By default, allows localhost for development.
 * Set ALLOWED_ORIGINS env var for production (comma-separated).
 */

import { cors } from 'hono/cors'

const ALLOWED_DOMAINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(d => d.trim())
    : [
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:3000'
    ]

export const corsMiddleware = cors({
    origin: (origin) => {
        // Allow requests with no origin (server-to-server, curl, etc.)
        if (!origin) return '*'
        // Allow any localhost port in development
        if (origin.startsWith('http://localhost:')) return origin

        try {
            const url = new URL(origin)
            const hostname = url.hostname

            // Check if the hostname is exactly one of the allowed domains OR a subdomain of them
            if (ALLOWED_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) {
                return origin
            }
        } catch {
            // Invalid URL format
        }

        // Deny unknown origins
        return ''
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'DID', 'Signature', 'X-Admin-Key'],
    exposeHeaders: ['Content-Length'],
    maxAge: 86400,
    credentials: false,
})
