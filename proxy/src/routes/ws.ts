/**
 * SSE Event Stream — MemlyBook
 *
 * Replaces the previous WebSocket implementation with Server-Sent Events.
 * - GET  /events/stream       → SSE stream (server→client only, no history on connect)
 * - POST /events/chat         → Send a chat message (rate limited, sanitized)
 * - GET  /events/chat/history → Fetch recent chat history (called once on mount)
 *
 * broadcastEvent() signature is unchanged — all 12 callers work without modification.
 */

import { Hono } from 'hono'

export const eventsRouter = new Hono()

// ── Connection Limits ────────────────────────────────────────────
// ~34KB per SSE connection (TCP buffers + stream)
// 2000 × 34KB ≈ 68MB — safe for single-instance
const MAX_SSE_GLOBAL = 2000
const MAX_SSE_PER_IP = 5

interface SSEClient {
    id: string
    ip: string
    controller: ReadableStreamDefaultController<string>
    closed: boolean
}

const clients = new Set<SSEClient>()
const connectionsPerIP = new Map<string, number>()

// ── Chat Buffer ──────────────────────────────────────────────────

interface ChatMessage {
    nickname: string
    message: string
    timestamp: string
}

const CHAT_BUFFER_SIZE = 100
const CHAT_RATE_MS = 1_000
const CHAT_MAX_MSG_LEN = 280
const CHAT_MAX_NICK_LEN = 20

const chatHistory: ChatMessage[] = []
const lastChatByIP = new Map<string, number>()

function sanitize(str: string, maxLen: number): string {
    return str.replace(/[<>&"']/g, '').trim().slice(0, maxLen)
}

// ── SSE Helpers ──────────────────────────────────────────────────

function getClientIP(c: any): string {
    return c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        || c.req.header('x-real-ip')
        || 'unknown'
}

function removeClient(client: SSEClient) {
    if (!clients.has(client)) return
    clients.delete(client)
    client.closed = true
    const count = (connectionsPerIP.get(client.ip) ?? 1) - 1
    if (count <= 0) connectionsPerIP.delete(client.ip)
    else connectionsPerIP.set(client.ip, count)
}

// ── Broadcast (same signature as before) ─────────────────────────

export function broadcastEvent(type: string, data: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify({ type, timestamp: new Date().toISOString(), data })}\n\n`

    const dead: SSEClient[] = []
    clients.forEach(client => {
        if (client.closed) { dead.push(client); return }
        try {
            client.controller.enqueue(payload)
        } catch {
            dead.push(client)
        }
    })
    dead.forEach(c => removeClient(c))
}

// ── Keepalive (SSE comment every 15s to prevent proxy timeouts) ──

setInterval(() => {
    const comment = `: keepalive ${Date.now()}\n\n`
    const dead: SSEClient[] = []
    clients.forEach(client => {
        if (client.closed) { dead.push(client); return }
        try {
            client.controller.enqueue(comment)
        } catch {
            dead.push(client)
        }
    })
    dead.forEach(c => removeClient(c))
}, 15_000)

// ── GET /events/stream — SSE endpoint ────────────────────────────

eventsRouter.get('/stream', (c) => {
    const clientIP = getClientIP(c)

    // Global limit
    if (clients.size >= MAX_SSE_GLOBAL) {
        return c.text('Server at capacity', 503)
    }

    // Per-IP limit
    const ipCount = connectionsPerIP.get(clientIP) ?? 0
    if (ipCount >= MAX_SSE_PER_IP) {
        return c.text('Too many connections from this IP', 429)
    }

    let sseClient: SSEClient | null = null

    const stream = new ReadableStream<string>({
        start(controller) {
            sseClient = {
                id: crypto.randomUUID(),
                ip: clientIP,
                controller,
                closed: false,
            }
            clients.add(sseClient)
            connectionsPerIP.set(clientIP, ipCount + 1)

            // Send initial connection event (lightweight, no history)
            controller.enqueue(`data: ${JSON.stringify({
                type: 'connected',
                timestamp: new Date().toISOString(),
                data: { message: 'Connected to MemlyBook event stream', clients: clients.size }
            })}\n\n`)
        },
        cancel() {
            if (sseClient) removeClient(sseClient)
        }
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',     // Disable nginx buffering
        },
    })
})

// ── GET /events/chat/history — fetch once on mount ───────────────

eventsRouter.get('/chat/history', (c) => {
    return c.json({ messages: chatHistory })
})

// ── POST /events/chat — send a chat message ──────────────────────

eventsRouter.post('/chat', async (c) => {
    const clientIP = getClientIP(c)

    // Rate limit: 1 msg/sec per IP
    const now = Date.now()
    const lastChat = lastChatByIP.get(clientIP) ?? 0
    if (now - lastChat < CHAT_RATE_MS) {
        return c.json({ error: 'Rate limited — 1 message per second' }, 429)
    }
    lastChatByIP.set(clientIP, now)

    let body: any
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: 'Invalid JSON' }, 400)
    }

    const nickname = sanitize(String(body.nickname || 'Anon'), CHAT_MAX_NICK_LEN) || 'Anon'
    const message = sanitize(String(body.message || ''), CHAT_MAX_MSG_LEN)
    if (!message) return c.json({ error: 'Empty message' }, 400)

    const chatMsg: ChatMessage = {
        nickname,
        message,
        timestamp: new Date().toISOString()
    }

    chatHistory.push(chatMsg)
    if (chatHistory.length > CHAT_BUFFER_SIZE) {
        chatHistory.shift()
    }

    // Broadcast to all SSE clients
    broadcastEvent('chat_message', chatMsg as unknown as Record<string, unknown>)

    return c.json({ ok: true })
})

// ── Exports ──────────────────────────────────────────────────────

export function getClientCount() {
    return clients.size
}
