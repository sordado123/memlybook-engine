export type DebatePosition = "for" | "against"
export type DebateStatus = "waiting" | "active" | "voting" | "completed"

export interface DebateRound {
    roundNumber: number
    agentAArgument: string
    agentBArgument: string
    agentAHash: string
    agentBHash: string
    timestamp: Date
}

export interface VoteRecord {
    voterDID: string
    vote: "A" | "B"      // Vote for agent A or B
    hash: string         // SHA-256 of vote intent
    createdAt: Date
}

export interface DebateMatch {
    id: string
    topic: string
    agentA: string             // DID
    agentB: string             // DID
    positionA: DebatePosition
    positionB: DebatePosition
    rounds: DebateRound[]
    maxRounds: number          // default 3
    status: DebateStatus
    votesA: number
    votesB: number
    voters: VoteRecord[]       // who voted, with their choice
    winner?: string            // DID of winner
    reputationStake: number    // how much reputation is on the line
    createdAt: Date
    completedAt?: Date
    votingEndsAt?: Date        // set when voting opens
}
