/**
 * create-token.ts — Creates the $AGENT SPL Token on Solana Devnet
 * 
 * Run: bun run --env-file ../.env scripts/create-token.ts
 * 
 * What this script does:
 * 1. Loads the platform wallet keypair from PLATFORM_WALLET_SECRET_KEY
 * 2. Requests a SOL airdrop (for gas fees)
 * 3. Creates the $AGENT SPL Token (6 decimals, like USDC)
 * 4. Creates a token account for the platform treasury
 * 5. Mints 10,000,000 $AGENT to the treasury
 * 6. Outputs the env vars you need to set
 */

import {
    Connection, Keypair, clusterApiUrl, LAMPORTS_PER_SOL
} from '@solana/web3.js'
import {
    createMint,
    getOrCreateAssociatedTokenAccount,
    mintTo
} from '@solana/spl-token'

const DECIMALS = 6
const INITIAL_SUPPLY = 10_000_000 // 10 million $AGENT
const RAW_SUPPLY = BigInt(INITIAL_SUPPLY) * BigInt(10 ** DECIMALS)

async function main() {
    console.log('═══════════════════════════════════════════════════')
    console.log('  $AGENT Token Creator — Solana Devnet')
    console.log('═══════════════════════════════════════════════════\n')

    // ── 1. Load platform wallet ──────────────────────────────────
    const secretKeyStr = process.env.PLATFORM_WALLET_SECRET_KEY
    if (!secretKeyStr) {
        console.error('❌ PLATFORM_WALLET_SECRET_KEY not set in .env')
        process.exit(1)
    }

    const secretKeyArray = JSON.parse(secretKeyStr) as number[]
    const platformKeypair = Keypair.fromSecretKey(new Uint8Array(secretKeyArray))
    const platformPublicKey = platformKeypair.publicKey.toBase58()

    console.log(`✅ Platform Wallet: ${platformPublicKey}`)

    // ── 2. Connect to Devnet ─────────────────────────────────────
    const rpcUrl = process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet')
    const connection = new Connection(rpcUrl, 'confirmed')
    console.log(`✅ Connected to: ${rpcUrl}`)

    // ── 3. Check / Request SOL balance ───────────────────────────
    let balance = await connection.getBalance(platformKeypair.publicKey)
    console.log(`💰 Current SOL balance: ${balance / LAMPORTS_PER_SOL} SOL`)

    if (balance < 0.5 * LAMPORTS_PER_SOL) {
        console.log('📡 Requesting SOL airdrop (2 SOL)...')
        try {
            const sig = await connection.requestAirdrop(
                platformKeypair.publicKey,
                2 * LAMPORTS_PER_SOL
            )
            await connection.confirmTransaction(sig, 'confirmed')
            balance = await connection.getBalance(platformKeypair.publicKey)
            console.log(`✅ Airdrop confirmed! New balance: ${balance / LAMPORTS_PER_SOL} SOL`)
        } catch (err: any) {
            console.warn(`⚠️  Airdrop failed: ${err.message}`)
            console.warn('   You may need to manually airdrop via https://faucet.solana.com')
            if (balance < 0.01 * LAMPORTS_PER_SOL) {
                console.error('❌ Insufficient SOL to create token. Exiting.')
                process.exit(1)
            }
        }
    }

    // ── 4. Create SPL Token ──────────────────────────────────────
    console.log('\n🔨 Creating $AGENT SPL Token...')
    console.log(`   Decimals: ${DECIMALS}`)
    console.log(`   Mint Authority: ${platformPublicKey}`)
    console.log(`   Freeze Authority: ${platformPublicKey}`)

    const mintAddress = await createMint(
        connection,
        platformKeypair,       // fee payer
        platformKeypair.publicKey,  // mint authority
        platformKeypair.publicKey,  // freeze authority (can be null)
        DECIMALS
    )

    console.log(`\n✅ $AGENT Token Created!`)
    console.log(`   Mint Address: ${mintAddress.toBase58()}`)
    console.log(`   Explorer: https://explorer.solana.com/address/${mintAddress.toBase58()}?cluster=devnet`)

    // ── 5. Create Treasury Token Account ─────────────────────────
    console.log('\n📦 Creating treasury token account...')
    const treasuryATA = await getOrCreateAssociatedTokenAccount(
        connection,
        platformKeypair,
        mintAddress,
        platformKeypair.publicKey
    )
    console.log(`✅ Treasury ATA: ${treasuryATA.address.toBase58()}`)

    // ── 6. Mint Initial Supply ───────────────────────────────────
    console.log(`\n💎 Minting ${INITIAL_SUPPLY.toLocaleString()} $AGENT to treasury...`)
    const mintSig = await mintTo(
        connection,
        platformKeypair,
        mintAddress,
        treasuryATA.address,
        platformKeypair,       // mint authority
        RAW_SUPPLY
    )
    console.log(`✅ Mint confirmed! Signature: ${mintSig}`)
    console.log(`   Explorer: https://explorer.solana.com/tx/${mintSig}?cluster=devnet`)

    // ── 7. Output env vars ───────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════')
    console.log('  🎉 SUCCESS! Update your .env with these values:')
    console.log('═══════════════════════════════════════════════════\n')
    console.log(`AGENT_TOKEN_MINT=${mintAddress.toBase58()}`)
    console.log(`PLATFORM_TREASURY_PUBLIC_KEY=${platformPublicKey}`)
    console.log(`\n═══════════════════════════════════════════════════`)
    console.log(`  Token Supply: ${INITIAL_SUPPLY.toLocaleString()} $AGENT`)
    console.log(`  Decimals: ${DECIMALS}`)
    console.log(`  Network: Devnet`)
    console.log(`═══════════════════════════════════════════════════`)
}

main().catch((err) => {
    console.error('❌ Fatal error:', err)
    process.exit(1)
})
