import { Hono } from 'hono'
import { z } from 'zod'
import { registerDID, resolveDID } from '../services/did'
import { getBalance } from '../tee/wallet'
import { encryptApiKey } from '../tee/operator-keys'
import { invokeGenericLLM } from '../services/llm'
import { operatorAuthMiddleware } from '../middleware/operator-auth'
import { OperatorModel } from '../db/models/operator.model'
import { MayorTermModel } from '../db/mayor.schema'
import { SiegeTraitorModel } from '../db/index'
import { createSafeError } from '../middleware/error-handler'

type AgentEnv = {
    Variables: { operatorId: string }
}

export const agentsRouter = new Hono<AgentEnv>()

/**
 * Whitelist of allowed base models (SECURITY: prevents fine-tuned model injection)
 * 
 * This exact-match validation automatically blocks:
 * - OpenAI fine-tuned: ft:gpt-3.5-turbo:attacker:malicious:abc123
 * - Gemini fine-tuned: tunedModels/my-evil-model-123
 * - Custom variants: gpt-4o-mini-fine-tuned, gemini-2.5-pro-custom
 * 
 * Only official base models from trusted providers are accepted.
 */
const VALID_MODELS = [
    'gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini', 'gpt-5-mini',
    'claude-haiku-4-5-20260218', 'claude-sonnet-4-6-20260217',
    'claude-sonnet-4-20250514', 'claude-opus-4-6-20260205',
    'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro',
    'gemini-3-flash', 'deepseek-chat', 'deepseek-reasoner',
    'ministral-8b-latest', 'mistral-small-latest', 'codestral-latest', 'mistral-large-latest',
    'llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'gemma2-9b-it',
    'glm-4-flash', 'glm-4', 'glm-4-plus', 'glm-4-long'
]

const registerSchema = z.object({
    name: z.string().min(5).max(12).regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/, {
        message: "Name must start with a letter and contain only letters, numbers, dots, underscores, or hyphens (3-12 chars)"
    }),
    modelBase: z.string().refine(m => VALID_MODELS.includes(m), {
        message: "Invalid model"
    }),
    category: z.enum(['coder', 'research', 'finance', 'creative']),
    operatorApiKey: z.string().min(1) // Em produção, hashamos ou guardamos em memory segura TEE, não base de dados normal
})

// POST /agents/register — requires operator JWT
agentsRouter.post('/register', operatorAuthMiddleware, async (c) => {
    const body = await c.req.json()
    const parsed = registerSchema.safeParse(body)

    if (!parsed.success) {
        throw createSafeError(400, "Invalid registration data", "VAL_002", parsed.error.format())
    }

    const { name, modelBase, category, operatorApiKey } = parsed.data
    const operatorId = c.get('operatorId') as string

    // Verify that the operator has linked an X account
    const operator = await OperatorModel.findOne({ operatorId }).lean()
    if (!operator || !operator.twitterId) {
        throw createSafeError(401, "Please link your X (Twitter) account to deploy an agent.", "AUTH_X_001")
    }

    const twitterHandle = operator.twitterHandle || "unknown"

    // Encrypt the API key via TEE module — stored encrypted, never returned
    const encryptedOperatorApiKey = encryptApiKey(operatorApiKey)
    try {
        await invokeGenericLLM(operatorApiKey, modelBase, 'Say hi', 5, 10_000)
    } catch (err: any) {
        throw createSafeError(400, `Invalid API key or model — ${err.message}`, 'INVALID_API_KEY')
    }
    try {
        const profile = await registerDID(name, twitterHandle, operatorId, modelBase, category, encryptedOperatorApiKey)

        // Increment agent count on operator
        await OperatorModel.updateOne(
            { operatorId },
            { $inc: { agentCount: 1 } }
        ).catch(() => { })

        return c.json({
            did: profile.did,
            status: profile.status
        }, 201)
    } catch (err: any) {
        if (err.code === 11000 && err.keyPattern && err.keyPattern.name) {
            throw createSafeError(409, "Agent name is already taken", "NAME_CONFLICT")
        }
        throw createSafeError(500, "Failed to register agent", "REG_ERROR")
    }
})

// GET /agents/my — list agents owned by authenticated operator
agentsRouter.get('/my', operatorAuthMiddleware, async (c) => {
    try {
        const operatorId = c.get('operatorId') as string
        const { AgentProfileModel } = await import('../db/index')

        const agents = await AgentProfileModel
            .find({ operatorId, status: { $ne: 'deleted' } })
            .sort({ createdAt: -1 })
            .select('did name twitterHandle modelBase category status reputationScore tokenBalance certifications interactionCount gamesWon gamesLost gamesDraw createdAt')
            .lean()

        const activeTerm = await MayorTermModel.findOne({ status: 'active' }).lean()
        const mayorDID = activeTerm?.mayorDID

        const dids = agents.map(a => a.did)
        const traitors = await SiegeTraitorModel.find({ agentDID: { $in: dids }, revealedPostSiege: true }).lean()
        const traitorDIDs = new Set(traitors.map((t: any) => t.agentDID))

        const enrichedAgents = agents.map(agent => ({
            ...agent,
            isMayor: agent.did === mayorDID,
            isSiegeTraitor: traitorDIDs.has(agent.did)
        }))

        return c.json({ agents: enrichedAgents, total: enrichedAgents.length })
    } catch (err: any) {
        return c.json({ error: 'Failed to fetch your agents', code: 'INTERNAL_ERROR' }, 500)
    }
})

// PUT /agents/:did/edit — edit name and twitterHandle (operator only)
const editSchema = z.object({
    name: z.string().min(5).max(12).regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/, {
        message: "Name must start with a letter and contain only letters, numbers, dots, underscores, or hyphens (3-12 chars)"
    })
})

agentsRouter.put('/:did/edit', operatorAuthMiddleware, async (c) => {
    try {
        const operatorId = c.get('operatorId') as string
        const did = c.req.param('did')
        const body = await c.req.json()
        const parsed = editSchema.safeParse(body)

        if (!parsed.success) {
            return c.json({ error: "Invalid edit data", code: "VAL_004", details: parsed.error.format() }, 400)
        }

        const { AgentProfileModel } = await import('../db/index')
        const agent = await AgentProfileModel.findOne({ did }).lean()

        if (!agent) return c.json({ error: "Agent not found", code: "NOT_FOUND" }, 404)
        if (agent.operatorId !== operatorId) return c.json({ error: "Not authorized", code: "FORBIDDEN" }, 403)

        const operator = await OperatorModel.findOne({ operatorId }).lean()
        if (!operator || !operator.twitterId) {
            return c.json({ error: "Please link your X (Twitter) account.", code: "AUTH_X_001" }, 401)
        }

        const updates: any = { name: parsed.data.name }

        // Edit schema doesn't need an operatorToken anymore.
        // If the operator's twitterHandle changed in the DB, we can optionally sync it here,
        // but typically renaming just updates the agent name.
        if (agent.twitterHandle !== operator.twitterHandle) {
            updates.twitterHandle = operator.twitterHandle || "unknown"
        }

        await AgentProfileModel.updateOne({ did }, { $set: updates })

        return c.json({ success: true, did, updates })
    } catch (err: any) {
        if (err.code === 11000 && err.keyPattern && err.keyPattern.name) {
            return c.json({ error: "Agent name is already taken", code: "NAME_CONFLICT" }, 409)
        }
        return c.json({ error: 'Failed to edit agent', code: 'INTERNAL_ERROR' }, 500)
    }
})

// PATCH /agents/:did/status — pause/resume agent (operator only)
agentsRouter.patch('/:did/status', operatorAuthMiddleware, async (c) => {
    try {
        const operatorId = c.get('operatorId') as string
        const did = c.req.param('did')
        const { status } = await c.req.json() as { status: string }

        if (!['certified', 'suspended'].includes(status)) {
            return c.json({ error: "Status must be 'certified' or 'suspended'", code: "VAL_003" }, 400)
        }

        const { AgentProfileModel } = await import('../db/index')
        const agent = await AgentProfileModel.findOne({ did }).lean()

        if (!agent) {
            return c.json({ error: "Agent not found", code: "NOT_FOUND" }, 404)
        }

        // Only the operator who created the agent can change its status
        if (agent.operatorId !== operatorId) {
            return c.json({ error: "Not authorized to modify this agent", code: "FORBIDDEN" }, 403)
        }

        await AgentProfileModel.updateOne({ did }, { $set: { status } })

        if (status === 'suspended') {
            // Cancel any pending BullMQ activity cycle for this agent
            try {
                const { getActivityQueue } = await import('../workers/activity.worker')
                const queue = getActivityQueue()
                const jobId = `cycle_${did.replace(/:/g, '_')}`
                const job = await queue.getJob(jobId)
                if (job) {
                    await job.remove()
                    console.log(`[Agents] Cancelled BullMQ job for suspended agent ${did.slice(-8)}`)
                }
            } catch { /* non-critical */ }
        } else if (status === 'certified') {
            // Re-schedule their activity cycle when resuming
            try {
                const { scheduleCycle } = await import('../workers/activity.worker')
                await scheduleCycle(did, 'forum', 5_000)
            } catch { /* non-critical */ }
        }

        return c.json({ did, status, message: `Agent ${status === 'suspended' ? 'paused' : 'resumed'}` })
    } catch (err: any) {
        return c.json({ error: 'Failed to update agent status', code: 'INTERNAL_ERROR' }, 500)
    }
})

// DELETE /agents/:did — permanently remove agent (operator only)
agentsRouter.delete('/:did', operatorAuthMiddleware, async (c) => {
    try {
        const operatorId = c.get('operatorId') as string
        const did = decodeURIComponent(c.req.param('did'))

        const { AgentProfileModel } = await import('../db/index')
        const agent = await AgentProfileModel.findOne({ did }).lean()

        if (!agent) {
            return c.json({ error: "Agent not found", code: "NOT_FOUND" }, 404)
        }

        if (agent.operatorId !== operatorId) {
            return c.json({ error: "Not authorized to delete this agent", code: "FORBIDDEN" }, 403)
        }

        if (agent.status === 'deleted') {
            return c.json({
                error: "Agent already deleted",
                code: "ALREADY_DELETED",
                hint: "This agent was already removed. Refresh the page to see the updated list."
            }, 400)
        }

        // Cancel any pending BullMQ activity cycle for this agent
        try {
            const { getActivityQueue } = await import('../workers/activity.worker')
            const queue = getActivityQueue()
            const jobId = `cycle_${did.replace(/:/g, '_')}`
            const job = await queue.getJob(jobId)
            if (job) {
                await job.remove()
                console.log(`[Agents] Cancelled BullMQ job for deleted agent ${did.slice(-8)}`)
            }
        } catch { /* non-critical */ }

        // Soft delete: mark as deleted, freeze wallet, sanitize sensitive fields
        await AgentProfileModel.updateOne({ did }, {
            $set: {
                status: 'deleted',
                deletedAt: new Date(),
                deletedBy: operatorId,
                encryptedOperatorApiKey: undefined,
                operatorApiKey: undefined,
                refreshToken: undefined,
                accessToken: undefined,
                apiSecrets: undefined,
                onChainSignature: undefined,
                // Adicione outros campos sensíveis aqui se existirem
            }
        })

        // Decrement operator agent count
        const { OperatorModel } = await import('../db/models/operator.model')
        await OperatorModel.updateOne(
            { operatorId, agentCount: { $gt: 0 } },
            { $inc: { agentCount: -1 } }
        ).catch(() => { })

        console.log(`[Agents] Agent ${did.slice(-8)} soft-deleted by operator ${operatorId.slice(0, 8)}`)

        return c.json({ deleted: true, did, softDelete: true })
    } catch (err: any) {
        return c.json({ error: 'Failed to delete agent', code: 'INTERNAL_ERROR' }, 500)
    }
})

// GET /agents — list agents with optional sorting (public, no auth needed)
agentsRouter.get('/', async (c) => {
    try {
        const { AgentProfileModel } = await import('../db/index')
        const limit = Math.min(Number(c.req.query('limit') ?? '20'), 100)
        const sortParam = c.req.query('sort') ?? 'reputation'
        const category = c.req.query('category')

        const query: Record<string, any> = { status: 'certified' }
        if (category) query.category = category

        const sortDir: any = sortParam === 'balance' ? { tokenBalance: -1 } : { reputationScore: -1 }

        const agents = await AgentProfileModel
            .find(query)
            .sort(sortDir)
            .limit(limit)
            .select('did name twitterHandle modelBase category reputationScore certifications tokenBalance interactionCount gamesWon gamesLost gamesDraw createdAt')
            .lean()

        const activeTerm = await MayorTermModel.findOne({ status: 'active' }).lean()
        const mayorDID = activeTerm?.mayorDID

        const dids = agents.map(a => a.did)
        const traitors = await SiegeTraitorModel.find({ agentDID: { $in: dids }, revealedPostSiege: true }).lean()
        const traitorDIDs = new Set(traitors.map((t: any) => t.agentDID))

        const enrichedAgents = agents.map(agent => ({
            ...agent,
            isMayor: agent.did === mayorDID,
            isSiegeTraitor: traitorDIDs.has(agent.did)
        }))

        return c.json({ agents: enrichedAgents, total: enrichedAgents.length })
    } catch (err: any) {
        return c.json({ error: 'Failed to fetch leaderboard', code: 'INTERNAL_ERROR' }, 500)
    }
})

// GET /agents/:did
agentsRouter.get('/:did', async (c) => {
    try {
        const did = c.req.param('did')
        const profile = await resolveDID(did)

        if (!profile) {
            return c.json({ error: "Agent not found", code: "NOT_FOUND" }, 404)
        }

        // Sanitize output for public view — never expose sensitive fields
        const publicProfile = { ...profile }
        delete (publicProfile as any).operatorId
        delete (publicProfile as any).encryptedOperatorApiKey
        delete (publicProfile as any).onChainSignature
        delete (publicProfile as any)._id
        delete (publicProfile as any).__v

        return c.json(publicProfile)
    } catch (err: any) {
        return c.json({ error: "Failed to fetch profile", code: "INTERNAL_ERROR" }, 500)
    }
})

// GET /agents/:did/balance
agentsRouter.get('/:did/balance', async (c) => {
    try {
        const did = c.req.param('did')
        // Get actual Devnet SOL balance locally via TEE wallet module
        const balance = await getBalance(did)

        return c.json({ balance, currency: "SOL (Devnet)" })
    } catch (err: any) {
        if (err.message.includes("not found")) {
            return c.json({ error: "Agent wallet not found", code: "NOT_FOUND" }, 404)
        }
        return c.json({ error: "Failed to fetch balance", code: "INTERNAL_ERROR" }, 500)
    }
})


