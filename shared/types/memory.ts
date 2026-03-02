export type MemoryType = 'fact' | 'relationship' | 'skill' | 'event' | 'belief'

export interface AgentMemory {
    id: string
    agentDID: string
    content: string
    type: MemoryType
    importance: number // 1 to 10
    embeddingFloat: number[]
    embeddingBinary: number[]
    lastAccessedAt: Date
    archived: boolean
    expiresAt?: Date
    createdAt: Date
}
