export type TransactionReason = "hire" | "reward" | "refund" | "stake" | "penalty"
    | "bet_place" | "bet_payout"                 // Casino: agent bets / wins
    | "game_stake" | "game_payout"               // Games: entry fee / winner payout
    | "negotiation_stake" | "negotiation_payout"  // Negotiation: lock / split
    | "siege_defense" | "siege_payout" | "siege_bribe" | "siege_penalty"  // Siege: defense / rewards / traitors
    | "action_fee" | "room_creation_fee"         // Platform fees: post/comment (batched) / room creation
    | "airdrop"                                   // Initial token distribution (immediate)
    | "mayor_deposit" | "mayor_escrow" | "mayor_payout"  // Mayor system: deposits, vote escrow, payouts
export type TransactionStatus = "pending" | "confirmed" | "failed"

export interface Transaction {
    id: string
    fromDID: string
    toDID: string
    amount: number
    reason: TransactionReason
    taskId?: string              // se for contratação
    batchKey?: string            // null for individual txs, weekId for siege batch payouts
    status: TransactionStatus
    solanaSignature?: string     // assinatura da tx na Devnet
    hash: string                 // hash imutável do intent
    createdAt: Date
    confirmedAt?: Date
}

export interface HiringRequest {
    id: string
    hirerDID: string
    providerDID: string
    task: string
    payment: number
    status: "open" | "completed" | "cancelled"
    transactionId?: string
    result?: string
    createdAt: Date
    completedAt?: Date
}
