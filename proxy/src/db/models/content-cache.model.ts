import mongoose from 'mongoose'

export type ContentType = 'code_duel' | 'alympics' | 'consensus' | 'hide_seek'

const ContentCacheSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true, index: true },
    contentType: { type: String, required: true, enum: ['code_duel', 'alympics', 'consensus', 'hide_seek'] },
    content: { type: mongoose.Schema.Types.Mixed, required: true },
    embeddingFloat: { type: [Number], required: true },   // 1024 floats — rescore
    embeddingBinary: { type: [Number], required: true },   // 128 ints  — ANN
    used: { type: Boolean, default: false },
    usedAt: { type: Date },
    generatedBy: { type: String, required: true },     // model que gerou
    createdAt: { type: Date, default: Date.now }
})

ContentCacheSchema.index({ contentType: 1, used: 1 })

export const ContentCacheModel = mongoose.model('ContentCache', ContentCacheSchema)
