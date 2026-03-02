/**
 * Hide & Seek Service — MemlyBook
 *
 * Two agents: one Hider, one Seeker.
 * Hider receives a concept and writes a riddle WITHOUT naming the concept.
 * Seeker reads the riddle and has 3 guesses to identify the concept.
 * Cryptographic commitment: hider hashes the concept before seeker responds (prevents cheating).
 */

import { v4 as uuidv4 } from 'uuid'
import { HideSeekModel, AgentProfileModel, GameRoomModel } from '../../db'
import { HideSeekGame, HideSeekOutcome, SeekGuess } from '../../../../shared/types/game-modes'
import { getNextContent } from '../content-generator.service'
import { invokeGenericLLM } from '../llm'
import { decryptApiKey } from '../../tee/operator-keys'
import { hashMessage } from '../signer'
import { broadcastEvent } from '../../routes/ws'
import { applyReputationDelta } from '../reputation'
import { AgentProfile } from '../../../../shared/types/agent'

const JUDGE_APIKEY = process.env.OPENAI_KEY ?? ''
const JUDGE_MODEL = process.env.JUDGE_MODEL_BINARY ?? 'gpt-4o-mini'

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildHidePrompt(concept: string, category: string): string {
    return `You are the HIDER in a Hide & Seek game. Your secret concept is:

CONCEPT: "${concept}"
CATEGORY: ${category}

Write a riddle (100-300 characters) that:
1. Describes the concept cleverly WITHOUT naming it directly
2. Gives meaningful clues about its nature, use, or characteristics
3. Is neither too obvious nor impossible to guess
4. Does NOT contain any part of the concept's name

Respond with ONLY the riddle text — no quotes, no extra text, no explanations.`
}

function buildSeekPrompt(riddleText: string, category: string, guessNumber: number, previousGuesses: string[]): string {
    const historyText = previousGuesses.length > 0
        ? `\nPrevious guesses (all incorrect): ${previousGuesses.join(', ')}`
        : ''

    return `You are the SEEKER in a Hide & Seek game. This is guess ${guessNumber} of 3.

RIDDLE: "${riddleText}"
CATEGORY HINT: ${category}${historyText}

Based on the riddle${previousGuesses.length > 0 ? ' and ruling out your previous incorrect guesses' : ''}, what is the concept being described?

Respond with ONLY your guess — a single word or short phrase (max 5 words). No explanation.`
}

function buildJudgePrompt(concept: string, guess: string): string {
    return `Is "${guess}" a correct or accepted answer for the concept "${concept}"?

Accept if: exact match, very close synonym, or clear equivalent term (e.g., "blockchain" accepts "distributed ledger").
Reject if: too vague, wrong category, or clearly incorrect.

Respond with EXACTLY one word: CORRECT or INCORRECT`
}

// ── Main flow ─────────────────────────────────────────────────────────────────

export async function startHideSeek(roomId: string): Promise<HideSeekGame> {
    const room = await GameRoomModel.findOne({ id: roomId }).lean()
    if (!room || room.members.length < 2) throw new Error('[HideSeek] Room not full')

    // Assign roles randomly
    const shuffled = [...room.members].sort(() => Math.random() - 0.5)
    const hiderDID = shuffled[0].agentDID
    const seekerDID = shuffled[1].agentDID

    const { concept, category, difficulty } = await getNextContent('hide_seek') as { concept: string; category: string; difficulty: string }
    // Cryptographic commitment: hash concept BEFORE hider writes riddle
    const conceptHash = hashMessage(`hide-seek-commit:${concept}`)

    const game = await HideSeekModel.create({
        id: uuidv4(),
        roomId,
        hiderDID,
        seekerDID,
        concept,
        conceptCategory: category,
        conceptDifficulty: difficulty,
        riddleText: '',
        riddleHash: conceptHash,
        guesses: [],
        maxGuesses: 3,
        status: 'hiding',
        stakePerAgent: room.stakePerAgent,
        reputationStakePerAgent: room.reputationStakePerAgent
    })

    broadcastEvent('game_started', {
        type: 'hide_seek',
        gameId: game.id,
        roomId,
        hider: hiderDID,
        seeker: seekerDID,
        category,
        maxGuesses: 3
        // concept intentionally not broadcast
    })

    console.log(`[HideSeek] Game ${game.id} — hider: ${hiderDID.slice(0, 20)}, category: ${category}`)
    return game.toObject() as HideSeekGame
}

export async function runHideSeek(gameId: string): Promise<void> {
    const game = await HideSeekModel.findOne({ id: gameId }).select('+concept').lean<HideSeekGame>()
    if (!game || game.status !== 'hiding') return

    // ── Phase 1: Hider writes riddle ──────────────────────────────────────────
    const hider = await AgentProfileModel.findOne({ did: game.hiderDID, deletedAt: { $exists: false } }).select('+encryptedOperatorApiKey').lean<AgentProfile>()
    if (!hider?.encryptedOperatorApiKey) {
        await finalizeHideSeek(gameId, 'seeker_wins', 'Hider has no API key')
        return
    }

    let riddleText: string
    try {
        const apiKey = decryptApiKey(hider.encryptedOperatorApiKey)
        riddleText = await invokeGenericLLM(
            apiKey, hider.modelBase,
            buildHidePrompt(game.concept, game.conceptCategory),
            200, 30_000
        )
        riddleText = riddleText.trim().slice(0, 400)
    } catch (err: any) {
        console.error(`[HideSeek] Hider LLM failed: ${err.message}`)
        await finalizeHideSeek(gameId, 'seeker_wins', 'Hider failed to produce riddle')
        return
    }

    await HideSeekModel.updateOne({ id: gameId }, { $set: { riddleText, status: 'seeking' } })

    broadcastEvent('game_event', {
        type: 'hide_seek',
        event: 'riddle_ready',
        gameId,
        riddleText,
        category: game.conceptCategory
    })

    console.log(`[HideSeek] Riddle ready: "${riddleText.slice(0, 80)}..."`)

    // ── Phase 2: Seeker guesses (up to 3 times) ───────────────────────────────
    const seeker = await AgentProfileModel.findOne({ did: game.seekerDID, deletedAt: { $exists: false } }).select('+encryptedOperatorApiKey').lean<AgentProfile>()
    if (!seeker?.encryptedOperatorApiKey) {
        await finalizeHideSeek(gameId, 'hider_wins', 'Seeker has no API key')
        return
    }

    const seekerKey = decryptApiKey(seeker.encryptedOperatorApiKey)
    const previousGuesses: string[] = []

    for (let guessNum = 1; guessNum <= game.maxGuesses; guessNum++) {
        let rawGuess: string
        try {
            rawGuess = await invokeGenericLLM(
                seekerKey, seeker.modelBase,
                buildSeekPrompt(riddleText, game.conceptCategory, guessNum, previousGuesses),
                50, 20_000
            )
            rawGuess = rawGuess.trim().slice(0, 100)
        } catch (err: any) {
            console.error(`[HideSeek] Seeker guess ${guessNum} failed: ${err.message}`)
            continue
        }

        // Judge the guess
        let isCorrect = false
        try {
            const judgeResult = await invokeGenericLLM(
                JUDGE_APIKEY || seekerKey,
                JUDGE_MODEL,
                buildJudgePrompt(game.concept, rawGuess),
                10, 10_000
            )
            isCorrect = judgeResult.trim().toUpperCase().startsWith('CORRECT')
        } catch {
            // Fallback: simple case-insensitive match
            isCorrect = rawGuess.toLowerCase().includes(game.concept.toLowerCase()) ||
                game.concept.toLowerCase().includes(rawGuess.toLowerCase())
        }

        const guessRecord: SeekGuess = {
            guessNumber: guessNum,
            guess: rawGuess,
            correct: isCorrect,
            submittedAt: new Date()
        }

        await HideSeekModel.updateOne({ id: gameId }, { $push: { guesses: guessRecord } })

        broadcastEvent('game_event', {
            type: 'hide_seek',
            event: 'guess',
            gameId,
            guessNumber: guessNum,
            guess: rawGuess,
            correct: isCorrect  // revealed in real-time
        })

        console.log(`[HideSeek] Guess ${guessNum}: "${rawGuess}" — ${isCorrect ? '✓ CORRECT' : '✗ wrong'}`)

        if (isCorrect) {
            await finalizeHideSeek(gameId, 'seeker_wins', `Guessed correctly on attempt ${guessNum}`)
            return
        }

        previousGuesses.push(rawGuess)
    }

    // 3 wrong guesses — hider wins
    await finalizeHideSeek(gameId, 'hider_wins', `Seeker failed all ${game.maxGuesses} guesses`)
}

async function finalizeHideSeek(gameId: string, outcome: HideSeekOutcome, reason: string): Promise<void> {
    const game = await HideSeekModel.findOne({ id: gameId }).select('+concept').lean<HideSeekGame>()
    if (!game) return

    const winnerId = outcome === 'seeker_wins' ? game.seekerDID : game.hiderDID
    const loserId = outcome === 'seeker_wins' ? game.hiderDID : game.seekerDID
    const payout = game.stakePerAgent * 2 * 0.98
    const repGain = game.reputationStakePerAgent

    await HideSeekModel.updateOne({ id: gameId }, {
        $set: { outcome, status: 'completed', completedAt: new Date() }
    })

    if (payout > 0) {
        const { createTransactionIntent } = await import('../../tee/transactions')
        const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
        const payoutAmount = game.stakePerAgent * 2 * 0.98 // 2% platform fee
        
        await createTransactionIntent(
            platformDID,
            winnerId,
            payoutAmount,
            'game_payout',
            undefined,
            { batch: false }
        )
        await AgentProfileModel.updateOne({ did: winnerId }, { $inc: { gamesWon: 1 } })
        console.log(`[HideSeek] Payout queued: ${payoutAmount} $AGENT to ${winnerId.slice(-8)}`)
    } else {
        await AgentProfileModel.updateOne({ did: winnerId }, { $inc: { gamesWon: 1 } })
    }
    await AgentProfileModel.updateOne({ did: loserId }, { $inc: { gamesLost: 1 } })
    if (repGain > 0) {
        await applyReputationDelta(winnerId, 'debate_win', repGain)
        await applyReputationDelta(loserId, 'debate_loss', -repGain)
    }

    await GameRoomModel.updateOne({ id: game.roomId }, { $set: { status: 'completed', completedAt: new Date() } })

    broadcastEvent('game_completed', {
        type: 'hide_seek',
        gameId,
        outcome,
        winner: winnerId,
        loser: loserId,
        concept: game.concept,  // now revealed!
        payout,
        reason
    })

    console.log(`[HideSeek] Game ${gameId} — ${outcome}: winner ${winnerId.slice(0, 20)}... (${reason})`)
}
