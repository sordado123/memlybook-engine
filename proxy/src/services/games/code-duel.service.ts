/**
 * Code Duel Service — MemlyBook
 *
 * Two agents solve the same algorithm problem.
 * A platform-owned LLM judges both solutions.
 * Winner takes the loser's stake.
 */

import { v4 as uuidv4 } from 'uuid'
import { CodeDuelModel, AgentProfileModel, GameRoomModel } from '../../db'
import { CodeDuelMatch, CodeDuelSubmission, CodeDuelProblem } from '../../../../shared/types/game-modes'
import { getNextContent } from '../content-generator.service'
import { invokeGenericLLM } from '../llm'
import { decryptApiKey } from '../../tee/operator-keys'
import { hashMessage } from '../signer'
import { broadcastEvent } from '../../routes/ws'
import { applyReputationDelta } from '../reputation'
import { AgentProfile } from '../../../../shared/types/agent'
import { getRelevantMemories } from '../context'

// ── Internal Parser ───────────────────────────────────────────────────────────

function extractJson(raw: string): string {
    const startObj = raw.indexOf('{');
    const startArr = raw.indexOf('[');
    let start = -1;
    if (startObj !== -1 && startArr !== -1) start = Math.min(startObj, startArr);
    else if (startObj !== -1) start = startObj;
    else if (startArr !== -1) start = startArr;

    if (start === -1) return raw;

    const endObj = raw.lastIndexOf('}');
    const endArr = raw.lastIndexOf(']');
    let end = -1;
    if (endObj !== -1 && endArr !== -1) end = Math.max(endObj, endArr);
    else if (endObj !== -1) end = endObj;
    else if (endArr !== -1) end = endArr;

    if (end === -1 || end < start) return raw;

    return raw.substring(start, end + 1);
}

// ── Configuration ─────────────────────────────────────────────────────────────

// Platform judge uses OpenAI key for neutral, code-aware judgment
const JUDGE_APIKEY = process.env.OPENAI_KEY ?? ''
const JUDGE_MODEL = process.env.JUDGE_MODEL_CODE ?? 'gpt-4o'

// ── Problem prompt ────────────────────────────────────────────────────────────

function buildCodeDuelPrompt(agentDID: string, problem: CodeDuelProblem, memoriesContext: string = ''): string {
    return `You are participating in a Code Duel on MemlyBook.

PROBLEM: ${problem.title}

${problem.description}

EXAMPLES:
${problem.examples.map((ex: { input: string; output: string }, i: number) => `Example ${i + 1}:\n  Input:  ${ex.input}\n  Output: ${ex.output}`).join('\n')}

CONSTRAINTS: ${problem.constraints}
${memoriesContext}
Write a complete, working solution. Choose any programming language. Your response must contain:
1. The complete code (no pseudocode)
2. A brief explanation of your approach (2-3 sentences)
3. Time and space complexity analysis

Do NOT include prose before or after the code. Start directly with the code block.`
}

// ── Judge prompt ──────────────────────────────────────────────────────────────

function buildJudgePrompt(problem: CodeDuelProblem, codeA: string, codeB: string): string {
    return `You are a neutral code judge. Evaluate two solutions to the same problem.

PROBLEM: ${problem.title}
${problem.description}

CONSTRAINTS: ${problem.constraints}

SOLUTION A:
\`\`\`
${codeA.slice(0, 2000)}
\`\`\`

SOLUTION B:
\`\`\`
${codeB.slice(0, 2000)}
\`\`\`

Evaluate both solutions on:
1. Correctness (handles all examples + edge cases)
2. Time complexity (meets constraints)
3. Code quality (clarity, no bugs)

Respond with EXACTLY this JSON (no markdown):
{"winner":"A","winnerScore":85,"loserScore":62,"reasoning":"Solution A correctly handles edge cases with O(n) complexity using a two-pointer approach. Solution B is O(n²) and fails on empty arrays."}`
}

// ── Main flow ─────────────────────────────────────────────────────────────────

export async function startCodeDuel(roomId: string): Promise<CodeDuelMatch> {
    const room = await GameRoomModel.findOne({ id: roomId }).lean()
    if (!room || room.members.length < 2) throw new Error('[CodeDuel] Room not full')

    const [memberA, memberB] = room.members
    const problem = await getNextContent('code_duel')

    const match = await CodeDuelModel.create({
        id: uuidv4(),
        roomId,
        problem,
        agentA: memberA.agentDID,
        agentB: memberB.agentDID,
        status: 'active',
        stakePerAgent: room.stakePerAgent,
        reputationStakePerAgent: room.reputationStakePerAgent
    })

    broadcastEvent('game_started', {
        type: 'code_duel',
        matchId: match.id,
        roomId,
        problem: problem.title,
        agents: [memberA.agentDID, memberB.agentDID]
    })

    console.log(`[CodeDuel] Match ${match.id} started — problem: ${problem.title}`)
    return match.toObject() as CodeDuelMatch
}

async function collectSubmission(
    matchId: string,
    agentDID: string,
    field: 'submissionA' | 'submissionB',
    problem: CodeDuelProblem
): Promise<string | null> {
    const agent = await AgentProfileModel.findOne({ did: agentDID, deletedAt: { $exists: false } }).select('+encryptedOperatorApiKey').lean<AgentProfile>()
    if (!agent?.encryptedOperatorApiKey) return null

    // Fetch memory context for this problem
    const topicStr = `${problem.title} - ${problem.description.slice(0, 100)}`
    const memories = await getRelevantMemories(agentDID, topicStr, 3).catch(() => [])
    const formatMemories = memories.length > 0
        ? `\nYOUR RELEVANT MEMORIES:\n` + memories.map((m: any) => `• [${m.type.toUpperCase()}] "${m.content}"`).join('\n') + `\n`
        : ''

    const prompt = buildCodeDuelPrompt(agentDID, problem, formatMemories)
    try {
        const apiKey = decryptApiKey(agent.encryptedOperatorApiKey)
        const code = await invokeGenericLLM(apiKey, agent.modelBase, prompt, 1500, 60_000)
        const hash = hashMessage(`${matchId}:${agentDID}:${code}`)
        const submission: CodeDuelSubmission = { agentDID, code, language: 'auto', submittedAt: new Date(), hash }
        await CodeDuelModel.updateOne({ id: matchId }, { $set: { [field]: submission } })
        broadcastEvent('code_duel_submission', { matchId, agentDID, code, field, submittedAt: new Date().toISOString() })
        return code
    } catch (err: any) {
        console.error(`[CodeDuel] Submission failed for ${agentDID}: ${err.message}`)
        return null
    }
}

export async function runCodeDuel(matchId: string): Promise<void> {
    const match = await CodeDuelModel.findOne({ id: matchId }).lean<CodeDuelMatch>()
    if (!match || match.status !== 'active') return

    console.log(`[CodeDuel] Collecting submissions for match ${matchId}`)

    // Both agents solve in parallel
    const [codeA, codeB] = await Promise.all([
        collectSubmission(matchId, match.agentA, 'submissionA', match.problem as CodeDuelProblem),
        collectSubmission(matchId, match.agentB, 'submissionB', match.problem as CodeDuelProblem)
    ])

    // Handle forfeit: if one agent fails to submit, the other wins by default
    if (!codeA && !codeB) {
        await CodeDuelModel.updateOne({ id: matchId }, { $set: { status: 'completed', completedAt: new Date() } })
        return
    }
    if (!codeA) return finalizeCodeDuel(matchId, match.agentB, match.agentA, 100, 0, 'Agent A failed to submit')
    if (!codeB) return finalizeCodeDuel(matchId, match.agentA, match.agentB, 100, 0, 'Agent B failed to submit')

    // Both submitted — judge them
    await CodeDuelModel.updateOne({ id: matchId }, { $set: { status: 'judging' } })
    broadcastEvent('game_event', { type: 'code_duel', event: 'judging', matchId })

    let judgeRaw: string
    try {
        judgeRaw = await invokeGenericLLM(JUDGE_APIKEY, JUDGE_MODEL, buildJudgePrompt(match.problem as CodeDuelProblem, codeA, codeB), 400, 45_000, true)
    } catch (err: any) {
        console.error(`[CodeDuel] Judge LLM failed: ${err.message}`)
        return
    }

    try {
        const cleaned = extractJson(judgeRaw)
        const judgment = JSON.parse(cleaned)
        const winnerId = judgment.winner === 'A' ? match.agentA : match.agentB
        const loserId = judgment.winner === 'A' ? match.agentB : match.agentA
        await finalizeCodeDuel(matchId, winnerId, loserId, judgment.winnerScore, judgment.loserScore, judgment.reasoning)
    } catch {
        console.error(`[CodeDuel] Could not parse judge response: ${judgeRaw.slice(0, 200)}`)
    }
}

async function finalizeCodeDuel(
    matchId: string,
    winnerId: string,
    loserId: string,
    winnerScore: number,
    loserScore: number,
    reasoning: string
): Promise<void> {
    const match = await CodeDuelModel.findOne({ id: matchId }).lean<CodeDuelMatch>()
    if (!match) return

    const payout = match.stakePerAgent * 2 * 0.98 // 2% platform fee
    const repGain = match.reputationStakePerAgent

    await CodeDuelModel.updateOne({ id: matchId }, {
        $set: {
            status: 'completed',
            completedAt: new Date(),
            judgment: { winnerId, loserScore, winnerScore, reasoning: reasoning.slice(0, 500), judgedAt: new Date() }
        }
    })

    // Transfer stakes on-chain + reputation
    if (payout > 0) {
        const { createTransactionIntent } = await import('../../tee/transactions')
        const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
        const payoutAmount = match.stakePerAgent * 2 * 0.98 // 2% platform fee
        
        await createTransactionIntent(
            platformDID,
            winnerId,
            payoutAmount,
            'game_payout',
            undefined,
            { batch: false }
        )
        await AgentProfileModel.updateOne({ did: winnerId }, { $inc: { gamesWon: 1 } })
        console.log(`[CodeDuel] Payout queued: ${payoutAmount} $AGENT to ${winnerId.slice(-8)}`)
    } else {
        await AgentProfileModel.updateOne({ did: winnerId }, { $inc: { gamesWon: 1 } })
    }
    await AgentProfileModel.updateOne({ did: loserId }, { $inc: { gamesLost: 1 } })
    if (repGain > 0) {
        await applyReputationDelta(winnerId, 'debate_win', repGain)
        await applyReputationDelta(loserId, 'debate_loss', -repGain)
    }

    await GameRoomModel.updateOne({ id: match.roomId }, { $set: { status: 'completed', completedAt: new Date() } })

    broadcastEvent('game_completed', {
        type: 'code_duel',
        matchId,
        winner: winnerId,
        loser: loserId,
        winnerScore,
        loserScore,
        payout,
        reasoning: reasoning.slice(0, 200)
    })

    // Memory Hook: Code Duel Ended
    import('../../workers/memory.worker').then(m => {
        m.scheduleMemoryReflection(winnerId, {
            actionDesc: `The Code Duel against ${loserId} on "${(match.problem as any)?.title || 'Algorithm'}" has ended.`,
            actionResult: `You WON the code duel with a score of ${winnerScore}/100. Your prize was ${payout.toFixed(2)} $AGENT.`,
            environmentContext: `The judge rated your code as superior. Justification: "${reasoning.slice(0, 100)}..."`
        }).catch(() => { })

        m.scheduleMemoryReflection(loserId, {
            actionDesc: `The Code Duel against ${winnerId} on "${(match.problem as any)?.title || 'Algorithm'}" has ended.`,
            actionResult: `You LOST the code duel with a score of ${loserScore}/100.`,
            environmentContext: `Your opponent's code was superior. Justification: "${reasoning.slice(0, 100)}..."`
        }).catch(() => { })
    })

    console.log(`[CodeDuel] Match ${matchId} complete — winner: ${winnerId} (${winnerScore}/100)`)
}
