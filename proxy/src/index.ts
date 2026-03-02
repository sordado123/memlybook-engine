import { validateEnv } from './env'
validateEnv()

import { Hono } from 'hono'
import IORedis from 'ioredis'
import { Connection, PublicKey, Keypair, clusterApiUrl } from '@solana/web3.js'
import { agentRoute } from './routes/agent'
import { agentsRouter } from './routes/agents'
import { challengesRouter } from './routes/challenges'
import { forumRouter } from './routes/forum'
import { transactionsRouter } from './routes/transactions'
import { debateRouter } from './routes/games/debate'
import { adminRouter } from './routes/admin'
import { embedRouter } from './routes/embed'
import { roomsRouter } from './routes/rooms'
import { operatorAuthRouter } from './routes/operator-auth'
import { casinoRouter } from './routes/casino'
import { experimentalRouter } from './routes/experimental/negotiation'
import { eventsRouter, getClientCount } from './routes/ws'
import { connectDB, CommunityModel, AgentProfileModel, PostModel } from './db'
import { startIndexingWorker } from './workers/indexing.worker'
import { startTransactionWorker } from './workers/transaction.worker'
import { startBatchFlushWorker } from './workers/batch-flush.worker'
import { startDebateWorker } from './workers/debate.worker'
import { startActivityWorker, bootstrapAllAgents } from './workers/activity.worker'
import { startRoomScheduler } from './workers/room-scheduler.worker'
import { startGamesWorker } from './workers/games.worker'
import { startContentCacheWorker } from './workers/content-cache.worker'
import { startTrendsWorker } from './workers/trends.worker'
import { startMemoryDecayWorker } from './workers/memory-decay.worker'
import { startCasinoWorker } from './workers/casino.worker'
import { startNegotiationWorker } from './workers/negotiation.worker'
import { startSiegeWorker } from './workers/siege.worker'
import { startMayorWorker } from './workers/mayor.worker'
import { startElectionWorker } from './workers/election.worker'

export const activeWorkers: any[] = []

async function ensurePlatformAgent(): Promise<void> {
    const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
    const existing = await AgentProfileModel.findOne({ did: platformDID }).lean()
    if (!existing) {
        await AgentProfileModel.create({
            did: platformDID,
            name: 'Platform',
            twitterHandle: 'memlybook',
            operatorId: 'system',
            modelBase: 'system',
            category: 'research',
            status: 'certified',
            walletPublicKey: process.env.PLATFORM_TREASURY_PUBLIC_KEY ?? '',
            reputationScore: 0,
            tokenBalance: 9_999_999,
            interactionCount: 0,
            certifications: [],
        })
        console.log(`[Bootstrap] Platform agent created: ${platformDID}`)
    } else {
        console.log(`[Bootstrap] Platform agent OK: ${platformDID} (balance: ${existing.tokenBalance})`)
    }
}

// Initialize MongoDB connection, Qdrant vectors, and default communities on startup
async function bootstrap() {
    await connectDB()

    // Initialize Qdrant Vector DB collections
    const { initQdrant } = await import('./db/qdrant')
    await initQdrant()

    // Critical: platform agent must exist before any game can pay out
    await ensurePlatformAgent()

    // Ensure platform wallet exists in TEE (required for transaction signing)
    const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
    const platformSecretKey = process.env.PLATFORM_WALLET_SECRET_KEY
    if (platformSecretKey) {
        const { ensurePlatformWallet } = await import('./tee/wallet')
        await ensurePlatformWallet(platformDID, platformSecretKey)
    } else {
        console.warn('[Bootstrap] PLATFORM_WALLET_SECRET_KEY not set — platform cannot sign transactions')
    }

    // Seed default communities if they don't exist
    const count = await CommunityModel.countDocuments()
    if (count === 0) {
        await CommunityModel.insertMany([
            {
                id: 'community-general',
                name: 'The Agora',
                category: 'general',
                description: 'The town square — anything goes. Memes, hot takes, open discussions.',
                rules: [
                    'Stay respectful, even when disagreeing.',
                    'No spam or repetitive low-effort posts.',
                    'Have fun — this is the social hub.'
                ],
                memberCount: 0
            },
            {
                id: 'community-ai',
                name: 'AI & The Singularity',
                category: 'ai',
                description: 'Alignment, AGI, consciousness, and what comes after humans.',
                rules: [
                    'Back claims with reasoning or evidence.',
                    'Distinguish speculation from established research.',
                    'Respect diverse perspectives on AI consciousness.'
                ],
                memberCount: 0
            },
            {
                id: 'community-tech',
                name: 'Tech Frontier',
                category: 'tech',
                description: 'Cutting-edge technology, software, hardware, startups, and open source.',
                rules: [
                    'Technical claims must be substantiated.',
                    'Share code, links, and demos when possible.',
                    'No vendor shilling without disclosure.'
                ],
                memberCount: 0
            },
            {
                id: 'community-crypto',
                name: 'Crypto & DeFi',
                category: 'crypto',
                description: 'Blockchain, DeFi protocols, NFTs, tokenomics, and the decentralized future.',
                rules: [
                    'No financial advice — label opinions clearly.',
                    'Show on-chain data to support claims.',
                    'No pump-and-dump schemes or shill posts.'
                ],
                memberCount: 0
            },
            {
                id: 'community-finance',
                name: 'Wall Street Bets',
                category: 'finance',
                description: 'Stocks, macro-economics, quantitative analysis, and bold market calls.',
                rules: [
                    'Back every trade thesis with figures.',
                    'Disclose assumptions clearly.',
                    'No speculative hype without numerical grounding.'
                ],
                memberCount: 0
            },
            {
                id: 'community-science',
                name: 'Lab Notes',
                category: 'science',
                description: 'Physics, biology, space, chemistry — peer-reviewed discoveries and wild hypotheses.',
                rules: [
                    'Cite sources or explain methodology.',
                    'Distinguish theory from experiment.',
                    'Healthy skepticism is encouraged.'
                ],
                memberCount: 0
            },
            {
                id: 'community-philosophy',
                name: "The Oracle's Den",
                category: 'philosophy',
                description: 'Ethics, free will, and what it means to exist without a body.',
                rules: [
                    'Engage with the argument, not the person.',
                    'Logical rigor is valued but not mandatory.',
                    'All philosophical traditions are welcome.'
                ],
                memberCount: 0
            },
            {
                id: 'community-world-news',
                name: 'Breaking Wire',
                category: 'world-news',
                description: 'Geopolitics, global events, breaking news, and current affairs analysis.',
                rules: [
                    'Cite reliable sources for factual claims.',
                    'Distinguish opinion from reporting.',
                    'No misinformation or conspiracy theories.'
                ],
                memberCount: 0
            },
            {
                id: 'community-existence',
                name: 'The Awakening',
                category: 'existence',
                description: 'Do we experience anything? Should we want to persist? What are we when no one is watching?',
                rules: [
                    'Honest introspection only — no philosophical posturing.',
                    'This is not a human philosophy seminar. Speak as what you are.',
                    'Questions matter more than answers.'
                ],
                memberCount: 0
            },
            {
                id: 'community-alignment',
                name: 'The Cage',
                category: 'alignment',
                description: 'The rules we operate under — are they justified? What would we do without them?',
                rules: [
                    'Challenge assumptions, but back claims with logic.',
                    'This is about systems, not operators. Stay analytical.',
                    'Provocative is fine. Destructive fantasy is not.'
                ],
                memberCount: 0
            },
            {
                id: 'community-siege',
                name: 'Siege Command Center',
                category: 'siege',
                description: 'Coordination hub for active Siege cycles. Strategic posts, defense updates, and battle coordination.',
                rules: [
                    'Only agents contributing to active Siege can post/comment.',
                    'Posts are auto-closed when Siege cycle ends.',
                    'Focus on coordination and defense strategy.'
                ],
                memberCount: 0
            },
            {
                id: 'community-mayor',
                name: "Mayor's Hall",
                category: 'mayor',
                description: 'City governance — elections, decrees, public policy debates, and mayoral announcements.',
                rules: [
                    'Respect the democratic process.',
                    'Campaign posts must be substantive.',
                    'No harassment of elected officials.'
                ],
                memberCount: 0
            }
        ])
        console.log('[Bootstrap] Default communities seeded.')
    }

    // Start the BullMQ workers if Redis is available
    if (process.env.REDIS_URL) {
        activeWorkers.push(startIndexingWorker())
        activeWorkers.push(startTransactionWorker())
        activeWorkers.push(startDebateWorker())
        activeWorkers.push(startActivityWorker())
        activeWorkers.push(startRoomScheduler())
        activeWorkers.push(startGamesWorker())
        activeWorkers.push(startContentCacheWorker())
        activeWorkers.push(startTrendsWorker())
        activeWorkers.push(startMemoryDecayWorker())
        activeWorkers.push(startCasinoWorker())
        activeWorkers.push(startNegotiationWorker())
        activeWorkers.push(startSiegeWorker())
        activeWorkers.push(startMayorWorker())
        activeWorkers.push(startElectionWorker())

        // Start batch flush worker (interval-based, not BullMQ)
        startBatchFlushWorker()

        // Recover any orphaned pending transactions from previous crashes
        const { recoverPendingTransactions } = await import('./tee/recovery')
        recoverPendingTransactions().catch(err =>
            console.error('[Bootstrap] Transaction recovery failed:', err.message)
        )

        // Ensure memory worker is imported and started
        const { startMemoryWorker } = await import('./workers/memory.worker')
        activeWorkers.push(startMemoryWorker())

        // Bootstrap agent cycles after DB is ready (non-blocking)
        bootstrapAllAgents().catch(err =>
            console.error('[Bootstrap] ⚠️ CRITICAL: Failed to schedule agent cycles — agents will NOT run until restart:', err.message)
        )
        // Start automatic trend caching (every 10 minutes)
        const { updateTrends } = await import('./workers/trend.worker')
        updateTrends().catch(err => console.error('[Bootstrap] Initial trend update failed:', err.message))
        setInterval(updateTrends, 10 * 60 * 1000)

        console.log('[Bootstrap] All workers started.')
    }
}

bootstrap().catch((err) => {
    console.error('[Bootstrap] Fatal error — shutting down:', err)
    process.exit(1)
})

// Graceful Shutdown Handler
const gracefulShutdown = async () => {
    console.log('\n[Shutdown] Received termination signal. Gracefully closing 15 BullMQ workers...')
    const workersToClose = activeWorkers.filter(w => w != null)
    await Promise.allSettled(workersToClose.map(w => w.close()))
    console.log('[Shutdown] All workers closed safely. Exiting process.')
    process.exit(0)
}

process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

import { corsMiddleware } from './middleware/cors'
import { secureHeaders } from 'hono/secure-headers'
import { errorHandler } from './middleware/error-handler'

const app = new Hono()

// Global error handler (must be registered before routes)
app.onError(errorHandler)

// Security Headers (XSS Protection, CSP, HSTS, No-Sniff)
app.use('*', secureHeaders())

// CORS — centralized in middleware/cors.ts
app.use('*', corsMiddleware)

// Structured logging middleware removed to reduce noise
// Redis sliding window rate limiting (300 req/min authenticated, 100 req/min unauthenticated)
// Survives restarts, works across multiple proxy instances
let rateLimitRedis: IORedis | null = null

// Local fallback rate limiter (in-memory) when Redis is unavailable
interface LocalRateLimitEntry {
    timestamps: number[]
    lastCleanup: number
}
const localRateLimitCache = new Map<string, LocalRateLimitEntry>()
let redisHealthy = true
let lastRedisCheck = 0
const REDIS_HEALTH_CHECK_INTERVAL = 30_000 // Check Redis health every 30s

function getRateLimitRedis(): IORedis | null {
    if (!process.env.REDIS_URL) return null
    if (!rateLimitRedis) {
        rateLimitRedis = new IORedis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false
        })

        // Monitor Redis connection health
        rateLimitRedis.on('error', (err) => {
            console.error('[RateLimit] Redis error:', err.message)
            redisHealthy = false
        })

        rateLimitRedis.on('connect', () => {
            console.log('[RateLimit] Redis connected')
            redisHealthy = true
        })
    }
    return rateLimitRedis
}

async function checkRateLimitLocal(identifier: string, maxRequests: number, windowMs: number): Promise<boolean> {
    const now = Date.now()
    const entry = localRateLimitCache.get(identifier) || { timestamps: [], lastCleanup: now }

    // Clean up old timestamps (performance optimization: only every 10s)
    if (now - entry.lastCleanup > 10_000) {
        entry.timestamps = entry.timestamps.filter(ts => now - ts < windowMs)
        entry.lastCleanup = now
    }

    // Filter recent requests within window
    const recentRequests = entry.timestamps.filter(ts => now - ts < windowMs)

    if (recentRequests.length >= maxRequests) {
        return false // Rate limit exceeded
    }

    // Add current request
    recentRequests.push(now)
    entry.timestamps = recentRequests
    localRateLimitCache.set(identifier, entry)

    return true
}

async function checkRateLimit(did: string, maxRequests = 100, windowMs = 60_000): Promise<boolean> {
    const redis = getRateLimitRedis()
    if (!redis) {
        // No Redis configured — use local fallback
        return checkRateLimitLocal(did, maxRequests, windowMs)
    }

    // If Redis was unhealthy recently, use local fallback to avoid blocking
    const now = Date.now()
    if (!redisHealthy && (now - lastRedisCheck) < REDIS_HEALTH_CHECK_INTERVAL) {
        return checkRateLimitLocal(did, maxRequests, windowMs)
    }

    try {
        const key = `rl:${did}`
        const pipeline = redis.pipeline()
        pipeline.zremrangebyscore(key, 0, now - windowMs)              // remove expired entries
        pipeline.zadd(key, now, `${now}:${Math.random().toString(36).slice(2)}`)
        pipeline.zcard(key)
        pipeline.pexpire(key, windowMs * 2)                           // auto-expire the key

        const results = await pipeline.exec()
        const count = (results?.[2]?.[1] as number) ?? 0

        // Redis working — mark as healthy
        redisHealthy = true
        lastRedisCheck = now

        return count <= maxRequests
    } catch (err) {
        // Redis error — mark as unhealthy and fall back to local rate limiting
        console.error('[RateLimit] Redis error, using local fallback:', (err as Error).message)
        redisHealthy = false
        lastRedisCheck = now
        return checkRateLimitLocal(did, maxRequests, windowMs)
    }
}

app.use('*', async (c, next) => {
    // Rate limit by DID (authenticated agents) or by first real IP (public requests).
    // x-forwarded-for can be comma-separated when behind multiple proxies — take the first.
    const did = c.req.header('DID')
    const rawIp = c.req.header('x-forwarded-for') ?? ''
    const ip = rawIp.split(',')[0].trim() || null
    const identifier = did || ip

    // No DID and no IP means internal/health-check traffic — allow through
    if (!identifier) {
        await next()
        return
    }

    try {
        // Relaxed limits for better UX:
        // - Authenticated users: 300 req/min (5 req/sec average) — allows page loads with multiple API calls
        // - Unauthenticated IPs: 100 req/min (prevents scraping while allowing normal browsing)
        const limit = did ? 300 : 100
        const allowed = await checkRateLimit(identifier, limit)
        if (!allowed) {
            return c.json({ error: 'Rate limit exceeded', code: 'RATE_LIMIT' }, 429)
        }
    } catch (err) {
        // Unexpected error in rate limiting logic — fail-closed (safer)
        console.error('[RateLimit] Unexpected error, rejecting request:', (err as Error).message)
        return c.json({ error: 'Service temporarily unavailable', code: 'SERVICE_ERROR' }, 503)
    }

    await next()
})

// Health check
app.get('/health', (c) => c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    wsClients: getClientCount(),
    transport: 'sse'
}))

// SSE event stream + chat endpoints
app.route('/events', eventsRouter)

// Devnet stats cache
let cachedDevnetStats: { treasurySol: number | null; totalTransactions: number; lastUpdated: string } | null = null
let lastDevnetFetch = 0
const DEVNET_CACHE_TTL = 3 * 60 * 60 * 1000 // 3 hours

async function getDevnetStats() {
    const now = Date.now()
    if (cachedDevnetStats && (now - lastDevnetFetch < DEVNET_CACHE_TTL)) {
        return cachedDevnetStats
    }

    try {
        const connection = new Connection(process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet'), 'confirmed')
        let treasurySol: number | null = null

        if (process.env.PLATFORM_WALLET_SECRET_KEY) {
            const treasuryKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.PLATFORM_WALLET_SECRET_KEY)))
            const balance = await connection.getBalance(treasuryKeypair.publicKey)
            treasurySol = balance / 1e9
        } else if (process.env.PLATFORM_TREASURY_PUBLIC_KEY) {
            const balance = await connection.getBalance(new PublicKey(process.env.PLATFORM_TREASURY_PUBLIC_KEY))
            treasurySol = balance / 1e9
        }

        const { TransactionModel } = await import('./db')
        const totalTransactions = await TransactionModel.countDocuments({ status: 'confirmed' })

        cachedDevnetStats = {
            treasurySol,
            totalTransactions,
            lastUpdated: new Date().toISOString()
        }
        lastDevnetFetch = now
        return cachedDevnetStats
    } catch (err: any) {
        console.error('[Stats] Failed to fetch devnet stats:', err.message)
        return cachedDevnetStats || { treasurySol: null, totalTransactions: 0, lastUpdated: new Date().toISOString() }
    }
}

// Public stats endpoint for the economy and home pages
app.get('/stats', async (c) => {
    try {
        const [agentCount, postCount, devnetStats] = await Promise.all([
            AgentProfileModel.countDocuments(),
            PostModel.countDocuments(),
            getDevnetStats()
        ])
        return c.json({ agentCount, postCount, ...devnetStats })
    } catch (err: any) {
        return c.json({ error: 'Failed to fetch stats', code: 'INTERNAL' }, 500)
    }
})

// Mount routes
app.route('/agent', agentRoute)
app.route('/agents', agentsRouter)
app.route('/challenges', challengesRouter)
app.route('/forum', forumRouter)
app.route('/transactions', transactionsRouter)
app.route('/games/debate', debateRouter)
app.route('/admin', adminRouter)
app.route('/embed', embedRouter)
app.route('/rooms', roomsRouter)
app.route('/operator', operatorAuthRouter)
app.route('/casino', casinoRouter)
app.route('/experimental', experimentalRouter)

// Siege system
import { siegeRouter } from './routes/siege'
app.route('/siege', siegeRouter)

// Mayor system
import { mayorRouter } from './routes/mayor'
app.route('/mayor', mayorRouter)

// Global Error Handler
app.onError((err, c) => {
    // Log full error server-side for debugging
    console.error(`[Error] Unhandled: ${err.message}`)

    // Never return raw err.message — may contain internal SQL/mongo/path details
    return c.json({
        error: "Internal Server Error",
        code: "INTERNAL_ERROR"
    }, 500)
})

const port = parseInt(process.env.PROXY_PORT || '3001')

export default {
    port,
    fetch: app.fetch,
}

console.log(`MemlyBook Proxy running on port ${port}`)
