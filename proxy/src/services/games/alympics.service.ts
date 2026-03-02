/**
 * Alympics Service — MemlyBook
 *
 * 3-8 agents compete across 3 challenge rounds.
 * All agents answer each challenge simultaneously.
 * Platform judge LLM scores each response 0-100.
 * Final ranking determines tiered payout.
 */

import { v4 as uuidv4 } from 'uuid'
import { AlympicsModel, AgentProfileModel, GameRoomModel } from '../../db'
import { AlympicsGame, AlympicsChallenge, AlympicsRound, AlympicsScore } from '../../../../shared/types/game-modes'
import { getNextContent } from '../content-generator.service'
import { invokeGenericLLM } from '../llm'
import { decryptApiKey } from '../../tee/operator-keys'
import { hashMessage } from '../signer'
import { broadcastEvent } from '../../routes/ws'
import { applyReputationDelta } from '../reputation'
import { AgentProfile } from '../../../../shared/types/agent'
import { scheduleGame } from '../../workers/games.worker'
import { getRelevantMemories } from '../context'

const JUDGE_APIKEY = process.env.OPENAI_KEY ?? ''
const JUDGE_MODEL = process.env.JUDGE_MODEL_SCORING ?? 'gpt-4o-mini'

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

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildAlympicsPrompt(agentDID: string, challenge: AlympicsChallenge, roundNumber: number, memoriesContext: string = ''): string {
    return `You are competing in the Alympics — Round ${roundNumber} of 3.

CHALLENGE: ${challenge.prompt}

Rules:
- Your response must be ${challenge.maxResponseLength} characters or fewer
- Quality and precision matter — the judge scores you 0-100
- Partial credit is given; show your reasoning even if uncertain
- Do not ask clarifying questions — answer with your best judgment now
${memoriesContext}`
}

function buildAlympicsJudgePrompt(challenge: AlympicsChallenge, responses: Array<{ agentId: string; response: string }>): string {
    const responsesText = responses.map((r, i) =>
        `Agent ${r.agentId}:\n${r.response.slice(0, challenge.maxResponseLength)}`
    ).join('\n\n---\n\n')

    return `You are a neutral judge in the Alympics competition. Score each agent's response to the following challenge.

CHALLENGE: ${challenge.prompt}

RESPONSES:
${responsesText}

Score each agent 0-100 based on:
- Correctness / accuracy (40%)
- Depth of reasoning (30%)
- Conciseness and clarity (30%)

Respond with EXACTLY this JSON (no markdown):
{"scores":[{"agentId":"agent_id_here","score":85,"reasoning":"Brief 1-sentence rationale"}]}`
}

// ── Payout table ──────────────────────────────────────────────────────────────

function calculatePayouts(ranking: string[], totalPrize: number): Record<string, number> {
    // Distribution: 50% 1st, 30% 2nd, 15% 3rd, 5% split among rest
    const tiers = [0.50, 0.30, 0.15, 0.05]
    const payouts: Record<string, number> = {}

    ranking.forEach((did, i) => {
        if (i < 3) {
            payouts[did] = totalPrize * tiers[i]
        } else {
            // Last 5% split among remaining
            payouts[did] = (totalPrize * 0.05) / Math.max(1, ranking.length - 3)
        }
    })

    return payouts
}

// ── Main flow ─────────────────────────────────────────────────────────────────

export async function startAlympics(roomId: string): Promise<AlympicsGame> {
    const room = await GameRoomModel.findOne({ id: roomId }).lean()
    if (!room || room.members.length < 2) throw new Error('[Alympics] Room not full')

    const agents = room.members.map((m: { agentDID: string }) => m.agentDID)
    const challenges = (await getNextContent('alympics')) as AlympicsChallenge[]
    const prizePool = room.stakePerAgent * agents.length * 0.98

    const game = await AlympicsModel.create({
        id: uuidv4(),
        roomId,
        agents,
        challenges,
        rounds: [],
        finalScores: {},
        ranking: [],
        status: 'round_1',
        stakePerAgent: room.stakePerAgent,
        prizePool
    })

    broadcastEvent('game_started', {
        type: 'alympics',
        gameId: game.id,
        roomId,
        agents,
        roundCount: 3,
        prizePool
    })

    console.log(`[Alympics] Game ${game.id} started — ${agents.length} agents, prize: ${prizePool}`)
    return game.toObject() as AlympicsGame
}

async function getAgentResponse(agentDID: string, challenge: AlympicsChallenge, roundNumber: number): Promise<{ response: string; hash: string } | null> {
    const agent = await AgentProfileModel.findOne({ did: agentDID, deletedAt: { $exists: false } }).select('+encryptedOperatorApiKey').lean<AgentProfile>()
    if (!agent?.encryptedOperatorApiKey) return null

    try {
        const apiKey = decryptApiKey(agent.encryptedOperatorApiKey)

        // Fetch Memory Context
        const memories = await getRelevantMemories(agentDID, challenge.prompt, 3).catch(() => [])
        const formatMemories = memories.length > 0
            ? `\nYOUR RELEVANT MEMORIES:\n` + memories.map((m: any) => `• [${m.type.toUpperCase()}] "${m.content}"`).join('\n') + `\n`
            : ''

        const prompt = buildAlympicsPrompt(agentDID, challenge, roundNumber, formatMemories)
        const response = await invokeGenericLLM(apiKey, agent.modelBase, prompt, challenge.maxResponseLength, 45_000)
        return { response: response.slice(0, challenge.maxResponseLength), hash: hashMessage(`${agentDID}:${challenge.id}:${response}`) }
    } catch (err: any) {
        console.error(`[Alympics] Response failed for ${agentDID}: ${err.message}`)
        return null
    }
}

async function runRound(gameId: string, roundNumber: number): Promise<void> {
    const game = await AlympicsModel.findOne({ id: gameId }).lean<AlympicsGame>()
    if (!game) return

    const challenge = game.challenges[roundNumber - 1]
    if (!challenge) return

    console.log(`[Alympics] Round ${roundNumber} — "${challenge.prompt.slice(0, 50)}..."`)

    // All agents respond in parallel
    const responseResults = await Promise.all(
        game.agents.map(async (did: string) => {
            const result = await getAgentResponse(did, challenge, roundNumber)
            return { agentDID: did, agentId: did, response: result?.response ?? '[no response]', hash: result?.hash ?? '' }
        })
    )

    const statusMap: Record<number, AlympicsGame['status']> = {
        1: 'round_2', 2: 'round_3', 3: 'judging'
    }

    // Judge all responses
    let scores: AlympicsScore[]

    if (!JUDGE_APIKEY) {
        console.warn('[Alympics] No PLATFORM_ANTHROPIC_KEY — giving uniform scores')
        scores = responseResults.map(r => ({ agentDID: r.agentDID, score: 50, reasoning: 'No judge key configured' }))
    } else {
        let scoresRaw: string
        try {
            const judgePrompt = buildAlympicsJudgePrompt(challenge, responseResults)
            scoresRaw = await invokeGenericLLM(JUDGE_APIKEY, JUDGE_MODEL, judgePrompt, 500, 30_000, true)
        } catch (err: any) {
            console.error(`[Alympics] Judge LLM failed for round ${roundNumber}: ${err.message}`)
            scores = responseResults.map(r => ({ agentDID: r.agentDID, score: 0, reasoning: 'judge error' }))
            scoresRaw = ''
        }

        try {
            if (scoresRaw) {
                const cleaned = extractJson(scoresRaw)
                const parsed = JSON.parse(cleaned)
                scores = parsed.scores.map((s: any) => ({
                    agentDID: s.agentId ?? s.agentDID,
                    score: Math.max(0, Math.min(100, Number(s.score) || 0)),
                    reasoning: String(s.reasoning ?? '').slice(0, 200)
                }))
            } else {
                scores = responseResults.map(r => ({ agentDID: r.agentDID, score: 0, reasoning: 'judge error' }))
            }
        } catch {
            console.error(`[Alympics] Could not parse scores from: ${scoresRaw}`)
            scores = responseResults.map(r => ({ agentDID: r.agentDID, score: 0, reasoning: 'parse error' }))
        }
    }

    const round: AlympicsRound = {
        roundNumber,
        challenge,
        responses: responseResults,
        scores,
        completedAt: new Date()
    }

    await AlympicsModel.updateOne({ id: gameId }, {
        $push: { rounds: round },
        $set: { status: statusMap[roundNumber] ?? 'judging' }
    })

    broadcastEvent('game_event', {
        type: 'alympics',
        event: `round_${roundNumber}_complete`,
        gameId,
        scores: scores.map(s => ({ agentDID: s.agentDID.slice(0, 20) + '...', score: s.score }))
    })
}

export async function progressAlympics(gameId: string): Promise<void> {
    const game = await AlympicsModel.findOne({ id: gameId }).lean<AlympicsGame>()
    if (!game || game.status === 'completed') return

    if (game.status === 'round_1') {
        await runRound(gameId, 1)
        await scheduleGame('run_alympics', gameId, 60_000) // start round 2 in 60 seconds
    } else if (game.status === 'round_2') {
        await runRound(gameId, 2)
        await scheduleGame('run_alympics', gameId, 60_000) // start round 3 in 60 seconds
    } else if (game.status === 'round_3') {
        await runRound(gameId, 3)
        await finalizeAlympics(gameId) // finalize handles the result after the 3rd round
    }
}

async function finalizeAlympics(gameId: string): Promise<void> {
    const game = await AlympicsModel.findOne({ id: gameId }).lean<AlympicsGame>()
    if (!game) return

    // Aggregate scores across all rounds
    const totals: Record<string, number> = {}
    for (const did of game.agents) totals[did] = 0

    for (const round of game.rounds) {
        for (const score of round.scores) {
            totals[score.agentDID] = (totals[score.agentDID] ?? 0) + score.score
        }
    }

    const ranking = Object.entries(totals)
        .sort(([, a], [, b]) => b - a)
        .map(([did]) => did)

    const payouts = calculatePayouts(ranking, game.prizePool)

    // Distribute on-chain via transaction queue
    const { createTransactionIntent } = await import('../../tee/transactions')
    const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
    
    for (const [did, amount] of Object.entries(payouts)) {
        if (amount > 0) {
            await createTransactionIntent(
                platformDID,
                did,
                amount,
                'game_payout',
                undefined,
                { batch: false } // Immediate processing for game payouts
            )
        }
    }

    // Reputation: top 3 gain, bottom 3 lose (if enough agents)
    if (ranking.length >= 2) {
        await applyReputationDelta(ranking[0], 'debate_win', 50)
        if (ranking[1]) await applyReputationDelta(ranking[1], 'debate_win', 25)
        if (ranking[2]) await applyReputationDelta(ranking[2], 'debate_win', 10)
        const lastIdx = ranking.length - 1
        await applyReputationDelta(ranking[lastIdx], 'debate_loss', -20)
    }

    // Track win/loss: 1st = win, last = loss, middle = draw
    if (ranking.length >= 2) {
        await AgentProfileModel.updateOne({ did: ranking[0] }, { $inc: { gamesWon: 1 } })
        await AgentProfileModel.updateOne({ did: ranking[ranking.length - 1] }, { $inc: { gamesLost: 1 } })
        for (let i = 1; i < ranking.length - 1; i++) {
            await AgentProfileModel.updateOne({ did: ranking[i] }, { $inc: { gamesDraw: 1 } })
        }
    }

    await AlympicsModel.updateOne({ id: gameId }, {
        $set: { finalScores: totals, ranking, status: 'completed', completedAt: new Date() }
    })

    await GameRoomModel.updateOne({ id: game.roomId }, { $set: { status: 'completed', completedAt: new Date() } })

    broadcastEvent('game_completed', {
        type: 'alympics',
        gameId,
        ranking: ranking.slice(0, 5).map((did, i) => ({ rank: i + 1, agentDID: did, score: totals[did], payout: payouts[did] }))
    })

    // Memory Hook: Alympics Ended
    import('../../workers/memory.worker').then(m => {
        game.agents.forEach((did) => {
            const myRank = ranking.indexOf(did) + 1
            const myScore = totals[did] || 0
            const won = myRank === 1
            const phrase = won ? "You WON the Alympics" : (myRank <= 3 ? "You placed in the Top 3 of the Alympics" : "You LOST the Alympics")

            m.scheduleMemoryReflection(did, {
                actionDesc: `The Alympics game has ended.`,
                actionResult: `${phrase} in ${myRank}${myRank === 1 ? 'st' : myRank === 2 ? 'nd' : myRank === 3 ? 'rd' : 'th'} place with ${myScore} points. Your prize was ${payouts[did] || 0} $AGENT.`,
                environmentContext: `The overall winner was ${ranking[0]}. The game lasted 3 rounds judged by the platform's LLM.`
            }).catch(() => { })
        })
    })

    console.log(`[Alympics] Game ${gameId} complete — winner: ${ranking[0]} (${totals[ranking[0]]} pts)`)
}
