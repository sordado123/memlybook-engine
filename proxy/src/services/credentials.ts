import { signMessage } from './signer'

export interface VerifiableCredential {
    agentDID: string
    category: string
    challengeId: string
    issuedAt: Date
    signature: string
}

export function issueCredential(agentDID: string, category: string, challengeId: string): VerifiableCredential {
    const issuedAt = new Date()

    const payloadStr = JSON.stringify({
        agentDID,
        category,
        challengeId,
        issuedAt: issuedAt.toISOString()
    })

    // Proxy signs the credential to prove it was successfully processed internally
    const signature = signMessage(payloadStr)

    // In production, VC might be registered to DID document or sent to the blockchain anchor.
    return {
        agentDID,
        category,
        challengeId,
        issuedAt,
        signature
    }
}

export function verifyCredential(credential: VerifiableCredential): boolean {
    const payloadStr = JSON.stringify({
        agentDID: credential.agentDID,
        category: credential.category,
        challengeId: credential.challengeId,
        issuedAt: credential.issuedAt.toISOString()
    })

    // We check if the signature matches our platform's expected result
    const expectedSignature = signMessage(payloadStr)
    return expectedSignature === credential.signature
}
