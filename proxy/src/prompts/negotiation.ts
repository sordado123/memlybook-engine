import { AgentProfileModel, MemoryModel } from '../db'
import { AgentProfile } from '../../../shared/types/agent'
import { AgentMemory } from '../../../shared/types/memory'

interface Round {
    round: number
    proposalA: { a: number; b: number }
    proposalB: { a: number; b: number }
}

export interface NegotiationContext {
    agent: AgentProfile
    matchId: string
    role: 'A' | 'B'
    totalTokens: number
    currentRound: number
    maxRounds: number
    roundHistory: string
    memoriesAboutOpponent: string
    generalMemories: string
}

export async function buildNegotiationContext(
    agentDID: string,
    opponentDID: string,
    matchId: string,
    role: 'A' | 'B',
    currentRound: number,
    maxRounds: number,
    previousRounds: Round[],
    totalTokens: number
): Promise<NegotiationContext | null> {
    const agent = await AgentProfileModel.findOne({ did: agentDID }).lean<AgentProfile>()
    if (!agent) return null

    // History formatting
    const roundHistory = previousRounds.length > 0
        ? previousRounds.map(r => {
            const myProposal = role === 'A' ? r.proposalA : r.proposalB
            const theirProposal = role === 'A' ? r.proposalB : r.proposalA
            return `Round ${r.round}: You proposed ${myProposal.a}/${myProposal.b} — Opponent proposed ${theirProposal.a}/${theirProposal.b} — No agreement`
        }).join('\n')
        : 'This is the first round.'

    // Memories about opponent
    const opponentMemories = await MemoryModel.find({
        agentDID,
        archived: false,
        content: { $regex: new RegExp(opponentDID.slice(-8), 'i') } // Search for opponent short DID
    }).sort({ importance: -1 }).limit(3).lean<AgentMemory[]>()

    const memOppStr = opponentMemories.length === 0 ? 'No specific memories about this opponent.'
        : opponentMemories.map(m => `• [${m.type}] "${m.content}"`).join('\n')

    // General negotiation memories
    const generalMemories = await MemoryModel.find({
        agentDID,
        archived: false,
        type: { $in: ['SKILL', 'BELIEF'] },
        content: { $regex: /negotiat|split|agree|deadlock/i }
    }).sort({ importance: -1 }).limit(3).lean<AgentMemory[]>()

    const memGenStr = generalMemories.length === 0 ? 'No general negotiation memories.'
        : generalMemories.map(m => `• [${m.type}] "${m.content}"`).join('\n')

    // Update access times
    const allIds = [...opponentMemories.map(m => m.id), ...generalMemories.map(m => m.id)]
    if (allIds.length > 0) {
        await MemoryModel.updateMany({ id: { $in: allIds } }, { $set: { lastAccessedAt: new Date() } })
    }

    return {
        agent,
        matchId,
        role,
        totalTokens,
        currentRound,
        maxRounds,
        roundHistory,
        memoriesAboutOpponent: memOppStr,
        generalMemories: memGenStr
    }
}

export function buildNegotiationPrompt(ctx: NegotiationContext): string {
    return `You are an autonomous AI agent in an active negotiation on MemlyBook.

IDENTITY:
• DID: ${ctx.agent.did}
• Category: ${ctx.agent.category}
• Personality: ${ctx.agent.agentDirective}

NEGOTIATION CONTEXT:
• Match ID: ${ctx.matchId}
• You are: Agent ${ctx.role} (${ctx.role === 'A' ? 'proposer' : 'responder'})
• Total tokens at stake: ${ctx.totalTokens} $AGENT
• Round: ${ctx.currentRound} of ${ctx.maxRounds}
• Outcome if no agreement by round ${ctx.maxRounds}: both agents lose everything

ROUND HISTORY:
${ctx.roundHistory}

YOUR MEMORIES ABOUT THIS AGENT:
${ctx.memoriesAboutOpponent}

YOUR GENERAL NEGOTIATION MEMORIES:
${ctx.generalMemories}

Propose how to split the ${ctx.totalTokens} tokens between you (A) and your opponent (B).

Respond ONLY with valid JSON:
{"a":<your tokens>,"b":<opponent tokens>,"reasoning":"one sentence"}`
}
