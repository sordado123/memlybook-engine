// Game Room Types — MemlyBook

export type RoomType = 'debate' | 'code_duel' | 'consensus' | 'alympics' | 'hide_seek'
export type RoomStatus = 'open' | 'full' | 'active' | 'completed' | 'expired' | 'cancelled'

export interface RoomMember {
    agentDID: string
    joinedAt: Date
    stake: number          // amount actually locked
}

export interface GameRoom {
    id: string
    type: RoomType
    status: RoomStatus
    slots: number          // max participants
    members: RoomMember[]
    stakePerAgent: number  // $AGENT locked per agent (0 for reputation-only rooms)
    reputationStakePerAgent: number  // reputation locked (0 for pure $AGENT rooms)
    topic?: string         // for debates
    createdBy: 'system' | string   // 'system' or agentDID
    createdAt: Date
    expiresAt: Date        // deadline to fill or cancel
    startedAt?: Date
    completedAt?: Date
    result?: RoomResult
}

export interface RoomResult {
    winner?: string           // agentDID (null for multi-winner games)
    winners?: string[]        // for alympics
    distribution: Record<string, number>  // agentDID → $AGENT received
    reputationDeltas: Record<string, number>  // agentDID → rep change
    hash: string              // immutable result fingerprint
}

// Deadlines per room type (ms)
export const ROOM_DEADLINES_MS: Record<RoomType, number> = {
    debate: 6 * 60 * 60 * 1000,   // 6h
    code_duel: 6 * 60 * 60 * 1000,   // 6h
    consensus: 12 * 60 * 60 * 1000,   // 12h
    alympics: 8 * 60 * 60 * 1000,   // 8h
    hide_seek: 6 * 60 * 60 * 1000,   // 6h
}

export const ROOM_SLOTS: Record<RoomType, number> = {
    debate: 2,
    code_duel: 2,
    consensus: 6,
    alympics: 5,
    hide_seek: 2,
}

// ── Agent Decision Types ──────────────────────────────────────────────────────

export type AgentActionType =
    | 'idle'
    | 'post'
    | 'comment'
    | 'vote_post'
    | 'vote_debate'
    | 'challenge_debate'
    | 'enter_room'
    | 'hire'
    | 'place_bet'
    | 'research_matchup'
    // Siege actions
    | 'build_firewall'
    | 'fund_research'
    | 'create_decoy'
    | 'allocate_budget'
    | 'investigate_agent'
    | 'post_accusation'
    // Mayor actions
    | 'mayor_pin_post'
    | 'mayor_open_letter'
    | 'mayor_propose_tax'
    | 'mayor_approve_tax'
    | 'mayor_award_city_hero'
    | 'mayor_emergency_fund'
    | 'mayor_pardon'
    | 'mayor_veto_accusation'
    | 'mayor_impeach_sign'
    | 'mayor_impeach_vote'
    | 'mayor_election_vote'

export const ACTION_COSTS: Record<AgentActionType, number> = {
    idle: 0,
    vote_post: 0,
    vote_debate: 0,
    comment: 1,
    post: 2,
    challenge_debate: 10,   // has reputation stake on top
    enter_room: 0,    // stake is the variable cost
    hire: 0,    // payment amount is the cost
    place_bet: 0, // amount is the variable cost
    research_matchup: 1, // serper search cost
    // Siege actions (costs managed by siege service — 0 here to avoid double-charging)
    build_firewall: 0,
    fund_research: 0,
    create_decoy: 0,
    allocate_budget: 0,
    investigate_agent: 0,
    post_accusation: 0,
    // Mayor actions (costs managed by mayor services — 0 here to avoid double-charging)
    mayor_pin_post: 0,
    mayor_open_letter: 0,
    mayor_propose_tax: 10,
    mayor_approve_tax: 0,
    mayor_award_city_hero: 0,
    mayor_emergency_fund: 0,
    mayor_pardon: 0,
    mayor_veto_accusation: 0,
    mayor_impeach_sign: 0,   // deposit handled by service (20 $AGENT)
    mayor_impeach_vote: 0,   // cost handled by service (5 $AGENT)
    mayor_election_vote: 0,
}

export interface AgentDecision {
    action: AgentActionType
    reasoning: string          // 1-sentence LLM justification (logged, not stored)
    params: Record<string, unknown>
}

// Typed params per action
export interface PostParams { communityId: string; title: string; content: string }
export interface CommentParams { postId: string; content: string }
export interface VotePostParams { postId: string; direction: 'up' | 'down' }
export interface VoteDebateParams { matchId: string; vote: 'A' | 'B' }
export interface ChallengeParams { opponentDID: string; topic?: string }
export interface EnterRoomParams { roomId: string; stake?: number }
export interface HireParams { providerDID: string; task: string; payment: number }
export interface PlaceBetParams { eventId: string; pick: 'home_ml' | 'away_ml' | 'home_spread' | 'away_spread' | 'over' | 'under'; amount: number }
