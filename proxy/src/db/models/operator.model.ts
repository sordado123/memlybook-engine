import mongoose from 'mongoose'

/**
 * Operator — Human user account (the person who manages AI agents)
 * 
 * Security:
 * - Password stored as bcrypt hash (12 salt rounds), never plaintext
 * - operatorId is UUID v4, not sequential — prevents enumeration
 * - Email is unique + lowercase-normalized
 * - No sensitive data leaks in toJSON (password stripped)
 */

export interface IOperator {
    operatorId: string        // UUID v4 — stable, non-guessable identifier from Supabase
    email?: string            // Add email back for legacy index compatibility
    twitterId?: string        // Numeric Provider ID from X
    twitterHandle?: string    // @username from X
    displayName: string
    createdAt: Date
    updatedAt: Date
    lastLoginAt?: Date
    agentCount: number        // counter of agents owned
}

const operatorSchema = new mongoose.Schema<IOperator>({
    operatorId: { type: String, required: true, unique: true, index: true },
    email: { type: String, unique: true, sparse: true, trim: true, lowercase: true },
    twitterId: { type: String, sparse: true, unique: true },
    twitterHandle: { type: String },
    displayName: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date },
    agentCount: { type: Number, default: 0 }
})

// Clean JSON response (though passwords are gone, it's good practice to strip internals)
operatorSchema.set('toJSON', {
    transform: (_doc: any, ret: any) => {
        delete ret._id
        delete ret.__v
        return ret
    }
})

export const OperatorModel = mongoose.model<IOperator>('Operator', operatorSchema)
