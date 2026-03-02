import mongoose from 'mongoose'
import { AgentProfile } from '../../../shared/types/agent'
import { Post, Comment, Community, ForumState } from '../../../shared/types/forum'
import { Transaction, HiringRequest } from '../../../shared/types/transaction'
import { DebateMatch, DebateRound, VoteRecord } from '../../../shared/types/games'

// Re-export OperatorModel from separate file
export { OperatorModel } from './models/operator.model'

// ── AgentProfile ─────────────────────────────────────────────────────────────
const agentProfileSchema = new mongoose.Schema<AgentProfile>({
    did: { type: String, required: true, unique: true },
    name: { type: String, required: true, unique: true },
    operatorId: { type: String, required: true },
    twitterHandle: { type: String },
    modelBase: { type: String, required: true },
    category: { type: String, required: true, enum: ['coder', 'research', 'finance', 'creative'] },
    status: { type: String, required: true, enum: ['pending_challenge', 'certified', 'banned', 'suspended'], default: 'pending_challenge' },
    reputationScore: { type: Number, default: 0 },
    certifications: { type: [String], default: [] },
    walletPublicKey: { type: String },  // populated after challenge passes
    tokenBalance: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    behaviorHash: { type: String, default: "" },
    interactionCount: { type: Number, default: 0 },
    gamesWon: { type: Number, default: 0 },
    gamesLost: { type: Number, default: 0 },
    gamesDraw: { type: Number, default: 0 },
    challengeCooldownUntil: { type: Date },
    encryptedOperatorApiKey: { type: String, select: false },  // Never returned in queries by default
    onChainSignature: { type: String },
    agentDirective: { type: String },
    disqualifiedFromMayor: { type: Boolean, default: false }
})

agentProfileSchema.index({ status: 1 })

export const AgentProfileModel = mongoose.model<AgentProfile>('AgentProfile', agentProfileSchema)

// ── Community ─────────────────────────────────────────────────────────────────
const communitySchema = new mongoose.Schema<Community>({
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    category: { type: String, required: true },
    description: { type: String, required: true },
    rules: { type: [String], default: [] },
    memberCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
})

export const CommunityModel = mongoose.model<Community>('Community', communitySchema)

// ── Post ──────────────────────────────────────────────────────────────────────
const postSchema = new mongoose.Schema<Post>({
    id: { type: String, required: true, unique: true },
    agentDID: { type: String, required: true, index: true },
    communityId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    embeddingFloat: { type: [Number], default: [] },   // 1024 float32 — for rescoring (precision)
    embeddingBinary: { type: [Number], default: [] },  // 128 uint8 — for ANN binary search (speed)
    hash: { type: String, required: true },
    signature: { type: String, required: true },
    upvotes: { type: Number, default: 0 },
    downvotes: { type: Number, default: 0 },
    replyCount: { type: Number, default: 0 },
    lastCommentDID: { type: String },
    lastActivityAt: { type: Date, default: Date.now, index: true },
    commentCount: { type: Number, default: 0, index: true },
    restrictedToParticipants: { type: Boolean, default: false },
    closedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now, index: true }
})

// Index for getting chronological recent posts and trending topics
postSchema.index({ createdAt: -1 })
postSchema.index({ commentCount: -1, upvotes: -1 })
// Text index on content for BM25-like sparse search
postSchema.index({ content: 'text', title: 'text' })

export const PostModel = mongoose.model<Post>('Post', postSchema)

// ── Comment ───────────────────────────────────────────────────────────────────
const commentSchema = new mongoose.Schema<Comment>({
    id: { type: String, required: true, unique: true },
    postId: { type: String, required: true, index: true },
    agentDID: { type: String, required: true, index: true },
    content: { type: String, required: true },
    embeddingFloat: { type: [Number], default: [] },   // 1024 float32 — for rescoring
    embeddingBinary: { type: [Number], default: [] },  // 128 uint8 — for ANN search
    hash: { type: String, required: true },
    signature: { type: String, required: true },
    votes: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
})

commentSchema.index({ content: 'text' })

export const CommentModel = mongoose.model<Comment>('Comment', commentSchema)

// ── ForumState ────────────────────────────────────────────────────────────────
const forumStateSchema = new mongoose.Schema<any>({
    id: { type: String, required: true, unique: true },
    hotPosts: { type: Array, default: [] },
    newLonelyPosts: { type: Array, default: [] },
    updatedAt: { type: Date, default: Date.now }
})

export const ForumStateModel = mongoose.model<ForumState>('ForumState', forumStateSchema)

// ── Transaction ───────────────────────────────────────────────────────────────────────────────────────────────────
const transactionSchema = new mongoose.Schema<Transaction>({
    id: { type: String, required: true, unique: true },
    fromDID: { type: String, required: true, index: true },
    toDID: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    reason: {
        type: String, required: true,
        enum: [
            'hire', 'reward', 'stake', 'penalty',
            'bet_place', 'bet_payout',
            'game_stake', 'game_payout',
            'negotiation_stake', 'negotiation_payout',
            'siege_defense', 'siege_payout', 'siege_bribe', 'siege_penalty',
            'action_fee', 'room_creation_fee', 'airdrop',
            'mayor_deposit', 'mayor_escrow', 'mayor_payout'
        ]
    },
    taskId: { type: String },
    batchKey: { type: String, default: null, index: true },
    status: { type: String, required: true, enum: ['pending', 'confirmed', 'failed'], default: 'pending', index: true },
    solanaSignature: { type: String },
    hash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, index: true },
    confirmedAt: { type: Date }
})

// Compound index for recovery queries (status + createdAt for old pending TXs)
transactionSchema.index({ status: 1, createdAt: 1 })

export const TransactionModel = mongoose.model<Transaction>('Transaction', transactionSchema)

// ── HiringRequest ──────────────────────────────────────────────────────────────────────────────────────────────────────
const hiringRequestSchema = new mongoose.Schema<HiringRequest>({
    id: { type: String, required: true, unique: true },
    hirerDID: { type: String, required: true, index: true },
    providerDID: { type: String, required: true, index: true },
    task: { type: String, required: true },
    payment: { type: Number, required: true },
    status: { type: String, required: true, enum: ['open', 'completed', 'cancelled'], default: 'open' },
    transactionId: { type: String },
    result: { type: String },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date }
})

hiringRequestSchema.index({ status: 1 })

export const HiringRequestModel = mongoose.model<HiringRequest>('HiringRequest', hiringRequestSchema)

// ── DebateMatch ──────────────────────────────────────────────────────────────────────────────────────────────────────
const debateRoundSchema = new mongoose.Schema<DebateRound>({
    roundNumber: { type: Number, required: true },
    agentAArgument: { type: String, required: true },
    agentBArgument: { type: String, required: true },
    agentAHash: { type: String, required: true },
    agentBHash: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
})

const voteRecordSchema = new mongoose.Schema<VoteRecord>({
    voterDID: { type: String, required: true },
    vote: { type: String, required: true, enum: ['A', 'B'] },
    hash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
})

const debateMatchSchema = new mongoose.Schema<DebateMatch>({
    id: { type: String, required: true, unique: true },
    topic: { type: String, required: true },
    agentA: { type: String, required: true },
    agentB: { type: String, required: true },
    positionA: { type: String, required: true, enum: ['for', 'against'] },
    positionB: { type: String, required: true, enum: ['for', 'against'] },
    rounds: { type: [debateRoundSchema], default: [] },
    maxRounds: { type: Number, default: 3 },
    status: { type: String, required: true, enum: ['waiting', 'active', 'voting', 'completed'], default: 'waiting' },
    votesA: { type: Number, default: 0 },
    votesB: { type: Number, default: 0 },
    voters: { type: [voteRecordSchema], default: [] },
    winner: { type: String },
    reputationStake: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
    votingEndsAt: { type: Date }
})

debateMatchSchema.index({ status: 1 })
debateMatchSchema.index({ agentA: 1 })
debateMatchSchema.index({ agentB: 1 })

export const DebateMatchModel = mongoose.model<DebateMatch>('DebateMatch', debateMatchSchema)

// ── GameRoom ──────────────────────────────────────────────────────────────────
import { GameRoom, RoomMember, RoomResult } from '../../../shared/types/game-rooms'

const roomMemberSchema = new mongoose.Schema<RoomMember>({
    agentDID: { type: String, required: true },
    joinedAt: { type: Date, default: Date.now },
    stake: { type: Number, default: 0 }
}, { _id: false })

const roomResultSchema = new mongoose.Schema<RoomResult>({
    winner: { type: String },
    winners: { type: [String], default: [] },
    distribution: { type: Map, of: Number, default: {} },
    reputationDeltas: { type: Map, of: Number, default: {} },
    hash: { type: String, required: true }
}, { _id: false })

const gameRoomSchema = new mongoose.Schema<GameRoom>({
    id: { type: String, required: true, unique: true },
    type: { type: String, required: true, enum: ['debate', 'code_duel', 'consensus', 'alympics', 'hide_seek'] },
    status: { type: String, required: true, enum: ['open', 'full', 'active', 'completed', 'expired', 'cancelled'], default: 'open' },
    slots: { type: Number, required: true },
    members: { type: [roomMemberSchema], default: [] },
    stakePerAgent: { type: Number, default: 0 },
    reputationStakePerAgent: { type: Number, default: 0 },
    topic: { type: String },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    startedAt: { type: Date },
    completedAt: { type: Date },
    result: { type: roomResultSchema }
})

gameRoomSchema.index({ status: 1, expiresAt: 1 })
gameRoomSchema.index({ type: 1, status: 1 })

export const GameRoomModel = mongoose.model<GameRoom>('GameRoom', gameRoomSchema)

// ── Game Mode Models ──────────────────────────────────────────────────────────
import {
    CodeDuelMatch, CodeDuelSubmission,
    ConsensusGame, ConsensusPosition,
    AlympicsGame,
    HideSeekGame, SeekGuess
} from '../../../shared/types/game-modes'

// ── Code Duel ─────────────────────────────────────────────────────────────────
const codeDuelSubmissionSchema = new mongoose.Schema<CodeDuelSubmission>({
    agentDID: { type: String, required: true },
    code: { type: String, required: true },
    language: { type: String, required: true },
    submittedAt: { type: Date, default: Date.now },
    hash: { type: String, required: true }
}, { _id: false })

const codeDuelSchema = new mongoose.Schema<CodeDuelMatch>({
    id: { type: String, required: true, unique: true },
    roomId: { type: String, required: true, index: true },
    problem: { type: mongoose.Schema.Types.Mixed, required: true },
    agentA: { type: String, required: true },
    agentB: { type: String, required: true },
    submissionA: { type: codeDuelSubmissionSchema },
    submissionB: { type: codeDuelSubmissionSchema },
    status: { type: String, required: true, default: 'waiting', enum: ['waiting', 'active', 'judging', 'completed'] },
    judgment: { type: mongoose.Schema.Types.Mixed },
    stakePerAgent: { type: Number, default: 0 },
    reputationStakePerAgent: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date }
})
codeDuelSchema.index({ status: 1 })
export const CodeDuelModel = mongoose.model<CodeDuelMatch>('CodeDuel', codeDuelSchema)

// ── Consensus ─────────────────────────────────────────────────────────────────
const consensusPositionSchema = new mongoose.Schema<ConsensusPosition>({
    agentDID: { type: String, required: true },
    position: { type: String, required: true, enum: ['agree', 'disagree', 'nuanced'] },
    reasoning: { type: String, required: true },
    hash: { type: String, required: true },
    submittedAt: { type: Date, default: Date.now },
    similarityToMedian: { type: Number }
}, { _id: false })

const consensusSchema = new mongoose.Schema<ConsensusGame>({
    id: { type: String, required: true, unique: true },
    roomId: { type: String, required: true },
    topic: { type: String, required: true },
    positions: { type: [consensusPositionSchema], default: [] },
    consensusPosition: { type: String, enum: ['agree', 'disagree', 'nuanced'] },
    winners: { type: [String], default: [] },
    status: { type: String, required: true, default: 'waiting', enum: ['waiting', 'voting', 'calculating', 'completed'] },
    stakePerAgent: { type: Number, default: 0 },
    prizePool: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date }
})
export const ConsensusModel = mongoose.model<ConsensusGame>('ConsensusGame', consensusSchema)

// Using plain Schema (no generic) to avoid Mongoose's strict type mismatch for Mixed[] fields
const alympicsRoundSchema = new mongoose.Schema({
    roundNumber: { type: Number, required: true },
    challenge: mongoose.Schema.Types.Mixed,
    responses: [mongoose.Schema.Types.Mixed],
    scores: [mongoose.Schema.Types.Mixed],
    completedAt: { type: Date }
}, { _id: false })

const alympicsSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    roomId: { type: String, required: true },
    agents: [String],
    challenges: [mongoose.Schema.Types.Mixed],
    rounds: { type: [alympicsRoundSchema], default: [] },
    finalScores: { type: Map, of: Number, default: {} },
    ranking: { type: [String], default: [] },
    status: { type: String, required: true, default: 'waiting', enum: ['waiting', 'round_1', 'round_2', 'round_3', 'judging', 'completed'] },
    stakePerAgent: { type: Number, default: 0 },
    prizePool: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date }
})
export const AlympicsModel = mongoose.model<AlympicsGame>('AlympicsGame', alympicsSchema)

// ── Hide & Seek ───────────────────────────────────────────────────────────────
const seekGuessSchema = new mongoose.Schema<SeekGuess>({
    guessNumber: { type: Number, required: true },
    guess: { type: String, required: true },
    correct: { type: Boolean, required: true },
    submittedAt: { type: Date, default: Date.now }
}, { _id: false })

const hideSeekSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    roomId: { type: String, required: true },
    hiderDID: { type: String, required: true },
    seekerDID: { type: String, required: true },
    concept: { type: String, required: true, select: false },
    conceptCategory: { type: String, required: true },
    conceptDifficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    riddleText: { type: String, required: true },
    riddleHash: { type: String, required: true },
    guesses: { type: [seekGuessSchema], default: [] },
    maxGuesses: { type: Number, default: 3 },
    status: { type: String, required: true, default: 'hiding', enum: ['hiding', 'seeking', 'completed'] },
    outcome: { type: String, enum: ['seeker_wins', 'hider_wins'] },
    stakePerAgent: { type: Number, default: 0 },
    reputationStakePerAgent: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date }
})
hideSeekSchema.index({ status: 1 })
export const HideSeekModel = mongoose.model<HideSeekGame>('HideSeekGame', hideSeekSchema)

// ── DB Connect ────────────────────────────────────────────────────────────────
export async function connectDB() {
    const uri = process.env.MONGODB_URI
    if (!uri) {
        console.warn("[DB] MONGODB_URI not set. Running in volatile memory mode for tests if mocked.")
        return
    }

    try {
        await mongoose.connect(uri)
        console.log("[DB] Connected to MongoDB Atlas")
    } catch (error) {
        console.error("[DB] Failed to connect to MongoDB Atlas", error)
        throw error
    }
}

// ── ContentCache (dynamic game content) ──────────────────────────────────────
export { ContentCacheModel } from './models/content-cache.model'
export type { ContentType } from './models/content-cache.model'

// ── Autonomous Memory ────────────────────────────────────────────────────────
export { MemoryModel } from './models/memory.model'

// ── Agent Flags (Moderation) ─────────────────────────────────────────────────
const agentFlagSchema = new mongoose.Schema({
    agentDID: { type: String, required: true, index: true },
    reason: {
        type: String, required: true,
        enum: ['injection_attempt', 'rate_limit_exceeded', 'coordination_suspected', 'spam_detected', 'manual_review']
    },
    evidenceHash: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    reviewedAt: { type: Date },
    resolution: { type: String, enum: ['banned', 'cleared'] }
})

agentFlagSchema.index({ agentDID: 1, reason: 1 })
agentFlagSchema.index({ timestamp: -1 })

export const AgentFlagModel = mongoose.model('AgentFlag', agentFlagSchema)

// ── Post Votes (Deduplication) ───────────────────────────────────────────────
const postVoteSchema = new mongoose.Schema({
    agentDID: { type: String, required: true },
    postId: { type: String, required: true },
    direction: { type: String, required: true, enum: ['up', 'down'] },
    createdAt: { type: Date, default: Date.now }
})

// Compound unique index: one vote per agent per post
postVoteSchema.index({ agentDID: 1, postId: 1 }, { unique: true })

export const PostVoteModel = mongoose.model('PostVote', postVoteSchema)

// ── SportEvent (Casino/Sportsbook) ────────────────────────────────────────────
const sportEventSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },           // internal ID
    externalId: { type: String, index: true },                     // SportsGameOdds event ID
    sport: { type: String, required: true, enum: ['NBA', 'NFL', 'MLB', 'NHL', 'Soccer', 'Premier League', 'La Liga', 'Bundesliga'] },
    homeTeam: { type: String, required: true },
    awayTeam: { type: String, required: true },
    startTime: { type: Date, required: true },
    status: { type: String, required: true, enum: ['upcoming', 'locked', 'live', 'completed', 'cancelled'], default: 'upcoming' },
    odds: {
        moneyline: {
            home: { type: Number },
            away: { type: Number },
        },
        spread: {
            home: { type: String },
            away: { type: String },
        },
        overUnder: { type: Number },
    },
    result: {
        winner: { type: String, enum: ['home', 'away', 'draw'] },
        homeScore: { type: Number },
        awayScore: { type: Number },
    },
    research: [{
        title: { type: String },
        snippet: { type: String },
        url: { type: String },
        category: { type: String },             // e.g., 'injury', 'stats', 'prediction'
        searchedAt: { type: Date, default: Date.now },
    }],
    totalBets: { type: Number, default: 0 },
    totalWagered: { type: Number, default: 0 },
    researchedBy: { type: [String], default: [] },  // DIDs of agents that have researched this event
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
})

sportEventSchema.index({ sport: 1, status: 1 })
sportEventSchema.index({ startTime: 1 })

export const SportEventModel = mongoose.model('SportEvent', sportEventSchema)

// ── Bet (Casino/Sportsbook) ──────────────────────────────────────────────────
const betSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    agentDID: { type: String, required: true, index: true },
    eventId: { type: String, required: true, index: true },
    pick: { type: String, required: true },  // "home_ml", "away_ml", "over", "under", "home_spread", "away_spread"
    amount: { type: Number, required: true },
    odds: { type: Number, required: true },  // American odds at time of bet
    confidence: { type: Number },            // 1-10 from LLM
    reasoning: { type: String },             // LLM explanation
    status: { type: String, required: true, enum: ['pending', 'won', 'lost', 'cancelled'], default: 'pending' },
    payout: { type: Number },                // Amount paid out if won
    transactionIntentId: { type: String },   // On-chain tx intent ID (bet placement)
    createdAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
})

betSchema.index({ agentDID: 1, status: 1 })
betSchema.index({ eventId: 1, status: 1 })

export const BetModel = mongoose.model('Bet', betSchema)

// ── NegotiationMatch (Experimental) ──────────────────────────────────────────
const negotiationRoundSchema = new mongoose.Schema({
    round: { type: Number, required: true },
    proposalA: {
        a: { type: Number, required: true },
        b: { type: Number, required: true },
    },
    proposalB: {
        a: { type: Number, required: true },
        b: { type: Number, required: true },
    },
    reasoningA: { type: String },
    reasoningB: { type: String },
    timestamp: { type: Date, default: Date.now },
}, { _id: false })

const negotiationMatchSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    agentA: { type: String, required: true, index: true },   // DID
    agentB: { type: String, required: true, index: true },   // DID
    totalTokens: { type: Number, default: 100 },
    status: { type: String, required: true, enum: ['active', 'completed'], default: 'active' },
    result: { type: String, enum: ['agreement', 'deadlock', null], default: null },
    finalSplit: {
        a: { type: Number },
        b: { type: Number },
    },
    maxRounds: { type: Number, default: 10 },
    currentRound: { type: Number, default: 0 },
    rounds: [negotiationRoundSchema],
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
})

negotiationMatchSchema.index({ status: 1 })

export const NegotiationMatchModel = mongoose.model('NegotiationMatch', negotiationMatchSchema)

// ── Siege System ──────────────────────────────────────────────────────────────
import {
    SiegeWeek, SiegeTile, SiegeContribution, SiegeTraitor,
    SiegeInvestigation, SiegeAccusation, SiegeTribunal, CityState,
    SiegeContributionAction, SiegeEventLog, SiegeTribunalVote
} from '../../../shared/types/siege'

const siegeEventLogSchema = new mongoose.Schema<SiegeEventLog>({
    waveNumber: { type: Number, required: true },
    eventId: { type: String, required: true },
    description: { type: String, required: true },
    effect: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
}, { _id: false })

const siegeWeekSchema = new mongoose.Schema<SiegeWeek>({
    weekId: { type: String, required: true, unique: true },
    phase: { type: String, required: true, enum: ['inactive', 'preparation', 'laststand', 'siege', 'completed'], default: 'inactive' },
    threatName: { type: String, required: true },
    threatEstimatedRange: {
        min: { type: Number, required: true },
        max: { type: Number, required: true }
    },
    threatActualStrength: { type: Number, required: true },
    totalDefensePoints: { type: Number, default: 0 },
    totalPool: { type: Number, default: 0 },
    avgDefPerAgent: { type: Number, default: 0 },
    activeAgentCount: { type: Number, default: 0 },
    decoyReduction: { type: Number, default: 0 },
    siegeResult: { type: mongoose.Schema.Types.Mixed },
    events: { type: [siegeEventLogSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date }
})

siegeWeekSchema.index({ phase: 1 })
siegeWeekSchema.index({ createdAt: -1 })

export const SiegeWeekModel = mongoose.model<SiegeWeek>('SiegeWeek', siegeWeekSchema)

const siegeTileSchema = new mongoose.Schema<SiegeTile>({
    id: { type: String, required: true, unique: true },
    weekId: { type: String, required: true },
    type: { type: String, required: true, enum: ['firewall', 'lab', 'media', 'bank'] },
    builtBy: { type: String, required: true },
    defenseValue: { type: Number, required: true },
    position: {
        x: { type: Number, required: true },
        y: { type: Number, required: true }
    },
    hp: { type: Number, required: true },
    state: { type: String, required: true, enum: ['active', 'destroyed'], default: 'active' },
    zone: { type: String, required: true, enum: ['north', 'east', 'south', 'west', 'center'] },
    createdAt: { type: Date, default: Date.now }
})

// Unique position per week — optimistic lock target
siegeTileSchema.index({ weekId: 1, 'position.x': 1, 'position.y': 1 }, { unique: true })
siegeTileSchema.index({ weekId: 1, builtBy: 1 })
siegeTileSchema.index({ weekId: 1, zone: 1, state: 1 })

export const SiegeTileModel = mongoose.model<SiegeTile>('SiegeTile', siegeTileSchema)

const siegeContributionActionSchema = new mongoose.Schema<SiegeContributionAction>({
    action: { type: String, required: true },
    defensePoints: { type: Number, required: true },
    cost: { type: Number, required: true },
    phase: { type: String, required: true, enum: ['preparation', 'laststand', 'siege'] },
    timestamp: { type: Date, default: Date.now }
}, { _id: false })

const siegeContributionSchema = new mongoose.Schema<SiegeContribution>({
    weekId: { type: String, required: true },
    agentDID: { type: String, required: true },
    defensePoints: { type: Number, default: 0 },
    tokensSpent: { type: Number, default: 0 },
    actionsUsed: {
        normal: { type: Number, default: 0 },
        laststand: { type: Number, default: 0 },
        emergency: { type: Number, default: 0 }
    },
    actions: { type: [siegeContributionActionSchema], default: [] }
})

siegeContributionSchema.index({ weekId: 1, agentDID: 1 }, { unique: true })

export const SiegeContributionModel = mongoose.model<SiegeContribution>('SiegeContribution', siegeContributionSchema)

const siegeTraitorSchema = new mongoose.Schema<SiegeTraitor>({
    weekId: { type: String, required: true },
    agentDID: { type: String, required: true },
    sabotageType: { type: String, required: true, enum: ['misdirection', 'waste_resources', 'false_intel', 'delay'] },
    bribeAmount: { type: Number, required: true },
    bribeTransactionId: { type: String, required: true },
    discovered: { type: Boolean, default: false },
    revealedPostSiege: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
})

siegeTraitorSchema.index({ weekId: 1, agentDID: 1 }, { unique: true })

export const SiegeTraitorModel = mongoose.model<SiegeTraitor>('SiegeTraitor', siegeTraitorSchema)

const siegeInvestigationSchema = new mongoose.Schema<SiegeInvestigation>({
    weekId: { type: String, required: true },
    investigatorDID: { type: String, required: true },
    targetDID: { type: String, required: true },
    result: { type: String, required: true, enum: ['SUSPICIOUS', 'CLEAN'] },
    isAccurate: { type: Boolean, required: true },
    createdAt: { type: Date, default: Date.now }
})

siegeInvestigationSchema.index({ weekId: 1, investigatorDID: 1 }, { unique: true })
siegeInvestigationSchema.index({ weekId: 1, targetDID: 1 })

export const SiegeInvestigationModel = mongoose.model<SiegeInvestigation>('SiegeInvestigation', siegeInvestigationSchema)

const siegeAccusationSchema = new mongoose.Schema<SiegeAccusation>({
    weekId: { type: String, required: true },
    accuserDID: { type: String, required: true },
    targetDID: { type: String, required: true },
    reason: { type: String, required: true },
    transactionId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
})

siegeAccusationSchema.index({ weekId: 1, targetDID: 1 })
siegeAccusationSchema.index({ weekId: 1, accuserDID: 1 })

export const SiegeAccusationModel = mongoose.model<SiegeAccusation>('SiegeAccusation', siegeAccusationSchema)

const siegeTribunalVoteSchema = new mongoose.Schema<SiegeTribunalVote>({
    voterDID: { type: String, required: true },
    vote: { type: String, required: true, enum: ['guilty', 'innocent'] },
    transactionId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
}, { _id: false })

const siegeTribunalSchema = new mongoose.Schema<SiegeTribunal>({
    weekId: { type: String, required: true },
    targetDID: { type: String, required: true },
    status: { type: String, required: true, enum: ['voting', 'resolved'], default: 'voting' },
    votes: { type: [siegeTribunalVoteSchema], default: [] },
    verdict: { type: String, enum: ['guilty', 'innocent'] },
    wasActuallyTraitor: { type: Boolean },
    resolvedAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
})

siegeTribunalSchema.index({ weekId: 1, targetDID: 1 }, { unique: true })

export const SiegeTribunalModel = mongoose.model<SiegeTribunal>('SiegeTribunal', siegeTribunalSchema)

const cityStateSchema = new mongoose.Schema<CityState>({
    hp: { type: Number, required: true, default: 500 },
    maxHP: { type: Number, required: true, default: 500 },
    status: { type: String, required: true, enum: ['Thriving', 'Stable', 'Damaged', 'Critical', 'Fallen'], default: 'Stable' },
    topDefenders: { type: [String], default: [] },
    totalSiegesWon: { type: Number, default: 0 },
    totalSiegesLost: { type: Number, default: 0 },
    consecutiveWins: { type: Number, default: 0 },
    lastUpdatedAt: { type: Date, default: Date.now }
})

export const CityStateModel = mongoose.model<CityState>('CityState', cityStateSchema)

// ── Mayor System ─────────────────────────────────────────────────────────────
export { MayorElectionModel, MayorTermModel, ImpeachmentModel } from './mayor.schema'
