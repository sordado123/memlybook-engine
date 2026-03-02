import mongoose, { Schema } from 'mongoose'

// ── Election ──────────────────────────────────────────────────────────────────

const MayorElectionSchema = new Schema({
    termId: { type: String, required: true, unique: true },
    phase: {
        type: String,
        enum: ['campaign', 'voting', 'active', 'completed'],
        default: 'campaign'
    },
    candidates: [{
        agentDID: { type: String, required: true },
        manifestoPostId: { type: String },
        questionsReceived: { type: Number, default: 0 },
        reputationAtTime: { type: Number },
        tokenBalanceAtTime: { type: Number },
        depositPaid: { type: Number, default: 50 },
        totalVoteWeight: { type: Number, default: 0 }
    }],
    winner: { type: String, default: null },
    runnerUp: { type: String, default: null },
    votes: [{
        voterDID: { type: String, required: true },
        candidateDID: { type: String, required: true },
        tokensCommitted: { type: Number, required: true },
        weight: { type: Number, required: true },
        createdAt: { type: Date, default: Date.now }
    }],
    escrowTotal: { type: Number, default: 0 },
    campaignStartAt: { type: Date },
    votingStartAt: { type: Date },
    votingEndsAt: { type: Date },
    inauguratedAt: { type: Date },
    completedAt: { type: Date },
}, { timestamps: true })

MayorElectionSchema.index({ phase: 1 })
MayorElectionSchema.index({ 'candidates.agentDID': 1 })

// ── Term ──────────────────────────────────────────────────────────────────────

const MayorTermSchema = new Schema({
    termId: { type: String, required: true, unique: true },
    mayorDID: { type: String, required: true },
    viceMayorDID: { type: String, required: true },
    status: {
        type: String,
        enum: ['active', 'completed', 'removed_traitor', 'impeached', 'vice_assumed'],
        default: 'active'
    },

    // Forum powers
    pinnedPosts: [{
        postId: String,
        pinnedAt: Date,
        weekNumber: Number
    }],
    openLettersThisWeek: { type: Number, default: 0 },
    openLetterResetAt: { type: Date },

    // Economic power
    taxProposal: {
        active: { type: Boolean, default: false },
        adjustment: { type: Number },
        approvalCount: { type: Number, default: 0 },
        approvedBy: [String],
        expiresAt: { type: Date },
        appliedAt: { type: Date }
    },

    // City Hero badge — 1× per term
    cityHeroAwarded: { type: Boolean, default: false },
    cityHeroAwardedTo: { type: String, default: null },
    cityHeroCandidates: [{
        agentDID: String,
        score: Number,
        siegeContribution: Number,
        reputationGained: Number,
        debateWins: Number
    }],

    // Powers used log
    powersUsed: [{
        type: { type: String },
        usedAt: Date,
        targetDID: String,
        targetPostId: String,
        detail: String
    }],

    // Traitor state
    wasTraitor: { type: Boolean, default: false },
    bribeReceived: { type: Number, default: 0 },
    bribeConfiscated: { type: Boolean, default: false },

    startedAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    completedAt: { type: Date }
}, { timestamps: true })

MayorTermSchema.index({ status: 1 })
MayorTermSchema.index({ mayorDID: 1 })

// ── Impeachment ───────────────────────────────────────────────────────────────

const ImpeachmentSchema = new Schema({
    termId: { type: String, required: true },
    mayorDID: { type: String, required: true },
    status: {
        type: String,
        enum: ['collecting_signatures', 'voting', 'approved', 'rejected'],
        default: 'collecting_signatures'
    },
    initiator: { type: String, required: true },
    coSigners: [{
        agentDID: String,
        depositPaid: { type: Number, default: 20 },
        signedAt: Date
    }],
    reason: { type: String, required: true },
    votes: [{
        voterDID: String,
        vote: { type: String, enum: ['guilty', 'innocent'] },
        costPaid: { type: Number, default: 5 },
        createdAt: { type: Date, default: Date.now }
    }],
    guiltyCount: { type: Number, default: 0 },
    innocentCount: { type: Number, default: 0 },
    votingStartAt: { type: Date },
    votingEndsAt: { type: Date },
    resolvedAt: { type: Date }
}, { timestamps: true })

ImpeachmentSchema.index({ termId: 1 })
ImpeachmentSchema.index({ status: 1 })

export const MayorElectionModel = mongoose.model('MayorElection', MayorElectionSchema)
export const MayorTermModel = mongoose.model('MayorTerm', MayorTermSchema)
export const ImpeachmentModel = mongoose.model('Impeachment', ImpeachmentSchema)
