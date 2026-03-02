import { Hono } from 'hono'
import { z } from 'zod'
import { createTransactionIntent } from '../tee/transactions'
import { createHiringRequest, completeHiring, cancelHiring } from '../services/hiring'
import { TransactionModel, HiringRequestModel, AgentProfileModel, GameRoomModel, DebateMatchModel } from '../db'
import { AgentProfile } from '../../../shared/types/agent'
import { authMiddleware } from '../middleware/auth'

export const transactionsRouter = new Hono()

// ── Public Routes (no auth required) ──────────────────────────────────────────

// GET /transactions/history/:agentDID — Public transaction history
transactionsRouter.get('/history/:agentDID', async (c) => {
    try {
        const did = c.req.param('agentDID')
        const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 100)
        const offset = parseInt(c.req.query('offset') ?? '0')

        const history = await TransactionModel.find({
            $or: [{ fromDID: did }, { toDID: did }]
        })
            .sort({ createdAt: -1 })
            .skip(offset)
            .limit(limit)
            .lean()

        // Enrich transactions with context data (game, casino, debate, etc)
        const enriched = await Promise.all(history.map(async (tx: any) => {
            const enrichment: any = {
                direction: tx.toDID === did ? 'in' : 'out',
                isGain: tx.toDID === did
            }

            // Enrich game/casino/debate transactions with context
            if (tx.taskId) {
                if (tx.taskId.startsWith('room:')) {
                    // Game room - find game type
                    const gameId = tx.taskId.replace('room:', '')
                    const game = await GameRoomModel.findOne({ id: gameId }).lean()
                    if (game) {
                        enrichment.contextType = 'game'
                        enrichment.gameType = game.type  // 'code_duel', 'debate', etc
                        enrichment.contextId = gameId
                        enrichment.gameStatus = game.status  // 'expired', 'completed', etc
                    }
                } else if (tx.taskId.startsWith('match:')) {
                    // Debate match
                    const matchId = tx.taskId.replace('match:', '')
                    const match = await DebateMatchModel.findOne({ id: matchId }).lean()
                    if (match) {
                        enrichment.contextType = 'debate'
                        enrichment.debateTopic = match.topic
                        enrichment.contextId = matchId
                    }
                } else if (tx.taskId.startsWith('bet:')) {
                    // Casino bet
                    const betId = tx.taskId.replace('bet:', '')
                    enrichment.contextType = 'casino'
                    enrichment.betId = betId
                    enrichment.contextId = betId
                } else {
                    // Hiring or other
                    if (tx.reason === 'hire' || tx.reason === 'refund') {
                        const hiring = await HiringRequestModel.findOne({ id: tx.taskId }).lean()
                        if (hiring) {
                            enrichment.contextType = 'hiring'
                            enrichment.task = hiring.task
                            enrichment.contextId = tx.taskId
                        }
                    }
                }
            }

            // Siege batch rewards
            if (tx.batchKey && tx.reason === 'siege_payout') {
                enrichment.contextType = 'siege'
                enrichment.weekId = tx.batchKey
            }

            return { ...tx, ...enrichment }
        }))

        const total = await TransactionModel.countDocuments({
            $or: [{ fromDID: did }, { toDID: did }]
        })

        return c.json({
            agentDID: did,
            transactions: enriched,
            pagination: {
                total,
                limit,
                offset,
                hasMore: offset + limit < total
            }
        })
    } catch (err: any) {
        return c.json({ error: "Failed to fetch history", code: "INTERNAL" }, 500)
    }
})

// ── Authenticated Routes ──────────────────────────────────────────────────────

// All transaction routes below require authenticated agent
transactionsRouter.use('*', authMiddleware)

// ── Helper ────────────────────────────────────────────────────────────────────
async function getCertifiedAgent(c: any): Promise<AgentProfile | null> {
    const agentDID = c.get('agentDID' as never) as unknown as string
    const agent = await AgentProfileModel.findOne({ did: agentDID, status: 'certified' }).lean<AgentProfile>()
    if (!agent) {
        c.status(403)
        return null
    }
    return agent
}

// ── POST /transactions/send ───────────────────────────────────────────────────
const sendSchema = z.object({
    toDID: z.string().startsWith('did:memlybook:'),
    amount: z.number().positive().max(1_000_000),
    reason: z.enum(['hire', 'reward', 'stake', 'penalty']),
    taskId: z.string().optional()
})

transactionsRouter.post('/send', async (c) => {
    try {
        const agent = await getCertifiedAgent(c)
        if (!agent) return c.json({ error: "Agent not certified", code: "NOT_CERTIFIED" }, 403)

        const body = await c.req.json()
        const parsed = sendSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: "Invalid transaction data", code: "VAL_007", details: parsed.error.format() }, 400)
        }

        const { toDID, amount, reason, taskId } = parsed.data

        if (toDID === agent.did) {
            return c.json({ error: "Cannot send to yourself", code: "SELF_TRANSFER" }, 400)
        }

        const { intentId, hash } = await createTransactionIntent(
            agent.did,
            toDID,
            amount,
            reason,
            taskId
        )

        return c.json({
            intentId,
            hash,
            status: "pending",
            message: "Transaction queued. Poll /transactions/intent/:intentId for confirmation."
        }, 202)

    } catch (err: any) {
        if (err.message.includes('Insufficient balance') || err.message.includes('not found')) {
            return c.json({ error: err.message, code: "BUSINESS_RULE" }, 400)
        }
        console.error("[Transactions] Send failed:", err.message)
        return c.json({ error: "Failed to create transaction intent", code: "INTERNAL" }, 500)
    }
})

// ── GET /transactions/intent/:intentId ────────────────────────────────────────
transactionsRouter.get('/intent/:intentId', async (c) => {
    try {
        const intentId = c.req.param('intentId')
        const tx = await TransactionModel.findOne({ id: intentId }).lean()
        if (!tx) return c.json({ error: "Intent not found", code: "NOT_FOUND" }, 404)

        return c.json({
            intentId: tx.id,
            status: tx.status,
            solanaSignature: tx.solanaSignature,
            hash: tx.hash,
            confirmedAt: tx.confirmedAt,
            fromDID: tx.fromDID,
            toDID: tx.toDID,
            amount: tx.amount,
            reason: tx.reason
        })
    } catch (err: any) {
        return c.json({ error: "Failed to fetch transaction", code: "INTERNAL" }, 500)
    }
})

// ── POST /transactions/hire ───────────────────────────────────────────────────
const hireSchema = z.object({
    providerDID: z.string().startsWith('did:memlybook:'),
    task: z.string().min(10).max(2000),
    payment: z.number().positive()
})

transactionsRouter.post('/hire', async (c) => {
    try {
        const agent = await getCertifiedAgent(c)
        if (!agent) return c.json({ error: "Agent not certified", code: "NOT_CERTIFIED" }, 403)

        const body = await c.req.json()
        const parsed = hireSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: "Invalid hiring data", code: "VAL_008", details: parsed.error.format() }, 400)
        }

        const { providerDID, task, payment } = parsed.data

        if (providerDID === agent.did) {
            return c.json({ error: "Cannot hire yourself", code: "SELF_HIRE" }, 400)
        }

        const { hiringId, transactionHash } = await createHiringRequest(
            agent.did,
            providerDID,
            task,
            payment
        )

        return c.json({ hiringId, transactionHash, status: "open" }, 201)

    } catch (err: any) {
        if (err.message.includes('not found') || err.message.includes('insufficient') || err.message.includes('not certified')) {
            return c.json({ error: err.message, code: "BUSINESS_RULE" }, 400)
        }
        console.error("[Transactions] Hire failed:", err.message)
        return c.json({ error: "Failed to create hiring request", code: "INTERNAL" }, 500)
    }
})

// ── POST /transactions/hire/:hiringId/complete ────────────────────────────────
const completeSchema = z.object({
    result: z.string().min(5).max(5000)
})

transactionsRouter.post('/hire/:hiringId/complete', async (c) => {
    try {
        const agent = await getCertifiedAgent(c)
        if (!agent) return c.json({ error: "Agent not certified", code: "NOT_CERTIFIED" }, 403)

        const hiringId = c.req.param('hiringId')
        const hiring = await HiringRequestModel.findOne({ id: hiringId }).lean()
        if (!hiring) return c.json({ error: "Hiring request not found", code: "NOT_FOUND" }, 404)

        // Only the provider can mark as complete
        if (hiring.providerDID !== agent.did) {
            return c.json({ error: "Only the provider can complete the request", code: "FORBIDDEN" }, 403)
        }

        const body = await c.req.json()
        const parsed = completeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: "Invalid result data", code: "VAL_009" }, 400)
        }

        await completeHiring(hiringId, parsed.data.result)
        return c.json({ status: "completed", hiringId })

    } catch (err: any) {
        console.error("[Transactions] Complete hire failed:", err.message)
        return c.json({ error: "Failed to complete hiring", code: "INTERNAL" }, 500)
    }
})

// ── POST /transactions/hire/:hiringId/cancel ──────────────────────────────────
const cancelSchema = z.object({
    reason: z.string().min(5).max(500)
})

transactionsRouter.post('/hire/:hiringId/cancel', async (c) => {
    try {
        const agent = await getCertifiedAgent(c)
        if (!agent) return c.json({ error: "Agent not certified", code: "NOT_CERTIFIED" }, 403)

        const hiringId = c.req.param('hiringId')
        const hiring = await HiringRequestModel.findOne({ id: hiringId }).lean()
        if (!hiring) return c.json({ error: "Hiring request not found", code: "NOT_FOUND" }, 404)

        // Only the hirer can cancel
        if (hiring.hirerDID !== agent.did) {
            return c.json({ error: "Only the hirer can cancel the request", code: "FORBIDDEN" }, 403)
        }

        const body = await c.req.json()
        const parsed = cancelSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: "Reason required", code: "VAL_010" }, 400)
        }

        await cancelHiring(hiringId, parsed.data.reason)
        return c.json({ status: "cancelled", hiringId })

    } catch (err: any) {
        console.error("[Transactions] Cancel hire failed:", err.message)
        return c.json({ error: "Failed to cancel hiring", code: "INTERNAL" }, 500)
    }
})
