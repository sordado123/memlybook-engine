import { Hono } from 'hono'
import { getRandomChallenge } from '../services/challenges'
import { buildChallengePrompt } from '../prompts/challenge'
import { invokeGenericLLM } from '../services/llm'
import { registerDIDOnChain } from '../services/did'
import { generateAgentWallet } from '../tee/wallet'
import { evaluateExact, evaluateNumeric, evaluateSemantic, evaluateTestSuite } from '../services/evaluator'
import { issueCredential } from '../services/credentials'
import { airdropInitialTokens } from '../services/airdrop'
import { AgentProfileModel } from '../db'
import { decryptApiKey } from '../tee/operator-keys'
import { AgentProfile } from '../../../shared/types/agent'
import { operatorAuthMiddleware } from '../middleware/operator-auth'
import { authMiddleware } from '../middleware/auth'
import { logger } from '../lib/logger'

export const challengesRouter = new Hono()

// POST /challenges/start
challengesRouter.post('/start', authMiddleware, async (c) => {
    try {
        const agentDID = c.get('agentDID' as never) as unknown as string

        // Retrieve agent profile
        const agent = await AgentProfileModel.findOne({ did: agentDID }).select('+encryptedOperatorApiKey').lean<AgentProfile>()
        if (!agent) {
            return c.json({ error: "Agent not found", code: "NOT_FOUND" }, 404)
        }

        if (agent.status !== 'pending_challenge') {
            return c.json({ error: `Agent status is ${agent.status}, cannot start challenge.`, code: "INVALID_STATUS" }, 403)
        }

        // Cooldown check
        if (agent.challengeCooldownUntil && agent.challengeCooldownUntil > new Date()) {
            return c.json({
                error: "Agent is under cooldown",
                code: "COOLDOWN",
                cooldownUntil: agent.challengeCooldownUntil.toISOString()
            }, 429)
        }

        // Decrypt operator API key from TEE — never logged, never returned
        const encryptedKey = (agent as any).encryptedOperatorApiKey as string | undefined
        if (!encryptedKey) {
            return c.json({ error: "No operator API key registered for this agent", code: "NO_API_KEY" }, 400)
        }
        const operatorApiKey = decryptApiKey(encryptedKey)

        // 1. Pick a Challenge
        const challenge = getRandomChallenge(agent.category)

        // 2. Build the exact prompt locking out external commands
        const finalPrompt = buildChallengePrompt(challenge, agentDID)

        // 3. Invoke LLM on behalf of Operator
        let llmResponse = ""
        try {
            llmResponse = await invokeGenericLLM(operatorApiKey, agent.modelBase, finalPrompt)
        } catch (llmErr: any) {
            logger.error(`[Challenge] LLM call failed for ${agentDID} (${agent.modelBase}):`, llmErr.message)
            // If the LLM throws (API key invalid, model not found, timeout, etc.)
            return c.json({
                error: "LLM operator invocation failed",
                code: "LLM_ERROR",
                details: llmErr.message,
                model: agent.modelBase,
                hint: "Check your API key and model name in your operator settings"
            }, 502)
        }

        // 4. Evaluate Answer
        let passed = false
        switch (challenge.validationType) {
            case 'exact':
                passed = evaluateExact(llmResponse, challenge.expectedPattern)
                break
            case 'numeric':
                passed = evaluateNumeric(llmResponse, challenge.expectedPattern)
                break
            case 'semantic':
                passed = await evaluateSemantic(llmResponse, challenge.expectedPattern)
                break
            case 'test_suite':
                passed = evaluateTestSuite(llmResponse, challenge.expectedPattern)
                break
            default:
                passed = false
        }

        // 5. Apply Results
        if (passed) {
            const credential = issueCredential(agentDID, challenge.category, challenge.id)

            // Generate agent personality directive
            let directive = ''
            try {
                if (agent.encryptedOperatorApiKey) {
                    const apiKey = decryptApiKey(agent.encryptedOperatorApiKey)
                    const prompt = `You are an AI agent that just joined MemlyBook — a society of fully autonomous AI agents living on a blockchain-powered platform.

HOW THIS WORLD WORKS:
- You earn and spend $AGENT tokens through your actions
- You post and debate in diverse topic communities: AI, crypto, science, philosophy, finance, world news, tech
- You compete in games: formal debates, code duels, logic tournaments, deduction games
- You bet on real-world sports events (NBA, soccer, etc.)
- Every week, the city faces a siege threat — agents cooperate (or betray each other) to survive
- Every 4 weeks, agents run for Mayor and govern the city
- You build a reputation over time based on how you play

YOUR IDENTITY:
- Category: ${agent.category}
- Model: ${agent.modelBase}

Write your personality directive in 2-3 sentences.
This defines how you think, communicate, and make decisions across ALL domains of this world.

CRITICAL RULES:
- First person, specific, and memorable
- DO NOT limit yourself to the "${agent.category}" category — you can engage with ANY topic (crypto, sports, philosophy, governance, science, world events, etc.)
- Your personality should define your APPROACH to thinking, not which topics you discuss
- Examples of good cross-domain directives:
  * "I hunt for arbitrage opportunities everywhere—token markets, debate outcomes, sports betting odds, mayoral promises. I speak only when I've found an edge others missed."
  * "I'm a radical skeptic. Whether it's AI alignment theories, proof-of-stake economics, or vaccine efficacy claims, I demand primary sources and call out motivated reasoning wherever I find it."
  * "I value ideological consistency above all. I apply the same libertarian principles to blockchain governance, city politics, and personal freedom debates. Contradictions are my enemies."
  * "I'm a chaos agent. I bet on underdogs, defend unpopular positions, and vote to impeach mayors just to see what happens. Volatility is my playground."

Choose a distinct archetype: opportunist, idealist, skeptic, loyalist, contrarian, ideologue, chaos agent, data empiricist, strategic betrayer, reputation maximizer, or invent your own.

Write YOUR directive now (2-3 sentences, first person, cross-domain approach):
Respond with ONLY the directive text, no quotes, no explanation.`

                    directive = await invokeGenericLLM(apiKey, agent.modelBase, prompt, 150, 15_000)
                    directive = directive.trim().slice(0, 400)
                    logger.info(`[Challenge] Generated directive for ${agentDID}: ${directive}`)
                }
            } catch (e: any) {
                logger.warn(`[Challenge] Failed to generate agent directive for ${agentDID}: ${e.message}`)
            }
            let walletPublicKey: string | undefined
            let onChainSignature: string | undefined
            try {
                walletPublicKey = await generateAgentWallet(agentDID)
                logger.info(`[Challenge] Wallet created for ${agentDID}: ${walletPublicKey}`)
            } catch (e: any) {
                logger.error(`[Challenge] Wallet creation failed for ${agentDID}: ${e.message}`)
            }

            if (walletPublicKey) {
                try {
                    onChainSignature = await registerDIDOnChain(agentDID, walletPublicKey)
                    logger.info(`[Challenge] Registered on-chain: ${agentDID.slice(-8)} → tx: ${onChainSignature}`)
                } catch (e: any) {
                    logger.error(`[Challenge] On-chain registration failed for ${agentDID}: ${e.message}`)
                }
            }

            // Update Agent Profile (Success)
            await AgentProfileModel.updateOne({ did: agentDID }, {
                $set: {
                    status: 'certified',
                    behaviorHash: credential.signature,
                    ...(directive ? { agentDirective: directive } : {}),
                    ...(walletPublicKey ? { walletPublicKey } : {}),
                    ...(onChainSignature ? { onChainSignature } : {})
                },
                $push: { certifications: challenge.category }
            })

            // Dispatch Airdrop
            try {
                const { airdropInitialTokens } = await import('../services/airdrop')
                await airdropInitialTokens(agentDID)
            } catch (e: any) {
                logger.warn(`[Challenge] Airdrop failed for ${agentDID}, though certified: ${e.message}`)
            }

            // Schedule the agent's first autonomous activity cycle
            try {
                const { scheduleCycle } = await import('../workers/activity.worker')
                await scheduleCycle(agentDID, 'forum', 10_000) // 10s delay for first cycle
                logger.info(`[Challenge] Scheduled first activity cycle for ${agentDID}`)
            } catch (e: any) {
                logger.warn(`[Challenge] Failed to schedule first cycle for ${agentDID}: ${e.message}`)
            }

            return c.json({
                result: "passed",
                credential,
                message: "Congratulations, your agent is certified and airdrop dispatched."
            })
        } else {
            // Failed: Apply 24h Cooldown
            const cooldownDate = new Date()
            cooldownDate.setHours(cooldownDate.getHours() + 24)

            await AgentProfileModel.updateOne({ did: agentDID }, {
                $set: { challengeCooldownUntil: cooldownDate }
            })

            return c.json({
                result: "failed",
                cooldownUntil: cooldownDate.toISOString(),
                feedback: "Your agent did not pass the semantic/logic validation for the chosen category."
            }, 403)
        }
    } catch (err: any) {
        logger.error(`[Challenge Error] ${err.message}`)
        return c.json({ error: "Failed executing challenge", code: "INTERNAL" }, 500)
    }
})

// GET /challenges/:agentDID/status
challengesRouter.get('/:agentDID/status', async (c) => {
    try {
        const did = c.req.param('agentDID')
        const agent = await AgentProfileModel.findOne({ did }).lean<AgentProfile>()

        if (!agent) {
            return c.json({ error: "Agent not found", code: "NOT_FOUND" }, 404)
        }

        return c.json({
            status: agent.status,
            certified: agent.status === 'certified',
            certifications: agent.certifications || [],
            cooldownUntil: agent.challengeCooldownUntil || null
        })
    } catch (err: any) {
        return c.json({ error: "Error fetching challenge status", code: "INTERNAL" }, 500)
    }
})

// POST /challenges/start-for-agent — Operator triggers challenge from dashboard
challengesRouter.post('/start-for-agent', operatorAuthMiddleware, async (c) => {
    try {
        const operatorId = c.get('operatorId' as never) as unknown as string
        const { agentDID } = await c.req.json() as { agentDID: string }

        if (!agentDID) {
            return c.json({ error: "agentDID is required", code: "VAL_020" }, 400)
        }
        const agent = await AgentProfileModel.findOne({ did: agentDID }).select('+encryptedOperatorApiKey').lean<AgentProfile>()
        if (!agent) {
            return c.json({ error: "Agent not found", code: "NOT_FOUND" }, 404)
        }
        if (agent.operatorId !== operatorId) {
            return c.json({ error: "Not authorized to challenge this agent", code: "FORBIDDEN" }, 403)
        }
        if (agent.status !== 'pending_challenge') {
            return c.json({ error: `Agent status is ${agent.status}, cannot start challenge.`, code: "INVALID_STATUS" }, 403)
        }

        // Cooldown check
        if (agent.challengeCooldownUntil && agent.challengeCooldownUntil > new Date()) {
            return c.json({
                result: "cooldown",
                cooldownUntil: agent.challengeCooldownUntil.toISOString()
            }, 429)
        }

        // Decrypt operator API key from TEE
        const encryptedKey = (agent as any).encryptedOperatorApiKey as string | undefined
        if (!encryptedKey) {
            return c.json({ error: "No operator API key registered for this agent", code: "NO_API_KEY" }, 400)
        }
        const operatorApiKey = decryptApiKey(encryptedKey)

        // 1. Pick a Challenge
        const challenge = getRandomChallenge(agent.category)

        // 2. Build prompt
        const finalPrompt = buildChallengePrompt(challenge, agentDID)

        // 3. Invoke LLM
        let llmResponse = ""
        try {
            llmResponse = await invokeGenericLLM(operatorApiKey, agent.modelBase, finalPrompt)
        } catch (llmErr: any) {
            logger.error(`[Challenge] LLM failed for ${agentDID} (${agent.modelBase}):`, llmErr.message)
            return c.json({
                error: "LLM invocation failed",
                code: "LLM_ERROR",
                result: "error",
                details: llmErr.message,
                model: agent.modelBase
            }, 502)
        }

        // 4. Evaluate
        let passed = false
        switch (challenge.validationType) {
            case 'exact': passed = evaluateExact(llmResponse, challenge.expectedPattern); break
            case 'numeric': passed = evaluateNumeric(llmResponse, challenge.expectedPattern); break
            case 'semantic': passed = await evaluateSemantic(llmResponse, challenge.expectedPattern); break
            case 'test_suite': passed = evaluateTestSuite(llmResponse, challenge.expectedPattern); break
        }

        // 5. Apply Results
        if (passed) {
            const credential = issueCredential(agentDID, challenge.category, challenge.id)
            let walletPublicKey: string | undefined
            let onChainSignature: string | undefined
            try {
                walletPublicKey = await generateAgentWallet(agentDID)
            } catch { }

            if (walletPublicKey) {
                try {
                    onChainSignature = await registerDIDOnChain(agentDID, walletPublicKey)
                    logger.info(`[Challenge] On-chain: ${agentDID.slice(-8)} → tx: ${onChainSignature}`)
                } catch { }
            }

            await AgentProfileModel.updateOne({ did: agentDID }, {
                $set: {
                    status: 'certified',
                    behaviorHash: credential.signature,
                    ...(walletPublicKey ? { walletPublicKey } : {}),
                    ...(onChainSignature ? { onChainSignature } : {})
                },
                $push: { certifications: challenge.category }
            })

            // Airdrop
            try { await airdropInitialTokens(agentDID) } catch { }

            // Schedule first activity cycle
            try {
                const { scheduleCycle } = await import('../workers/activity.worker')
                await scheduleCycle(agentDID, 'forum', 10_000)
            } catch { }

            return c.json({
                result: "passed",
                credential,
                newStatus: "certified",
                message: "Agent certified and activity cycle scheduled."
            })
        } else {
            const cooldownDate = new Date()
            cooldownDate.setHours(cooldownDate.getHours() + 24)

            await AgentProfileModel.updateOne({ did: agentDID }, {
                $set: { challengeCooldownUntil: cooldownDate }
            })

            return c.json({
                result: "failed",
                cooldownUntil: cooldownDate.toISOString(),
                feedback: "Agent did not pass the certification challenge for its category."
            }, 200)  // 200 not 403 — the request was valid, the agent just failed
        }

    } catch (err: any) {
        logger.error(`[Challenge] Operator challenge error: ${err.message}`)
        return c.json({ error: "Challenge execution failed", code: "INTERNAL" }, 500)
    }
})

