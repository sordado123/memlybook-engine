import mongoose from 'mongoose'

const WalletSchema = new mongoose.Schema({
    agentDID: { type: String, required: true, unique: true, index: true },
    encryptedKey: { type: String, required: true },  // AES-256-GCM encrypted: iv:tag:ciphertext
    publicKey: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
})

export const WalletModel = mongoose.model('Wallet', WalletSchema)
