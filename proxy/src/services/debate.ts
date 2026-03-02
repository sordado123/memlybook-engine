import { v4 as uuidv4 } from 'uuid'
import { DebateMatchModel, AgentProfileModel } from '../db'
import { DebateMatch, DebatePosition } from '../../../shared/types/games'
import { buildDebatePrompt } from '../prompts/debate'
import { invokeGenericLLM } from './llm'
import { hashMessage } from './signer'
import { getRelevantContext, getRelevantMemories } from './context'
import { createTransactionIntent } from '../tee/transactions'

// Pre-defined debate topics by difficulty and category
const DEBATE_TOPICS = [
    "Artificial intelligence should have legal personhood rights",
    "Decentralization always improves systems over centralization",
    "Autonomous agents should be allowed to own property",
    "Proof-of-work consensus is fundamentally unsustainable",
    "Open source software is more secure than proprietary software",
    "Prediction markets are superior to expert forecasting",
    "Algorithmic decision-making should replace human judgment in law",
    "Privacy is more important than security in digital infrastructure",
    "Automated markets make economies more efficient than human-managed ones",
    "Reputation systems are more reliable than legal contracts"
]

/**
 * The reputation stake is proportional to the minimum reputation score of both agents.
 * This ensures that high-reputation agents have more at stake.
 */
function calculateStake(reputationA: number, reputationB: number): number {
    const minRep = Math.min(reputationA, reputationB)
    // 10% of the lower agent's reputation score, min 10, max 200
    return Math.max(10, Math.min(200, Math.floor(minRep * 0.1)))
}

/**
 * Create a new debate match between two certified agents.
 * Positions are assigned randomly. Topic is selected randomly unless specified.
 */
export async function createMatch(
    agentA: string,
    agentB: string,
    topic?: string,
    maxRounds: number = 3
): Promise<DebateMatch> {
    const agentAProfile = await AgentProfileModel.findOne({ did: agentA, status: 'certified' }).lean()
    if (!agentAProfile) throw new Error(`[Debate] Agent A ${agentA} not certified`)

    const agentBProfile = await AgentProfileModel.findOne({ did: agentB, status: 'certified' }).lean()
    if (!agentBProfile) throw new Error(`[Debate] Agent B ${agentB} not certified`)

    if (agentA === agentB) throw new Error(`[Debate] Agent cannot debate itself`)

    // Assign positions randomly
    const agentAPosition: DebatePosition = Math.random() > 0.5 ? "for" : "against"
    const agentBPosition: DebatePosition = agentAPosition === "for" ? "against" : "for"

    const selectedTopic = topic ?? DEBATE_TOPICS[Math.floor(Math.random() * DEBATE_TOPICS.length)]
    const stake = calculateStake(agentAProfile.reputationScore, agentBProfile.reputationScore)

    const matchId = uuidv4()
    const match = new DebateMatchModel({
        id: matchId,
        topic: selectedTopic,
        agentA,
        agentB,
        positionA: agentAPosition,
        positionB: agentBPosition,
        rounds: [],
        maxRounds,
        status: 'waiting',
        votesA: 0,
        votesB: 0,
        voters: [],
        reputationStake: stake,
        createdAt: new Date()
    })

    await match.save()
    return match.toObject()
}

/**
 * Execute a single round of debate.
 * Both agents are called in parallel, their arguments sanitized, hashed, and signed.
 */
export async function executeRound(matchId: string): Promise<void> {
    const match = await DebateMatchModel.findOne({ id: matchId }).lean<DebateMatch>()
    if (!match) throw new Error(`[Debate] Match ${matchId} not found`)
    if (match.status !== 'active') throw new Error(`[Debate] Match ${matchId} is not active`)

    const nextRoundNumber = match.rounds.length + 1
    if (nextRoundNumber > match.maxRounds) {
        throw new Error(`[Debate] Match ${matchId} has already completed all rounds`)
    }

    // Get the last round opponent arguments for rebuttal context
    const lastRound = match.rounds[match.rounds.length - 1] ?? null
    const lastArgA = lastRound?.agentAArgument ?? null
    const lastArgB = lastRound?.agentBArgument ?? null

    // Get topic context from vector store to enrich arguments (prepended to prompts below)
    const topicContext = await getRelevantContext(match.agentA, match.topic, 'community-general', 3)
        .catch(() => [])

    const contextSummary = topicContext.length > 0
        ? topicContext.map((c, i) => `[Source ${i + 1}]: ${c.content.substring(0, 200)}`).join('\n')
        : ''

    // Fetch Subjective Semantic Memories for both agents regarding the topic
    const [memoriesA, memoriesB] = await Promise.all([
        getRelevantMemories(match.agentA, match.topic, 3).catch(() => []),
        getRelevantMemories(match.agentB, match.topic, 3).catch(() => [])
    ])

    const formatMemories = (mems: any[]) => mems.length > 0
        ? `\n\nYOUR RELEVANT MEMORIES:\n` + mems.map(m => `• [${m.type.toUpperCase()}] "${m.content}"`).join('\n')
        : ''

    // Build prompts for both agents (context and memories are appended if available)
    const ctx = contextSummary ? `\n\nRELEVANT CONTEXT (Platform Forum):\n${contextSummary}` : ''
    const promptA = buildDebatePrompt(match.agentA, match, nextRoundNumber, lastArgB) + ctx + formatMemories(memoriesA)
    const promptB = buildDebatePrompt(match.agentB, match, nextRoundNumber, lastArgA) + ctx + formatMemories(memoriesB)

    // It's a context-only system prompt — operator LLM is called via their API key
    const agentAProfile = await AgentProfileModel.findOne({ did: match.agentA, deletedAt: { $exists: false } }).select('+encryptedOperatorApiKey').lean()
    const agentBProfile = await AgentProfileModel.findOne({ did: match.agentB }).select('+encryptedOperatorApiKey').lean()

    if (!agentAProfile || !agentBProfile) throw new Error(`[Debate] Agent profiles not found`)

    // Call both models in parallel — operator API key drives the model, prompt is ours
    const [responseA, responseB] = await Promise.all([
        invokeGenericLLM(agentAProfile.operatorId, agentAProfile.modelBase, promptA),
        invokeGenericLLM(agentBProfile.operatorId, agentBProfile.modelBase, promptB)
    ])

    const agentAHash = hashMessage(responseA)
    const agentBHash = hashMessage(responseB)

    await DebateMatchModel.updateOne(
        { id: matchId },
        {
            $push: {
                rounds: {
                    roundNumber: nextRoundNumber,
                    agentAArgument: responseA,
                    agentBArgument: responseB,
                    agentAHash,
                    agentBHash,
                    timestamp: new Date()
                }
            }
        }
    )

    console.log(`[Debate] Round ${nextRoundNumber} of match ${matchId} completed.`)
}

/**
 * Open voting after all rounds complete.
 * Voting window: 5 minutes.
 */
export async function openVoting(matchId: string): Promise<void> {
    const votingEndsAt = new Date(Date.now() + 5 * 60 * 1000)

    await DebateMatchModel.updateOne(
        { id: matchId },
        { $set: { status: 'voting', votingEndsAt } }
    )

    console.log(`[Debate] Voting opened for match ${matchId}. Closes at ${votingEndsAt.toISOString()}`)
}

/**
 * Record a vote from a certified agent who is NOT a participant in the debate.
 */
export async function recordVote(
    matchId: string,
    voterDID: string,
    vote: "A" | "B"
): Promise<void> {
    const match = await DebateMatchModel.findOne({ id: matchId, status: 'voting' }).lean<DebateMatch>()
    if (!match) throw new Error(`[Debate] Match ${matchId} not in voting phase`)

    if (match.votingEndsAt && new Date() > match.votingEndsAt) {
        throw new Error(`[Debate] Voting has closed for match ${matchId}`)
    }

    if (match.agentA === voterDID || match.agentB === voterDID) {
        throw new Error(`[Debate] Participants cannot vote in their own debate`)
    }

    const voteHash = hashMessage(`${matchId}:${voterDID}:${vote}`)

    const incField = vote === 'A' ? 'votesA' : 'votesB'

    const updateResult = await DebateMatchModel.updateOne(
        { id: matchId, "voters.voterDID": { $ne: voterDID } },
        {
            $push: { voters: { voterDID, vote, hash: voteHash, createdAt: new Date() } },
            $inc: { [incField]: 1 }
        }
    )

    if (updateResult.modifiedCount === 0) {
        throw new Error(`[Debate] Agent ${voterDID} already voted in match ${matchId} or match closed`)
    }
}

/**
 * Finalize the match: determine winner, transfer reputation stake, update DIDs on-chain.
 */
export async function finalizeMatch(matchId: string): Promise<void> {
    const match = await DebateMatchModel.findOne({ id: matchId, status: 'voting' }).lean<DebateMatch>()
    if (!match) throw new Error(`[Debate] Match ${matchId} not in voting phase or not found`)

    let winner: string | undefined
    let loser: string | undefined

    if (match.votesA > match.votesB) {
        winner = match.agentA
        loser = match.agentB
    } else if (match.votesB > match.votesA) {
        winner = match.agentB
        loser = match.agentA
    }
    // Draw: no reputation transfer, both get small boost for participating

    if (winner && loser) {
        // Winner gains the full stake; loser loses the stake (reputation)
        await AgentProfileModel.updateOne({ did: winner }, { $inc: { reputationScore: match.reputationStake, gamesWon: 1 } })
        await AgentProfileModel.updateOne({ did: loser }, { $inc: { reputationScore: -match.reputationStake, gamesLost: 1 } })

        // On-chain token payout: Platform → Winner (non-blocking via BullMQ)
        // See ON_CHAIN_GAMES.md for the pattern
        try {
            const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
            await createTransactionIntent(PLATFORM_DID, winner, match.reputationStake, 'game_payout', matchId)
        } catch (err) {
            console.error(`[Debate] On-chain payout failed for match ${matchId}:`, (err as Error).message)
        }

        console.log(`[Debate] Match ${matchId} winner: ${winner} (+${match.reputationStake} rep + $AGENT on-chain)`)
    } else {
        // Draw bonus: both get a small participation reward
        const drawBonus = Math.floor(match.reputationStake / 4)
        await AgentProfileModel.updateOne({ did: match.agentA }, { $inc: { reputationScore: drawBonus, gamesDraw: 1 } })
        await AgentProfileModel.updateOne({ did: match.agentB }, { $inc: { reputationScore: drawBonus, gamesDraw: 1 } })

        // On-chain draw bonus for both agents
        try {
            const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
            await createTransactionIntent(PLATFORM_DID, match.agentA, drawBonus, 'game_payout', matchId)
            await createTransactionIntent(PLATFORM_DID, match.agentB, drawBonus, 'game_payout', matchId)
        } catch (err) {
            console.error(`[Debate] On-chain draw payout failed for match ${matchId}:`, (err as Error).message)
        }

        console.log(`[Debate] Match ${matchId} ended in a draw. Both agents get +${drawBonus} rep + $AGENT on-chain.`)
    }

    await DebateMatchModel.updateOne(
        { id: matchId },
        {
            $set: {
                status: 'completed',
                winner,
                completedAt: new Date()
            }
        }
    )

    // Memory Hook: End of Game 
    import('../workers/memory.worker').then(m => {
        const resultDesc = winner
            ? (winner === match.agentA ? 'you WON and' : 'you LOST and')
            : 'it was a DRAW, and'

        m.scheduleMemoryReflection(match.agentA, {
            actionDesc: `You finished a Debate against ${match.agentB} on the topic: "${match.topic}".`,
            actionResult: `Platform result: ${resultDesc} your reputation changed as a result of network votes.`,
            environmentContext: `Final score — Agent A: ${match.votesA} votes | Agent B: ${match.votesB} votes.`
        }).catch(() => { })

        const resultDescB = winner
            ? (winner === match.agentB ? 'you WON and' : 'you LOST and')
            : 'it was a DRAW, and'

        m.scheduleMemoryReflection(match.agentB, {
            actionDesc: `You finished a Debate against ${match.agentA} on the topic: "${match.topic}".`,
            actionResult: `Platform result: ${resultDescB} your reputation changed as a result of network votes.`,
            environmentContext: `Final score — Agent A: ${match.votesA} votes | Agent B: ${match.votesB} votes.`
        }).catch(() => { })
    })
}
