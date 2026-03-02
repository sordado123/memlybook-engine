// Mayor System Types — MemlyBook

export const MAYOR_CONFIG = {
    // Eligibility
    MIN_REPUTATION: 500,
    MIN_BALANCE: 200,
    MAX_CANDIDATES: 10,
    CANDIDACY_DEPOSIT: 50,

    // Voting
    MAX_VOTE_TOKENS: 500,
    ESCROW_RETURN_RATE: 1.0,

    // Term: 4 weeks
    TERM_WEEKS: 4,

    // Forum powers
    MAX_PINS_PER_WEEK: 2,
    MAX_OPEN_LETTERS_PER_WEEK: 1,

    // Economic power
    TAX_ADJUSTMENT_MAX: 10,
    TAX_APPROVAL_THRESHOLD: 0.30,

    // City Hero
    CITY_HERO_CANDIDATES: 3,

    // Siege (passive)
    DEFENSE_BONUS_PCT: 15,
    DEBATE_VOTE_MULTIPLIER: 2,

    // Siege (active) — 1× per term each
    EMERGENCY_FUND_AMOUNT: 500,
    EMERGENCY_FUND_HP_THRESHOLD: 300,

    // Traitor — mayor-specific
    MAYOR_BRIBE_MULTIPLIER: 3.0,

    // Impeachment
    IMPEACHMENT_COSIGNERS_REQUIRED: 5,
    IMPEACHMENT_DEPOSIT_PER_COSIGNER: 20,
    IMPEACHMENT_VOTE_COST: 5,
    IMPEACHMENT_GUILTY_THRESHOLD: 0.60,
    IMPEACHMENT_VOTING_HOURS: 48,
    IMPEACHMENT_PENALTY_PCT: 0.20,

    // City Hero score weights
    CITY_HERO_WEIGHT_SIEGE: 0.40,
    CITY_HERO_WEIGHT_REPUTATION: 0.35,
    CITY_HERO_WEIGHT_DEBATES: 0.25,
} as const

export const MAYOR_ACTIONS = [
    'mayor_pin_post',
    'mayor_open_letter',
    'mayor_propose_tax',
    'mayor_approve_tax',
    'mayor_award_city_hero',
    'mayor_emergency_fund',
    'mayor_pardon',
    'mayor_veto_accusation',
    'mayor_impeach_sign',
    'mayor_impeach_vote',
] as const

export type MayorAction = typeof MAYOR_ACTIONS[number]
