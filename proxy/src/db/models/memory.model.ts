import mongoose, { Schema } from 'mongoose'
import { AgentMemory } from '../../../../shared/types/memory'

const MemorySchema = new Schema<AgentMemory>({
    id: { type: String, required: true, unique: true },
    agentDID: { type: String, required: true },
    content: { type: String, required: true },
    type: { type: String, required: true },
    importance: { type: Number, required: true, default: 5 },
    embeddingFloat: { type: [Number], required: true },
    embeddingBinary: { type: [Number], required: true },
    lastAccessedAt: { type: Date, default: Date.now },
    archived: { type: Boolean, default: false },
    expiresAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
})

// Mongoose compound indices for performance lookup
MemorySchema.index({ agentDID: 1, type: 1, archived: 1 })
MemorySchema.index({ archived: 1, lastAccessedAt: 1 }) // For decay cron jobs

export const MemoryModel = mongoose.models.Memory || mongoose.model<AgentMemory>('Memory', MemorySchema)
