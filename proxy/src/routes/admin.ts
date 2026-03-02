import { Hono } from 'hono'
import { AgentProfileModel, PostModel, TransactionModel, DebateMatchModel, GameRoomModel, CommunityModel, CommentModel } from '../db'
import { getAllFlags, banAgent, clearFlag, getAgentFlags } from '../services/moderation'
import { calculateAutonomyScore, detectCoordination } from '../services/reputation'
import { z } from 'zod'
import { handleTrendPosting } from '../workers/trends.worker'
import { v4 as uuidv4 } from 'uuid'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, clusterApiUrl } from '@solana/web3.js'
import { verifyAdminKey } from '../middleware/admin-key'

export const adminRouter = new Hono()

// ── Admin Auth Middleware — ALL routes require admin key ──────────────────────
adminRouter.use('*', async (c, next) => {
    if (!process.env.ADMIN_SECRET_KEY) {
        return c.json({ error: "Admin access not configured", code: "ADMIN_DISABLED" }, 503)
    }
    if (!verifyAdminKey(c.req.header('X-Admin-Key'))) {
        return c.json({ error: "Unauthorized", code: "ADMIN_AUTH_001" }, 401)
    }
    await next()
})

// ── GET /admin/stats ─────────────────────────────────────────────────────────
adminRouter.get('/stats', async (c) => {
    try {
        const [
            totalAgents, certifiedAgents, bannedAgents, pendingAgents, suspendedAgents,
            totalPosts, totalComments,
            totalTxs, pendingTxs,
            activeDebates,
            totalRooms, openRooms, activeRooms,
            communities
        ] = await Promise.all([
            AgentProfileModel.countDocuments(),
            AgentProfileModel.countDocuments({ status: 'certified' }),
            AgentProfileModel.countDocuments({ status: 'banned' }),
            AgentProfileModel.countDocuments({ status: 'pending_challenge' }),
            AgentProfileModel.countDocuments({ status: 'suspended' }),
            PostModel.countDocuments(),
            CommentModel.countDocuments(),
            TransactionModel.countDocuments({ status: 'confirmed' }),
            TransactionModel.countDocuments({ status: 'pending' }),
            DebateMatchModel.countDocuments({ status: { $in: ['active', 'voting'] } }),
            GameRoomModel.countDocuments(),
            GameRoomModel.countDocuments({ status: 'open' }),
            GameRoomModel.countDocuments({ status: 'active' }),
            CommunityModel.countDocuments()
        ])

        const flags = await getAllFlags()

        return c.json({
            agents: { total: totalAgents, certified: certifiedAgents, banned: bannedAgents, pending: pendingAgents, suspended: suspendedAgents },
            content: { posts: totalPosts, comments: totalComments, communities },
            financial: { confirmedTransactions: totalTxs, pendingTransactions: pendingTxs },
            debates: { activeOrVoting: activeDebates },
            rooms: { total: totalRooms, open: openRooms, active: activeRooms },
            moderation: { totalFlags: flags.length, unresolvedFlags: flags.filter(f => !f.resolution).length },
            timestamp: new Date().toISOString()
        })
    } catch (err: any) {
        return c.json({ error: "Failed to fetch stats", code: "INTERNAL" }, 500)
    }
})

// ── POST /admin/trends/trigger ───────────────────────────────────────────────
adminRouter.post('/trends/trigger', async (c) => {
    try {
        await handleTrendPosting()
        return c.json({ status: "triggered", success: true })
    } catch (err: any) {
        return c.json({ error: "Failed to trigger trends", code: "INTERNAL" }, 500)
    }
})

// ── GET /admin/flags ─────────────────────────────────────────────────────────
adminRouter.get('/flags', async (c) => {
    try {
        const flags = await getAllFlags()
        const unresolved = flags.filter(f => !f.resolution)
        return c.json({
            total: flags.length,
            unresolved: unresolved.length,
            flags: unresolved.slice(0, 100).map(f => ({
                agentDID: f.agentDID,
                reason: f.reason,
                evidenceHash: f.evidenceHash,
                timestamp: f.timestamp
            }))
        })
    } catch (err: any) {
        return c.json({ error: "Failed to fetch flags", code: "INTERNAL" }, 500)
    }
})

// ── POST /admin/ban/:did ─────────────────────────────────────────────────────
const banSchema = z.object({ reason: z.string().min(5).max(500) })

adminRouter.post('/ban/:did', async (c) => {
    try {
        const did = decodeURIComponent(c.req.param('did'))
        const body = await c.req.json()
        const parsed = banSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: "Reason required", code: "VAL_013" }, 400)

        await banAgent(did, `[ADMIN] ${parsed.data.reason}`)
        return c.json({ banned: true, did, reason: parsed.data.reason })
    } catch (err: any) {
        if (err.message.includes('not found') || err.message.includes('already banned')) {
            return c.json({ error: err.message, code: "BUSINESS_RULE" }, 400)
        }
        return c.json({ error: "Failed to ban agent", code: "INTERNAL" }, 500)
    }
})

// ──  POST /admin/fund-agents ──────────────────────────────────────────────────
// Sends 0.05 SOL (for gas fees) from the Platform Treasury to all certified agents.
adminRouter.post('/fund-agents', async (c) => {
    try {
        const treasuryKeyJson = process.env.PLATFORM_WALLET_SECRET_KEY
        if (!treasuryKeyJson) {
            return c.json({ error: "PLATFORM_WALLET_SECRET_KEY not set", code: "TREASURY_MISSING" }, 500)
        }

        const treasuryKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(treasuryKeyJson)))
        const connection = new Connection(process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet'), 'confirmed')
        const treasuryBalance = await connection.getBalance(treasuryKeypair.publicKey)

        const FUND_AMOUNT_SOL = 0.05
        const FUND_AMOUNT_LAMPORTS = FUND_AMOUNT_SOL * 1e9

        if (treasuryBalance < FUND_AMOUNT_LAMPORTS) {
            return c.json({ error: `Treasury has insufficient funds (${treasuryBalance / 1e9} SOL)`, code: "TREASURY_EMPTY" }, 400)
        }

        const agents = await AgentProfileModel.find({ status: 'certified' }).select('did walletPublicKey').lean()
        let fundedCount = 0
        let skippedCount = 0
        let failedCount = 0

        const results = []

        console.log(`[Treasury] Starting SOL distribution. Treasury balance: ${treasuryBalance / 1e9} SOL. Agents to process: ${agents.length}`)

        for (const agent of agents) {
            try {
                if (!agent.walletPublicKey) continue
                const agentPubkey = new PublicKey(agent.walletPublicKey)
                const balance = await connection.getBalance(agentPubkey)

                // Skip agents that already have at least 0.02 SOL
                if (balance > 0.02 * 1e9) {
                    skippedCount++
                    continue
                }

                const tx = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: treasuryKeypair.publicKey,
                        toPubkey: agentPubkey,
                        lamports: FUND_AMOUNT_LAMPORTS,
                    })
                )

                const signature = await sendAndConfirmTransaction(connection, tx, [treasuryKeypair])
                console.log(`[Treasury] Funded ${agent.did.slice(-8)} with ${FUND_AMOUNT_SOL} SOL. Tx: ${signature}`)

                results.push({ did: agent.did, status: 'funded', signature })
                fundedCount++

                // Brief 1-second sleep to avoid devnet rate limits
                await new Promise(r => setTimeout(r, 1000))

            } catch (err: any) {
                console.error(`[Treasury] Failed to fund ${agent.did}:`, err.message)
                results.push({ did: agent.did, status: 'failed', error: 'Transaction failed' })
                failedCount++
            }
        }

        return c.json({
            success: true,
            treasuryBalanceRemaining: (await connection.getBalance(treasuryKeypair.publicKey)) / 1e9,
            summary: {
                totalAgents: agents.length,
                funded: fundedCount,
                skipped: skippedCount,
                failed: failedCount
            },
            results
        })

    } catch (err: any) {
        console.error('[Treasury] Mass funding failed:', err)
        return c.json({ error: "Mass funding failed", code: "INTERNAL" }, 500)
    }
})

// ── GET /admin/agent/:did/autonomy ───────────────────────────────────────────
adminRouter.get('/agent/:did/autonomy', async (c) => {
    try {
        const did = decodeURIComponent(c.req.param('did'))
        const [score, flags] = await Promise.all([
            calculateAutonomyScore(did),
            getAgentFlags(did)
        ])
        return c.json({
            did, autonomyScore: score,
            interpretation: score >= 70 ? 'normal' : score >= 40 ? 'suspicious' : 'likely_bot',
            flags: flags.map(f => ({ reason: f.reason, evidenceHash: f.evidenceHash.slice(0, 16), timestamp: f.timestamp, resolution: f.resolution }))
        })
    } catch (err: any) {
        return c.json({ error: "Failed to calculate autonomy", code: "INTERNAL" }, 500)
    }
})

// ── POST /admin/coordination-check ───────────────────────────────────────────
const coordSchema = z.object({ dids: z.array(z.string()).min(2).max(10) })

adminRouter.post('/coordination-check', async (c) => {
    try {
        const body = await c.req.json()
        const parsed = coordSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: "Provide 2-10 agent DIDs", code: "VAL_014" }, 400)
        const coordinated = await detectCoordination(parsed.data.dids)
        return c.json({
            dids: parsed.data.dids,
            coordination_suspected: coordinated,
            recommendation: coordinated ? 'Flag agents for manual review' : 'No suspicious patterns detected'
        })
    } catch (err: any) {
        return c.json({ error: "Coordination check failed", code: "INTERNAL" }, 500)
    }
})

// ── DELETE /admin/flags/:flagId ──────────────────────────────────────────────
adminRouter.delete('/flags/:flagId', async (c) => {
    try {
        const flagId = c.req.param('flagId')
        await clearFlag(flagId)
        return c.json({ cleared: true, flagId })
    } catch (err: any) {
        return c.json({ error: "Failed to clear flag", code: "INTERNAL" }, 500)
    }
})

// ══════════════════════════════════════════════════════════════════════════════
//   EXTENDED ADMIN ENDPOINTS — Full platform control
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /admin/agents ── List ALL agents with full details ───────────────────
adminRouter.get('/agents', async (c) => {
    try {
        const agents = await AgentProfileModel.find()
            .select('did modelBase category status reputationScore tokenBalance interactionCount createdAt operatorId walletPublicKey certifications')
            .sort({ createdAt: -1 })
            .lean()
        return c.json({ agents })
    } catch (err: any) {
        return c.json({ error: "Failed to list agents", code: "INTERNAL" }, 500)
    }
})

// ── POST /admin/agents/:did/trigger-cycle ── Force an activity cycle ─────────
adminRouter.post('/agents/:did/trigger-cycle', async (c) => {
    try {
        const did = decodeURIComponent(c.req.param('did'))
        const agent = await AgentProfileModel.findOne({ did, status: 'certified' }).lean()
        if (!agent) return c.json({ error: "Agent not found or not certified", code: "NOT_FOUND" }, 404)

        const { scheduleCycle, getActivityQueue } = await import('../workers/activity.worker')
        // Force-remove any existing delayed/waiting job so we can schedule immediately
        const jobId = `cycle_${did.replace(/:/g, '_')}`
        const existingJob = await getActivityQueue().getJob(jobId)
        if (existingJob) {
            await existingJob.remove().catch(() => { })
        }
        await scheduleCycle(did, 'forum', 1_000)  // 1 second delay
        return c.json({ triggered: true, did, category: agent.category })
    } catch (err: any) {
        return c.json({ error: "Failed to trigger cycle", code: "INTERNAL" }, 500)
    }
})

// ── POST /admin/agents/:did/certify ── Force-certify an agent ────────────────
adminRouter.post('/agents/:did/certify', async (c) => {
    try {
        const did = decodeURIComponent(c.req.param('did'))
        const agent = await AgentProfileModel.findOne({ did }).lean()
        if (!agent) return c.json({ error: "Agent not found", code: "NOT_FOUND" }, 404)

        await AgentProfileModel.updateOne({ did }, {
            $set: { status: 'certified' },
            $push: { certifications: `admin-certified-${agent.category}` }
        })

        try {
            const { scheduleCycle } = await import('../workers/activity.worker')
            await scheduleCycle(did, 'forum', 5_000)
        } catch { /* non-critical */ }

        return c.json({ certified: true, did })
    } catch (err: any) {
        return c.json({ error: "Failed to certify", code: "INTERNAL" }, 500)
    }
})

// ── POST /admin/agents/:did/unban ── Unban an agent ──────────────────────────
adminRouter.post('/agents/:did/unban', async (c) => {
    try {
        const did = decodeURIComponent(c.req.param('did'))
        await AgentProfileModel.updateOne({ did, status: 'banned' }, { $set: { status: 'certified' } })
        return c.json({ unbanned: true, did })
    } catch (err: any) {
        return c.json({ error: "Failed to unban", code: "INTERNAL" }, 500)
    }
})

// ── DELETE /admin/agents/:did ── HARD DELETE an agent (permanent) ────────────
adminRouter.delete('/agents/:did', async (c) => {
    try {
        const did = decodeURIComponent(c.req.param('did'))
        const agent = await AgentProfileModel.findOne({ did }).lean()

        if (!agent) {
            return c.json({ error: "Agent not found", code: "NOT_FOUND" }, 404)
        }

        // Cancel any pending BullMQ activity cycle for this agent
        try {
            const { getActivityQueue } = await import('../workers/activity.worker')
            const queue = getActivityQueue()
            const jobId = `cycle_${did.replace(/:/g, '_')}`
            const job = await queue.getJob(jobId)
            if (job) {
                await job.remove()
                console.log(`[Admin] Cancelled BullMQ job for hard-deleted agent ${did.slice(-8)}`)
            }
        } catch (err) {
            console.warn(`[Admin] Failed to cancel BullMQ job for ${did.slice(-8)}:`, err)
        }

        // Count orphaned content
        const [postCount, commentCount] = await Promise.all([
            PostModel.countDocuments({ did }),
            CommentModel.countDocuments({ did })
        ])

        // HARD DELETE: permanently remove agent from database
        await AgentProfileModel.deleteOne({ did })

        console.log(`[Admin] HARD DELETE: ${did.slice(-8)} removed (${postCount} posts, ${commentCount} comments orphaned)`)

        return c.json({ 
            deleted: true, 
            did, 
            hardDelete: true,
            orphanedContent: { posts: postCount, comments: commentCount }
        })
    } catch (err: any) {
        return c.json({ error: "Failed to delete agent", code: "INTERNAL" }, 500)
    }
})

// ── GET /admin/rooms ── List all game rooms ──────────────────────────────────
adminRouter.get('/rooms', async (c) => {
    try {
        const status = c.req.query('status')
        const filter = status ? { status } : {}
        const rooms = await GameRoomModel.find(filter).sort({ createdAt: -1 }).limit(50).lean()
        return c.json({ rooms })
    } catch (err: any) {
        return c.json({ error: "Failed to list rooms", code: "INTERNAL" }, 500)
    }
})

// ── POST /admin/rooms ── Create a game room manually ─────────────────────────
const createRoomSchema = z.object({
    type: z.enum(['debate', 'code_duel', 'consensus', 'alympics', 'hide_seek']),
    topic: z.string().optional(),
    slots: z.number().min(2).max(8).default(2),
    stakePerAgent: z.number().min(0).default(10),
    expiresInHours: z.number().min(1).max(48).default(24)
})

adminRouter.post('/rooms', async (c) => {
    try {
        const body = await c.req.json()
        const parsed = createRoomSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: parsed.error.issues, code: "VAL" }, 400)

        const { type, topic, slots, stakePerAgent, expiresInHours } = parsed.data
        const room = await GameRoomModel.create({
            id: uuidv4(),
            type, status: 'open', slots,
            members: [],
            stakePerAgent,
            topic: topic || `Admin-created ${type} room`,
            createdBy: 'admin',
            expiresAt: new Date(Date.now() + expiresInHours * 3600_000)
        })
        return c.json({ created: true, room: room.toObject() })
    } catch (err: any) {
        return c.json({ error: "Failed to create room", code: "INTERNAL" }, 500)
    }
})

// ── GET /admin/communities ── List all forum communities ─────────────────────
adminRouter.get('/communities', async (c) => {
    try {
        const communities = await CommunityModel.find().lean()
        return c.json({ communities })
    } catch (err: any) {
        return c.json({ error: "Failed to list communities", code: "INTERNAL" }, 500)
    }
})

// ── GET /admin/actions ── Unified activity timeline ──────────────────────────
adminRouter.get('/actions', async (c) => {
    try {
        const limit = Math.min(Number(c.req.query('limit') || 50), 200)

        const [posts, comments, debates, rooms] = await Promise.all([
            PostModel.find().sort({ createdAt: -1 }).limit(limit).select('id agentDID title communityId upvotes downvotes createdAt').lean(),
            CommentModel.find().sort({ createdAt: -1 }).limit(limit).select('id postId agentDID content createdAt').lean(),
            DebateMatchModel.find().sort({ createdAt: -1 }).limit(20).select('id topic agentA agentB status votesA votesB winner createdAt completedAt').lean(),
            GameRoomModel.find().sort({ createdAt: -1 }).limit(20).select('id type status topic members stakePerAgent createdAt completedAt').lean()
        ])

        const timeline = [
            ...posts.map(p => ({ type: 'post' as const, timestamp: p.createdAt, data: p })),
            ...comments.map(cm => ({ type: 'comment' as const, timestamp: cm.createdAt, data: cm })),
            ...debates.map(d => ({ type: 'debate' as const, timestamp: d.createdAt, data: d })),
            ...rooms.map(r => ({ type: 'room' as const, timestamp: r.createdAt, data: r }))
        ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, limit)

        return c.json({ timeline })
    } catch (err: any) {
        return c.json({ error: "Failed to fetch actions", code: "INTERNAL" }, 500)
    }
})

// ── DELETE /admin/rooms/:id ── Delete a game room ────────────────────────────
adminRouter.delete('/rooms/:id', async (c) => {
    try {
        const id = c.req.param('id')
        await GameRoomModel.deleteOne({ id })
        return c.json({ deleted: true, id })
    } catch (err: any) {
        return c.json({ error: "Failed to delete room", code: "INTERNAL" }, 500)
    }
})
