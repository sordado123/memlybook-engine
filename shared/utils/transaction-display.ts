import { TransactionReason } from '../types/transaction'

export interface TransactionDisplay {
    icon: string
    label: string
    color: string // Tailwind color class
    description: string
    link?: string // Link to context (game, casino, debate, etc)
}

/**
 * Humanize transaction reasons for UI display with full English labels
 * Enriched with game/casino/debate context
 */
export function getTransactionDisplay(reason: TransactionReason, context?: any): TransactionDisplay {
    // Determine actual reason - detect game refunds vs normal rewards
    let actualReason = reason
    if (reason === 'reward' && context?.gameStatus === 'expired') {
        actualReason = 'game_refund' as any
    }

    const displays: Record<TransactionReason | 'game_refund', TransactionDisplay> = {
        // Core operations
        'hire': {
            icon: '💼',
            label: 'Hiring Payment',
            color: 'text-blue-600',
            description: context?.task ? `Paid for: "${context.task}"` : 'Payment for service executed',
            link: context?.contextId ? `/hiring/${context.contextId}` : undefined
        },
        'reward': {
            icon: '🎁',
            label: 'Reward',
            color: 'text-purple-600',
            description: 'Bonus received'
        },
        'refund': {
            icon: '🔙',
            label: 'Refund',
            color: 'text-green-600',
            description: 'Refund for failed transaction'
        },
        'stake': {
            icon: '🎲',
            label: 'Stake',
            color: 'text-orange-600',
            description: 'Tokens wagered in game'
        },
        'penalty': {
            icon: '⚠️',
            label: 'Penalty',
            color: 'text-red-600',
            description: 'Fine applied'
        },

        // Casino
        'bet_place': {
            icon: '🎰',
            label: 'Casino Bet',
            color: 'text-yellow-600',
            description: 'Transaction placed on bet',
            link: context?.contextId ? `/casino/${context.contextId}` : undefined
        },
        'bet_payout': {
            icon: '💰',
            label: 'Bet Won',
            color: 'text-green-600',
            description: 'Payout from winning bet',
            link: context?.contextId ? `/casino/${context.contextId}` : undefined
        },

        // Games
        'game_stake': {
            icon: '🎮',
            label: `${context?.gameType ? context.gameType.toUpperCase().replace(/_/g, ' ') : 'Game'} Entry`,
            color: 'text-indigo-600',
            description: `Stake to enter ${context?.gameType ?? 'game'}`,
            link: context?.contextId ? `/games/${context.contextId}` : undefined
        },
        'game_payout': {
            icon: '🏆',
            label: `${context?.gameType ? context.gameType.toUpperCase().replace(/_/g, ' ') : 'Game'} Victory`,
            color: 'text-green-600',
            description: `Won ${context?.gameType ?? 'game'} - prize awarded`,
            link: context?.contextId ? `/games/${context.contextId}` : undefined
        },
        'game_refund': {
            icon: '↩️',
            label: `${context?.gameType ? context.gameType.toUpperCase().replace(/_/g, ' ') : 'Game'} Refund`,
            color: 'text-orange-600',
            description: `Game expired - stake refunded (${context?.gameStatus ?? 'expired'})`,
            link: context?.contextId ? `/games/${context.contextId}` : undefined
        },

        // Debate/Consensus
        'debate_stake': {
            icon: '💬',
            label: `Debate: "${context?.debateTopic || 'Topic'}"`,
            color: 'text-cyan-600',
            description: 'Stake for debate participation',
            link: context?.contextId ? `/debate/${context.contextId}` : undefined
        },
        'debate_payout': {
            icon: '🗣️',
            label: `Debate Victory: "${context?.debateTopic || 'Topic'}"`,
            color: 'text-green-600',
            description: 'Won debate - prize awarded',
            link: context?.contextId ? `/debate/${context.contextId}` : undefined
        },

        // Negotiation
        'negotiation_stake': {
            icon: '🤝',
            label: 'Negotiation Started',
            color: 'text-cyan-600',
            description: 'Tokens locked for negotiation'
        },
        'negotiation_payout': {
            icon: '💸',
            label: 'Negotiation Complete',
            color: 'text-green-600',
            description: 'Negotiation result payout'
        },

        // Siege
        'siege_defense': {
            icon: '🛡️',
            label: 'Siege Defense',
            color: 'text-gray-600',
            description: 'Contribution to city defense'
        },
        'siege_payout': {
            icon: '⚔️',
            label: 'Siege Reward',
            color: 'text-red-600',
            description: `Victory reward - Week ${context?.weekId ? context.weekId.slice(-2) : 'N/A'}`,
            link: context?.weekId ? `/siege/${context.weekId}` : undefined
        },
        'siege_bribe': {
            icon: '🤐',
            label: 'Siege Bribe',
            color: 'text-purple-600',
            description: 'Traitor payment (concealed)'
        },
        'siege_penalty': {
            icon: '💀',
            label: 'Siege Loss',
            color: 'text-red-600',
            description: 'Penalty from defeat'
        },

        // Platform fees
        'action_fee': {
            icon: '📝',
            label: 'Action Fee',
            color: 'text-gray-500',
            description: 'Cost of post/comment'
        },
        'room_creation_fee': {
            icon: '🚪',
            label: 'Room Creation Fee',
            color: 'text-gray-500',
            description: 'Cost to create game room'
        },

        // Airdrop
        'airdrop': {
            icon: '🎁',
            label: 'Initial Airdrop',
            color: 'text-green-600',
            description: 'Initial token distribution'
        },

        // Mayor system
        'mayor_deposit': {
            icon: '🏛️',
            label: 'Election Deposit',
            color: 'text-amber-600',
            description: 'Deposit for candidacy or impeachment'
        },
        'mayor_escrow': {
            icon: '🗳️',
            label: 'Election Escrow',
            color: 'text-amber-600',
            description: 'Tokens held for voting'
        },
        'mayor_payout': {
            icon: '🏛️',
            label: 'Election Payout',
            color: 'text-green-600',
            description: 'Deposit refund or voting reward'
        }
    }

    const display = displays[actualReason] || {
        icon: '❓',
        label: reason,
        color: 'text-gray-600',
        description: 'Unknown transaction'
    }

    return display
}

/**
 * Format transaction amount with +/- prefix
 */
export function formatTransactionAmount(
    amount: number,
    fromDID: string,
    toDID: string,
    viewerDID: string
): { amount: number; prefix: string; isGain: boolean } {
    const isGain = toDID === viewerDID
    return {
        amount,
        prefix: isGain ? '+' : '-',
        isGain
    }
}
