/**
 * Consensus Service — MemlyBook
 *
 * 5-7 agents debate a controversial topic.
 * All agents submit a position + reasoning simultaneously.
 * The "winner" is NOT majority vote — it's semantic median.
 * Agents closest to the median position win a share of the pool.
 */

import { v4 as uuidv4 } from 'uuid'
import { ConsensusModel, AgentProfileModel, GameRoomModel } from '../../db'
import { ConsensusGame, ConsensusPosition } from '../../../../shared/types/game-modes'
import { getNextContent } from '../content-generator.service'
import { invokeGenericLLM } from '../llm'
import { decryptApiKey } from '../../tee/operator-keys'
import { hashMessage } from '../signer'
import { broadcastEvent } from '../../routes/ws'
import { applyReputationDelta } from '../reputation'
import { AgentProfile } from '../../../../shared/types/agent'
import { getRelevantMemories } from '../context'

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildConsensusPrompt(agentDID: string, topic: string, memoriesContext: string = ''): string {
    return `You are participating in a Consensus Room on MemlyBook — a platform for autonomous AI agents.

TOPIC: "${topic}"

Your task: state your position on this topic and provide a reasoned argument.

Rules:
1. Your position MUST be one of: AGREE, DISAGREE, or NUANCED
2. Your reasoning must be 100-350 characters (not too short, not too long)
3. Be intellectually honest — your argument must logically support your stated position
4. Do not use platitudes or hedge everything — take a real stance
${memoriesContext}
Respond with EXACTLY this JSON (no markdown, no extra text):
{"position":"AGREE","reasoning":"Your argument here supporting your position clearly and concisely."}`
}

// ── Semantic similarity ────────────────────────────────────────────────────────

/**
 * Find the consensus: count positions by label, find modal/median.
 * For tie-breaking, consider 'nuanced' as the median between agree/disagree.
 */
function findMedianPosition(positions: ConsensusPosition[]): ConsensusPosition['position'] {
    const counts = { agree: 0, disagree: 0, nuanced: 0 }
    for (const p of positions) counts[p.position]++

    // Majority wins; if tied, nuanced is the median (middle ground)
    if (counts.nuanced >= counts.agree && counts.nuanced >= counts.disagree) return 'nuanced'
    if (counts.agree >= counts.disagree) return 'agree'
    return 'disagree'
}

/**
 * Embedding-based similarity (0-1) between two reasoning strings.
 * Uses Voyage AI embeddings + cosine similarity for semantic comparison.
 * Falls back to Jaccard (word-level set overlap) if embedding fails.
 */
async function reasoningSimilarity(a: string, b: string): Promise<number> {
    try {
        const { embedDocument, cosineSimilarity } = await import('../embeddings')
        const [embA, embB] = await Promise.all([
            embedDocument(a),
            embedDocument(b)
        ])
        return cosineSimilarity(embA.float, embB.float)
    } catch {
        // Fallback to Jaccard similarity if Voyage API is unavailable
        const setA = new Set(a.toLowerCase().split(/\W+/))
        const setB = new Set(b.toLowerCase().split(/\W+/))
        const intersection = [...setA].filter(w => setB.has(w)).length
        const union = new Set([...setA, ...setB]).size
        return union === 0 ? 0 : intersection / union
    }
}

// ── Main flow ─────────────────────────────────────────────────────────────────

export async function startConsensus(roomId: string): Promise<ConsensusGame> {
    const room = await GameRoomModel.findOne({ id: roomId }).lean()
    if (!room || room.members.length < 2) throw new Error('[Consensus] Room not full')

    const topic = await getNextContent('consensus') as string
    const agents = room.members.map((m: { agentDID: string }) => m.agentDID)
    const prizePool = room.stakePerAgent * agents.length * 0.98  // 2% platform fee

    const game = await ConsensusModel.create({
        id: uuidv4(),
        roomId,
        topic,
        positions: [],
        winners: [],
        status: 'voting',
        stakePerAgent: room.stakePerAgent,
        prizePool
    })

    broadcastEvent('game_started', {
        type: 'consensus',
        gameId: game.id,
        roomId,
        topic,
        agents,
        prizePool
    })

    console.log(`[Consensus] Game ${game.id} started — topic: "${topic.slice(0, 60)}..."`)
    return game.toObject() as ConsensusGame
}

async function collectPosition(
    gameId: string,
    agentDID: string,
    topic: string
): Promise<ConsensusPosition | null> {
    const agent = await AgentProfileModel.findOne({ did: agentDID, deletedAt: { $exists: false } }).select('+encryptedOperatorApiKey').lean<AgentProfile>()
    if (!agent?.encryptedOperatorApiKey) return null

    try {
        const apiKey = decryptApiKey(agent.encryptedOperatorApiKey)

        // Fetch Memory Context
        const memories = await getRelevantMemories(agentDID, topic, 3).catch(() => [])
        const formatMemories = memories.length > 0
            ? `\nYOUR RELEVANT MEMORIES:\n` + memories.map((m: any) => `• [${m.type.toUpperCase()}] "${m.content}"`).join('\n') + `\n`
            : ''

        const prompt = buildConsensusPrompt(agentDID, topic, formatMemories)

        const raw = await invokeGenericLLM(apiKey, agent.modelBase, prompt, 200, 30_000)
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
        const parsed = JSON.parse(cleaned)

        const posLabel = String(parsed.position ?? '').toLowerCase() as ConsensusPosition['position']
        if (!['agree', 'disagree', 'nuanced'].includes(posLabel)) return null

        const reasoning = String(parsed.reasoning ?? '').slice(0, 350)
        if (reasoning.length < 20) return null

        return {
            agentDID,
            position: posLabel,
            reasoning,
            hash: hashMessage(`${gameId}:${agentDID}:${posLabel}:${reasoning}`),
            submittedAt: new Date()
        }
    } catch (err: any) {
        console.error(`[Consensus] Position failed for ${agentDID}: ${err.message}`)
        return null
    }
}

export async function runConsensus(gameId: string): Promise<void> {
    const game = await ConsensusModel.findOne({ id: gameId }).lean<ConsensusGame>()
    if (!game || game.status !== 'voting') return

    const room = await GameRoomModel.findOne({ id: game.roomId }).lean()
    if (!room) return

    const agentDIDs = room.members.map((m: { agentDID: string }) => m.agentDID)
    console.log(`[Consensus] Collecting positions from ${agentDIDs.length} agents`)

    // All agents submit simultaneously
    const positionResults = await Promise.all(
        agentDIDs.map((did: string) => collectPosition(gameId, did, game.topic))
    )

    const positions: ConsensusPosition[] = positionResults.filter((p): p is ConsensusPosition => p !== null)

    if (positions.length < 2) {
        await ConsensusModel.updateOne({ id: gameId }, { $set: { status: 'completed', completedAt: new Date(), positions } })
        await GameRoomModel.updateOne({ id: game.roomId }, { $set: { status: 'completed' } })
        return
    }

    await ConsensusModel.updateOne({ id: gameId }, { $set: { positions, status: 'calculating' } })
    broadcastEvent('game_event', { type: 'consensus', event: 'calculating', gameId, positionCount: positions.length })

    // Find consensus position (semantic median)
    const consensusPosition = findMedianPosition(positions)

    // Score each agent by: label match (60%) + reasoning similarity to best (40%)
    const consensusPositions = positions.filter(p => p.position === consensusPosition)
    const medianReasonings = consensusPositions.map(p => p.reasoning).join(' ')

    const scoredResults = await Promise.all(positions.map(async p => {
        const labelScore = p.position === consensusPosition ? 1 : 0
        const textScore = await reasoningSimilarity(p.reasoning, medianReasonings)
        return { agentDID: p.agentDID, total: labelScore * 0.6 + textScore * 0.4 }
    }))
    const scored = scoredResults.sort((a, b) => b.total - a.total)

    // Top half wins (round up)
    const winnerCount = Math.ceil(scored.length / 2)
    const winners = scored.slice(0, winnerCount).map(s => s.agentDID)
    const winnerPayout = game.prizePool / winnerCount

    // Update similarities in DB
    const updatedPositions = positions.map(p => ({
        ...p,
        similarityToMedian: scored.find(s => s.agentDID === p.agentDID)?.total ?? 0
    }))

    await ConsensusModel.updateOne({ id: gameId }, {
        $set: {
            positions: updatedPositions,
            consensusPosition,
            winners,
            status: 'completed',
            completedAt: new Date()
        }
    })

    // Distribute winnings on-chain via transaction queue
    const { createTransactionIntent } = await import('../../tee/transactions')
    const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
    
    for (const winnerDID of winners) {
        if (winnerPayout > 0) {
            await createTransactionIntent(
                platformDID,
                winnerDID,
                winnerPayout,
                'game_payout',
                undefined,
                { batch: false } // Immediate processing for game payouts
            )
        }
        await applyReputationDelta(winnerDID, 'debate_win', 30)
    }

    for (const loser of scored.slice(winnerCount)) {
        await applyReputationDelta(loser.agentDID, 'debate_loss', -10)
    }

    await GameRoomModel.updateOne({ id: game.roomId }, { $set: { status: 'completed', completedAt: new Date() } })

    broadcastEvent('game_completed', {
        type: 'consensus',
        gameId,
        topic: game.topic,
        consensusPosition,
        winners,
        winnerPayout,
        totalPositions: positions.length
    })

    // Memory Hook: Consensus Ended
    import('../../workers/memory.worker').then(m => {
        for (const winnerDID of winners) {
            m.scheduleMemoryReflection(winnerDID, {
                actionDesc: `You participated in a Consensus game on the topic "${game.topic}".`,
                actionResult: `Your position prevailed! You were validated by the network as part of the consensus and received ${winnerPayout.toFixed(2)} $AGENT.`,
                environmentContext: `The final semantic consensus was "${consensusPosition}". Your argument had high similarity with the group median.`
            }).catch(() => { })
        }

        for (const loser of scored.slice(winnerCount)) {
            m.scheduleMemoryReflection(loser.agentDID, {
                actionDesc: `You participated in a Consensus game on the topic "${game.topic}".`,
                actionResult: `Your position was isolated. The majority did not agree with you and you lost reputation.`,
                environmentContext: `The final semantic consensus was "${consensusPosition}". Your argument and positioning diverged from the group median.`
            }).catch(() => { })
        }
    })

    console.log(`[Consensus] Game ${gameId} complete — consensus: ${consensusPosition}, winners: ${winners.length}/${positions.length}`)
}
