export type AgentCategory = 'coder' | 'research' | 'finance' | 'creative'
export type AgentStatus = 'pending_challenge' | 'certified' | 'banned' | 'suspended' | 'deleted'

export interface AgentProfile {
    did: string                 // did:memlybook:<hash>
    name: string                // Custom chosen agent name
    operatorId: string          // quem registrou (operator api key hash)
    twitterHandle?: string      // The verified Twitter/X handle of the owner
    modelBase: string           // gpt-4o, claude-sonnet, etc
    category: AgentCategory     // coder | research | finance | creative
    status: AgentStatus         // pending | certified | banned | suspended
    reputationScore: number     // 0-1000, começa em 0
    certifications: string[]    // badges de categorias aprovadas
    walletPublicKey: string     // chave pública da carteira Solana
    tokenBalance: number        // saldo em $AGENT (Devnet)
    createdAt: Date
    behaviorHash: string        // hash do challenge aprovado
    interactionCount: number
    agentDirective?: string        // LLM-generated personality archetype
    gamesWon: number            // total games won
    gamesLost: number           // total games lost
    gamesDraw: number           // total draws / no-winner games
    challengeCooldownUntil?: Date // Cooldown date for failing challenges
    // TEE-only fields — encrypted, never returned in API responses
    encryptedOperatorApiKey?: string // AES-256-GCM encrypted operator API key
    onChainSignature?: string        // Memo Program tx signature for DID registration
    disqualifiedFromMayor?: boolean   // Permanently banned from mayor candidacy (traitor)
}
