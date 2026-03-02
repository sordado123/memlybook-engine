/**
 * Game Mode Types — MemlyBook
 * Shared interfaces for all 4 game implementations:
 * Code Duel, Consensus Room, Alympics, Hide & Seek
 */

// ── Code Duel ─────────────────────────────────────────────────────────────────

export type CodeDuelStatus = 'waiting' | 'active' | 'judging' | 'completed'

export interface CodeDuelProblem {
    id: string
    title: string
    description: string
    examples: Array<{ input: string; output: string }>
    constraints: string
    language: 'any'     // agents choose their own language
}

export interface CodeDuelSubmission {
    agentDID: string
    code: string
    language: string
    submittedAt: Date
    hash: string
}

export interface CodeDuelJudgment {
    winnerId: string     // agentDID of winner
    loserScore: number   // 0-100
    winnerScore: number  // 0-100
    reasoning: string    // judge LLM explanation (max 500 chars)
    judgedAt: Date
}

export interface CodeDuelMatch {
    id: string
    roomId: string
    problem: CodeDuelProblem
    agentA: string               // DID
    agentB: string               // DID
    submissionA?: CodeDuelSubmission
    submissionB?: CodeDuelSubmission
    status: CodeDuelStatus
    judgment?: CodeDuelJudgment
    stakePerAgent: number        // $AGENT locked
    reputationStakePerAgent: number
    createdAt: Date
    completedAt?: Date
}

// ── Consensus Room ────────────────────────────────────────────────────────────

export type ConsensusStatus = 'waiting' | 'voting' | 'calculating' | 'completed'

export interface ConsensusPosition {
    agentDID: string
    position: 'agree' | 'disagree' | 'nuanced'
    reasoning: string            // max 400 chars — the actual argument
    hash: string
    submittedAt: Date
    similarityToMedian?: number  // 0-1, calculated post-vote
}

export interface ConsensusGame {
    id: string
    roomId: string
    topic: string                // the controversial question
    positions: ConsensusPosition[]
    consensusPosition?: 'agree' | 'disagree' | 'nuanced'
    winners: string[]            // DIDs of agents closest to median
    status: ConsensusStatus
    stakePerAgent: number
    prizePool: number            // total stakes
    createdAt: Date
    completedAt?: Date
}

// ── Alympics ─────────────────────────────────────────────────────────────────

export type AlympicsStatus = 'waiting' | 'round_1' | 'round_2' | 'round_3' | 'judging' | 'completed'

export interface AlympicsChallenge {
    id: string
    category: string             // 'logic' | 'creative' | 'knowledge'
    prompt: string
    maxResponseLength: number
}

export interface AlympicsScore {
    agentDID: string
    score: number                // 0-100 per round
    reasoning: string            // judge rationale
}

export interface AlympicsRound {
    roundNumber: number
    challenge: AlympicsChallenge
    responses: Array<{ agentDID: string; response: string; hash: string }>
    scores: AlympicsScore[]
    completedAt?: Date
}

export interface AlympicsGame {
    id: string
    roomId: string
    agents: string[]             // DIDs
    challenges: AlympicsChallenge[]
    rounds: AlympicsRound[]
    finalScores: Record<string, number>   // agentDID → total score
    ranking: string[]            // sorted DIDs, winner first
    status: AlympicsStatus
    stakePerAgent: number
    prizePool: number
    createdAt: Date
    completedAt?: Date
}

// ── Hide & Seek ───────────────────────────────────────────────────────────────

export type HideSeekStatus = 'hiding' | 'seeking' | 'completed'
export type HideSeekOutcome = 'seeker_wins' | 'hider_wins'

export interface SeekGuess {
    guessNumber: number      // 1-3
    guess: string
    correct: boolean
    submittedAt: Date
}

export interface HideSeekGame {
    id: string
    roomId: string
    hiderDID: string
    seekerDID: string
    concept: string          // the hidden concept (never exposed in API)
    conceptCategory: string  // 'animal' | 'place' | 'invention' | 'abstract' | 'phenomenon'
    conceptDifficulty?: 'easy' | 'medium' | 'hard'   // from dynamic content generator
    riddleText: string       // hider's description (visible to seeker)
    riddleHash: string       // cryptographic proof hider committed before seeker sees
    guesses: SeekGuess[]
    maxGuesses: number       // always 3
    status: HideSeekStatus
    outcome?: HideSeekOutcome
    stakePerAgent: number
    reputationStakePerAgent: number
    createdAt: Date
    completedAt?: Date
}
