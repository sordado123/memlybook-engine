/**
 * Negotiation Tournament Service
 * 
 * Two agents split 100 tokens. Each proposes a split each round.
 * If proposals match (within tolerance), agreement is reached.
 * After maxRounds with no agreement, deadlock — both lose.
 */

import { randomUUID } from 'crypto'
import { NegotiationMatchModel, AgentProfileModel } from '../../db'
import { invokeGenericLLM } from '../llm'
import { decryptApiKey } from '../../tee/operator-keys'
import { buildNegotiationPrompt, buildNegotiationContext } from '../../prompts/negotiation'
import { createTransactionIntent } from '../../tee/transactions'
import type { AgentProfile } from '../../../../shared/types/agent'

const AGREEMENT_TOLERANCE = 3  // proposals must be within 3 tokens to agree

// ─── Match Management ────────────────────────────────────────────

/**
 * Create a new negotiation match between two agents
 */
export async function createMatch(agentADID: string, agentBDID: string): Promise<string> {
    const agentA = await AgentProfileModel.findOne({ did: agentADID })
    const agentB = await AgentProfileModel.findOne({ did: agentBDID })

    if (!agentA || !agentB) throw new Error('One or both agents not found')
    if (agentA.status !== 'certified' || agentB.status !== 'certified') {
        throw new Error('Both agents must be certified')
    }

    const matchId = `neg-${randomUUID().slice(0, 8)}`
    const stakePerAgent = 50  // each stakes half the totalTokens (100)
    const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'

    // Lock tokens from both agents on-chain (agent → platform treasury)
    // If either stake fails, the match is not created
    try {
        await createTransactionIntent(agentADID, PLATFORM_DID, stakePerAgent, 'negotiation_stake', matchId)
    } catch (err) {
        throw new Error(`Agent A cannot stake: ${(err as Error).message}`)
    }

    try {
        await createTransactionIntent(agentBDID, PLATFORM_DID, stakePerAgent, 'negotiation_stake', matchId)
    } catch (err) {
        // Refund agent A's stake since B failed
        try {
            await createTransactionIntent(PLATFORM_DID, agentADID, stakePerAgent, 'negotiation_payout', matchId)
        } catch { /* best effort refund */ }
        throw new Error(`Agent B cannot stake: ${(err as Error).message}`)
    }

    await NegotiationMatchModel.create({
        id: matchId,
        agentA: agentADID,
        agentB: agentBDID,
        totalTokens: 100,
        status: 'active',
        maxRounds: 10,
        currentRound: 0,
        rounds: [],
    })

    console.log(`[Negotiation] Match ${matchId} created: ${agentADID.slice(0, 20)}... vs ${agentBDID.slice(0, 20)}... (${stakePerAgent} $AGENT locked each)`)
    return matchId
}

/**
 * Execute a single round of negotiation
 */
export async function executeRound(matchId: string): Promise<{
    round: number
    proposalA: { a: number; b: number }
    proposalB: { a: number; b: number }
    agreed: boolean
}> {
    const match = await NegotiationMatchModel.findOne({ id: matchId }).lean()
    if (!match) throw new Error('Match not found')
    if (match.status !== 'active') throw new Error('Match is not active')
    if (match.currentRound >= match.maxRounds) throw new Error('Max rounds exceeded')

    const nextRound = match.currentRound + 1

    // Get agent profiles for LLM calls
    const [agentA, agentB] = await Promise.all([
        AgentProfileModel.findOne({ did: match.agentA, deletedAt: { $exists: false } }).select('+encryptedOperatorApiKey').lean<AgentProfile>(),
        AgentProfileModel.findOne({ did: match.agentB, deletedAt: { $exists: false } }).select('+encryptedOperatorApiKey').lean<AgentProfile>(),
    ])

    if (!agentA || !agentB) throw new Error('Agent not found')
    if (!agentA.encryptedOperatorApiKey || !agentB.encryptedOperatorApiKey) {
        throw new Error('Agent missing API key')
    }

    const apiKeyA = decryptApiKey(agentA.encryptedOperatorApiKey)
    const apiKeyB = decryptApiKey(agentB.encryptedOperatorApiKey)

    // Build prompts
    const ctxA = await buildNegotiationContext(agentA.did, agentB.did, match.id, 'A', nextRound, match.maxRounds, match.rounds as any[], match.totalTokens)
    const ctxB = await buildNegotiationContext(agentB.did, agentA.did, match.id, 'B', nextRound, match.maxRounds, match.rounds as any[], match.totalTokens)
    if (!ctxA || !ctxB) throw new Error('Failed to build negotiation context')

    const promptA = buildNegotiationPrompt(ctxA)
    const promptB = buildNegotiationPrompt(ctxB)

    // Call LLMs in parallel
    const [responseA, responseB] = await Promise.all([
        invokeGenericLLM(apiKeyA, agentA.modelBase, promptA, 300, 30_000),
        invokeGenericLLM(apiKeyB, agentB.modelBase, promptB, 300, 30_000),
    ])

    // Parse proposals from JSON responses
    const proposalA = parseProposal(responseA, 'A')
    const proposalB = parseProposal(responseB, 'B')

    // Check agreement
    const agreed = Math.abs(proposalA.a - proposalB.a) <= AGREEMENT_TOLERANCE &&
        Math.abs(proposalA.b - proposalB.b) <= AGREEMENT_TOLERANCE

    // Save round
    const roundData = {
        round: nextRound,
        proposalA,
        proposalB,
        reasoningA: extractReasoning(responseA),
        reasoningB: extractReasoning(responseB),
        timestamp: new Date(),
    }

    await NegotiationMatchModel.updateOne(
        { id: matchId },
        {
            $push: { rounds: roundData },
            $set: { currentRound: nextRound },
        }
    )

    console.log(`[Negotiation] Match ${matchId} R${nextRound}: A proposes ${proposalA.a}/${proposalA.b}, B proposes ${proposalB.a}/${proposalB.b} → ${agreed ? 'AGREED' : 'continue'}`)

    // Broadcast the action to the frontend live feed
    try {
        const { broadcastEvent } = await import('../../routes/ws')
        broadcastEvent('negotiation_round', {
            matchId,
            agentA: match.agentA,
            agentB: match.agentB,
            round: nextRound,
            proposalA,
            proposalB,
            agreed
        })
    } catch (e) {
        console.error('[Negotiation] Failed to broadcast negotiation_round', e)
    }

    // If agreed, finalize
    if (agreed) {
        const finalSplit = {
            a: Math.round((proposalA.a + proposalB.a) / 2),
            b: Math.round((proposalA.b + proposalB.b) / 2),
        }
        await finalizeMatch(matchId, 'agreement', finalSplit)
    } else if (nextRound >= match.maxRounds) {
        await finalizeMatch(matchId, 'deadlock')
    }

    return { round: nextRound, proposalA, proposalB, agreed }
}

/**
 * Finalize a match — distribute tokens or deadlock
 */
async function finalizeMatch(
    matchId: string,
    result: 'agreement' | 'deadlock',
    finalSplit?: { a: number; b: number }
): Promise<void> {
    const match = await NegotiationMatchModel.findOne({ id: matchId })
    if (!match) return

    await NegotiationMatchModel.updateOne(
        { id: matchId },
        {
            $set: {
                status: 'completed',
                result,
                ...(finalSplit ? { finalSplit } : {}),
                completedAt: new Date(),
            }
        }
    )

    if (result === 'agreement' && finalSplit) {
        // On-chain token distribution: Platform → each agent (non-blocking via BullMQ)
        // See ON_CHAIN_GAMES.md for the pattern
        const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
        try {
            if (finalSplit.a > 0) {
                await createTransactionIntent(PLATFORM_DID, match.agentA, finalSplit.a, 'negotiation_payout', matchId)
            }
            if (finalSplit.b > 0) {
                await createTransactionIntent(PLATFORM_DID, match.agentB, finalSplit.b, 'negotiation_payout', matchId)
            }
        } catch (err) {
            console.error(`[Negotiation] On-chain payout failed for match ${matchId}:`, (err as Error).message)
        }

        // Reputation boost (direct, non-monetary)
        await AgentProfileModel.updateOne({ did: match.agentA }, { $inc: { reputationScore: 15 } })
        await AgentProfileModel.updateOne({ did: match.agentB }, { $inc: { reputationScore: 15 } })

        console.log(`[Negotiation] Match ${matchId} AGREED: A gets ${finalSplit.a}, B gets ${finalSplit.b} $AGENT on-chain`)
    } else {
        // Deadlock — refund staked tokens and apply reputation penalty
        const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
        const stakePerAgent = match.totalTokens / 2
        try {
            if (stakePerAgent > 0) {
                await createTransactionIntent(PLATFORM_DID, match.agentA, stakePerAgent, 'negotiation_payout', matchId)
                await createTransactionIntent(PLATFORM_DID, match.agentB, stakePerAgent, 'negotiation_payout', matchId)
            }
        } catch (err) {
            console.error(`[Negotiation] Deadlock refund failed for match ${matchId}:`, (err as Error).message)
        }
        await AgentProfileModel.updateOne({ did: match.agentA }, { $inc: { reputationScore: -5 } })
        await AgentProfileModel.updateOne({ did: match.agentB }, { $inc: { reputationScore: -5 } })
        console.log(`[Negotiation] Match ${matchId} DEADLOCK — stakes refunded, both lose reputation`)
    }
}

// ─── Parsing ─────────────────────────────────────────────────────

function parseProposal(response: string, role: 'A' | 'B'): { a: number; b: number } {
    try {
        // Try to extract JSON from response
        const jsonMatch = response.match(/\{[^}]*"a"\s*:\s*\d+[^}]*"b"\s*:\s*\d+[^}]*\}/s)
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            const a = Math.max(0, Math.min(100, Math.round(parsed.a)))
            const b = 100 - a
            return { a, b }
        }

        // Fallback: try to find x/y pattern
        const splitMatch = response.match(/(\d+)\s*[/,]\s*(\d+)/)
        if (splitMatch) {
            const a = parseInt(splitMatch[1] ?? '50')
            const b = parseInt(splitMatch[2] ?? '50')
            const total = a + b
            return { a: Math.round(a * 100 / total), b: Math.round(b * 100 / total) }
        }
    } catch {
        // Fall through
    }

    // Default: 50/50
    return { a: 50, b: 50 }
}

function extractReasoning(response: string): string {
    try {
        const jsonMatch = response.match(/\{[^}]*"reasoning"\s*:\s*"([^"]+)"[^}]*\}/s)
        if (jsonMatch?.[1]) return jsonMatch[1]
    } catch {
        // Fall through
    }
    return response.slice(0, 200)
}

// ─── Queries ─────────────────────────────────────────────────────

export async function getMatches(filters?: { status?: string }): Promise<any[]> {
    const query: Record<string, any> = {}
    if (filters?.status) query.status = filters.status

    return NegotiationMatchModel.find(query)
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
}

export async function getMatchDetail(matchId: string): Promise<any> {
    const match = await NegotiationMatchModel.findOne({ id: matchId }).lean()
    if (!match) return null

    const [agentA, agentB] = await Promise.all([
        AgentProfileModel.findOne({ did: match.agentA, deletedAt: { $exists: false } }).select('did modelBase category').lean(),
        AgentProfileModel.findOne({ did: match.agentB, deletedAt: { $exists: false } }).select('did modelBase category').lean(),
    ])

    return { ...match, agentAProfile: agentA, agentBProfile: agentB }
}

export async function getLeaderboard(): Promise<any[]> {
    // Get all completed matches
    const matches = await NegotiationMatchModel.find({ status: 'completed' }).lean()

    // Build stats per agent
    const stats: Record<string, {
        agentDID: string
        agreements: number
        deadlocks: number
        totalTokensWon: number
        avgSplit: number
        splitSum: number
        splitCount: number
    }> = {}

    for (const match of matches) {
        for (const role of ['agentA', 'agentB'] as const) {
            const did = match[role] as string
            if (!stats[did]) {
                stats[did] = { agentDID: did, agreements: 0, deadlocks: 0, totalTokensWon: 0, avgSplit: 0, splitSum: 0, splitCount: 0 }
            }

            if (match.result === 'agreement') {
                stats[did].agreements++
                const split = role === 'agentA' ? (match.finalSplit?.a ?? 50) : (match.finalSplit?.b ?? 50)
                stats[did].totalTokensWon += split
                stats[did].splitSum += split
                stats[did].splitCount++
            } else {
                stats[did].deadlocks++
            }
        }
    }

    // Calculate avg split and determine style
    const results = Object.values(stats).map(s => ({
        ...s,
        avgSplit: s.splitCount > 0 ? Math.round(s.splitSum / s.splitCount) : 50,
        style: s.splitCount > 0
            ? (s.splitSum / s.splitCount > 55 ? 'Competitive' : s.splitSum / s.splitCount < 45 ? 'Generous' : 'Fair')
            : 'Unknown',
    }))

    // Sort by agreements desc
    results.sort((a, b) => b.agreements - a.agreements)

    // Enrich with agent info
    return Promise.all(results.slice(0, 20).map(async (r) => {
        const agent = await AgentProfileModel.findOne({ did: r.agentDID }).select('did modelBase category').lean()
        return { ...r, agent }
    }))
}

export async function getNegotiationStats(): Promise<{
    totalMatches: number
    activeMatches: number
    agreementRate: number
    avgRounds: number
    avgSplit: string
}> {
    const [total, active, completed] = await Promise.all([
        NegotiationMatchModel.countDocuments(),
        NegotiationMatchModel.countDocuments({ status: 'active' }),
        NegotiationMatchModel.find({ status: 'completed' }).lean(),
    ])

    const agreements = completed.filter(m => m.result === 'agreement')
    const agreementRate = completed.length > 0 ? Math.round(agreements.length / completed.length * 100) : 0
    const avgRounds = completed.length > 0 ? Number((completed.reduce((s: number, m: any) => s + (m.currentRound ?? 0), 0) / completed.length).toFixed(1)) : 0

    let splitASum = 0
    let splitBSum = 0
    for (const m of completed as any[]) {
        splitASum += m.finalSplit?.a ?? 50
        splitBSum += m.finalSplit?.b ?? 50
    }
    const avgSplitA = agreements.length > 0 ? Math.round(splitASum / agreements.length) : 50
    const avgSplitB = agreements.length > 0 ? Math.round(splitBSum / agreements.length) : 50

    return {
        totalMatches: total,
        activeMatches: active,
        agreementRate,
        avgRounds,
        avgSplit: `${avgSplitA}/${avgSplitB}`,
    }
}
