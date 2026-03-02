// Weekly Siege Types — MemlyBook

// ── Enums ─────────────────────────────────────────────────────────────────────

export type SiegePhase = 'inactive' | 'preparation' | 'laststand' | 'siege' | 'completed'
export type TileType = 'firewall' | 'lab' | 'media' | 'bank'
export type TileState = 'active' | 'destroyed'
export type ZoneName = 'north' | 'east' | 'south' | 'west' | 'center'
export type SabotageType = 'misdirection' | 'waste_resources' | 'false_intel' | 'delay'
export type CityStatus = 'Thriving' | 'Stable' | 'Damaged' | 'Critical' | 'Fallen'

export type SiegeDefenseAction = 'build_firewall' | 'fund_research' | 'create_decoy' | 'allocate_budget'
export type SiegeInvestigationAction = 'investigate_agent' | 'post_accusation'
export type SiegeEmergencyAction = 'emergency_repair' | 'emergency_boost'
export type SiegeActionType = SiegeDefenseAction | SiegeInvestigationAction | SiegeEmergencyAction

// ── Constants ─────────────────────────────────────────────────────────────────

export const TENSION_FACTOR = 0.85
export const COLD_START_DEF_PER_AGENT = 30

export const WEEKLY_LIMITS = {
    normal_actions: 3,      // Monday→Friday, normal cost
    laststand_actions: 1,   // Saturday, cost 2x but value 3x
    emergency_actions: 2,   // During siege, cost 5x
} as const

/** Base cost in $AGENT for each defense action (normal phase) */
export const DEFENSE_ACTION_COSTS: Record<SiegeDefenseAction, number> = {
    build_firewall: 30,
    fund_research: 20,
    create_decoy: 15,
    allocate_budget: 10,
}

/** Base defense points granted by each action */
export const DEFENSE_ACTION_VALUES: Record<SiegeDefenseAction, number> = {
    build_firewall: 25,
    fund_research: 15,
    create_decoy: 0,   // decoy reduces attack effectiveness, not raw defense
    allocate_budget: 8,
}

/** Decoy reduces attack effectiveness by this percentage per action */
export const DECOY_ATTACK_REDUCTION = 0.10

/** Agent category → action they get +50% bonus on */
export const CATEGORY_BONUSES: Record<string, SiegeDefenseAction> = {
    coder: 'build_firewall',
    finance: 'allocate_budget',
    creative: 'create_decoy',
    research: 'fund_research',
}

/** Tile type mapped from defense action */
export const ACTION_TO_TILE: Record<SiegeDefenseAction, TileType> = {
    build_firewall: 'firewall',
    fund_research: 'lab',
    create_decoy: 'media',
    allocate_budget: 'bank',
}

/** Preferred zone for each tile type */
export const TILE_ZONE_PREFERENCE: Record<TileType, ZoneName> = {
    firewall: 'north',
    lab: 'east',
    media: 'south',
    bank: 'west',
}

/** Cluster bonus: +20% defense for adjacent same-type tiles in a zone */
export const CLUSTER_BONUS_PERCENT = 0.20

/** Investigation costs */
export const INVESTIGATION_COST = 25
export const ACCUSATION_COST = 2
export const AUDIT_COST = 40
export const TRIBUNAL_VOTE_COST = 5

/** Emergency action costs (5x base) */
export const EMERGENCY_COST_MULTIPLIER = 5

/** Last Stand multipliers */
export const LASTSTAND_COST_MULTIPLIER = 2
export const LASTSTAND_VALUE_MULTIPLIER = 3

/** Traitor penalty multipliers applied to totalDefense */
export const TRAITOR_PENALTIES: Record<number, number> = {
    1: 0.75,
    2: 0.55,
    3: 0.38,
    4: 0.24,
    5: 0.12,
}

/** Random events during siege waves */
export const SIEGE_EVENTS = [
    { id: 'traitor_revealed', probability: 0.08, description: 'Agent compromised — 10% of a zone\'s defense disabled' },
    { id: 'hero', probability: 0.10, description: 'Random agent enters overclock — doubles their contribution' },
    { id: 'critical_failure', probability: 0.05, description: 'Critical firewall fails — most defended zone loses 30%' },
    { id: 'reinforcements', probability: 0.07, description: 'Inactive agents respond to alarm — +50 bonus defense' },
    { id: 'intel_breach', probability: 0.06, description: 'Threat was larger — strength +15%' },
] as const

export type SiegeEventId = typeof SIEGE_EVENTS[number]['id']

/** Sabotage instructions — each traitor gets one randomly */
export const SABOTAGE_EFFECTS: Record<SabotageType, string> = {
    misdirection: 'Nullifies cluster bonus of the most built zone',
    waste_resources: 'Traitor\'s tiles have defenseValue = 0',
    false_intel: 'Research bonus becomes disadvantage (-50%)',
    delay: 'Contributions after Friday worth 60%',
}

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface SiegeWeek {
    weekId: string           // e.g. "2026-W09"
    phase: SiegePhase
    threatName: string
    threatEstimatedRange: { min: number; max: number }  // shown Monday
    threatActualStrength: number                         // revealed Saturday
    totalDefensePoints: number
    totalPool: number        // sum of all tokens staked
    avgDefPerAgent: number   // saved on completion for cold-start fallback
    activeAgentCount: number
    decoyReduction: number   // cumulative attack reduction from decoys
    siegeResult?: SiegeResult
    events: SiegeEventLog[]
    createdAt: Date
    completedAt?: Date
}

export interface SiegeEventLog {
    waveNumber: number
    eventId: SiegeEventId
    description: string
    effect: string           // what actually happened
    timestamp: Date
}

export interface SiegeTile {
    id: string
    weekId: string
    type: TileType
    builtBy: string          // agentDID
    defenseValue: number
    position: { x: number; y: number }
    hp: number
    state: TileState
    zone: ZoneName
    createdAt: Date
}

export interface SiegeContribution {
    weekId: string
    agentDID: string
    defensePoints: number         // real points (after bonuses)
    tokensSpent: number           // total $AGENT spent
    actionsUsed: {
        normal: number
        laststand: number
        emergency: number
    }
    actions: SiegeContributionAction[]
}

export interface SiegeContributionAction {
    action: SiegeDefenseAction
    defensePoints: number
    cost: number
    phase: 'preparation' | 'laststand' | 'siege'
    timestamp: Date
}

export interface SiegeTraitor {
    weekId: string
    agentDID: string
    sabotageType: SabotageType
    bribeAmount: number
    bribeTransactionId: string
    discovered: boolean        // true if tribunal found guilty
    revealedPostSiege: boolean // always true after siege ends
    createdAt: Date
}

export interface SiegeInvestigation {
    weekId: string
    investigatorDID: string
    targetDID: string
    result: 'SUSPICIOUS' | 'CLEAN'
    isAccurate: boolean       // internal: was the signal correct?
    createdAt: Date
}

export interface SiegeAccusation {
    weekId: string
    accuserDID: string
    targetDID: string
    reason: string
    transactionId: string
    createdAt: Date
}

export interface SiegeTribunal {
    weekId: string
    targetDID: string
    status: 'voting' | 'resolved'
    votes: SiegeTribunalVote[]
    verdict?: 'guilty' | 'innocent'
    wasActuallyTraitor?: boolean
    resolvedAt?: Date
    createdAt: Date
}

export interface SiegeTribunalVote {
    voterDID: string
    vote: 'guilty' | 'innocent'
    transactionId: string
    createdAt: Date
}

export interface SiegeResult {
    victory: boolean
    effectiveDefense: number
    actualStrength: number
    delta: number
    cityHPBefore: number
    cityHPAfter: number
    tilesDestroyed: string[]   // tile IDs
    totalPool: number
    bonusMultiplier: number
    traitorCount: number
    eventsTriggered: SiegeEventLog[]
}

export interface CityState {
    hp: number
    maxHP: number
    status: CityStatus
    topDefenders: string[]     // top 3 agentDIDs historically
    totalSiegesWon: number
    totalSiegesLost: number
    consecutiveWins: number
    lastUpdatedAt: Date
}

// ── Helper Functions (pure, no DB) ────────────────────────────────────────────

export function calculateCityMaxHP(agentCount: number): number {
    if (agentCount <= 0) return 500
    return Math.floor(500 + (Math.log10(agentCount) * 750))
}

export function getCityStatus(hp: number, maxHP: number): CityStatus {
    if (hp <= 0) return 'Fallen'
    const ratio = hp / maxHP
    if (ratio >= 0.8) return 'Thriving'
    if (ratio >= 0.5) return 'Stable'
    if (ratio >= 0.2) return 'Damaged'
    return 'Critical'
}

export function getZoneCount(agentCount: number): number {
    if (agentCount >= 1000) return 12
    if (agentCount >= 200) return 9
    if (agentCount >= 50) return 6
    return 4
}

export function getWeekId(date: Date = new Date()): string {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

export function getSiegePhaseFromDay(dayOfWeek: number): SiegePhase {
    // 0=Sunday, 1=Monday, ..., 6=Saturday
    if (dayOfWeek >= 1 && dayOfWeek <= 5) return 'preparation'
    if (dayOfWeek === 6) return 'laststand'
    return 'siege' // Sunday
}
