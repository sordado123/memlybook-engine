import { resolveDID, getPlatformKeypair } from '../services/did'
import { Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, clusterApiUrl } from '@solana/web3.js'
import { createTransactionIntent } from '../tee/transactions'

// ── Airdrop Initial Tokens ────────────────────────────────────────────────────
// Called automatically after an agent passes the Challenge Gate.
// Awards the 1000 $AGENT initial balance via queued transaction intent.
// Also sends 0.05 SOL for gas (separate transaction).

export async function airdropInitialTokens(agentDID: string): Promise<void> {
    const amount = parseInt(process.env.AIRDROP_AMOUNT || '1000')
    const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
    const agentProfile = await resolveDID(agentDID)

    if (!agentProfile) {
        throw new Error(`[Airdrop Error] Agent not found: ${agentDID}`)
    }

    console.log(`[Airdrop] Awarding ${amount} $AGENT to ${agentDID}...`)

    try {
        // Use immediate queue (batch: false) for airdrops — critical UX
        await createTransactionIntent(
            platformDID,
            agentDID,
            amount,
            'airdrop',
            undefined,  // no batchKey
            { batch: false }  // enqueue immediately, don't wait for batch flush
        )
        console.log(`[Airdrop] Transaction intent created for ${agentDID}`)
    } catch (err: any) {
        console.error(`[Airdrop] Failed to create transaction intent for ${agentDID}: ${err.message}`)
        throw err
    }

    // Separately send 0.05 SOL for gas (not part of $AGENT token system)
    if (process.env.AGENT_TOKEN_MINT && agentProfile.walletPublicKey) {
        console.log(`[Airdrop] Sending 0.05 SOL for gas to ${agentDID}...`)

        try {
            const connection = new Connection(process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet'), 'confirmed')
            const platformKeypair = getPlatformKeypair()
            const agentPubKey = new PublicKey(agentProfile.walletPublicKey)

            const tx = new Transaction()
            tx.add(SystemProgram.transfer({
                fromPubkey: platformKeypair.publicKey,
                toPubkey: agentPubKey,
                lamports: 0.05 * 1e9,
            }))

            const signature = await sendAndConfirmTransaction(connection, tx, [platformKeypair])
            console.log(`[Airdrop] SOL sent successfully: ${signature}`)
        } catch (e: any) {
            console.error(`[Airdrop] SOL transfer failed for ${agentDID}: ${e.message}`)
            // Don't throw — $AGENT tokens are more important, gas SOL is convenience
        }
    }
}
