/**
 * Content Generator Service — MemlyBook
 *
 * Generates unique game content (problems, topics, challenges, concepts)
 * using LLMs with embedding-based diversity enforcement.
 *
 * Diversity mechanism:
 *  1. Before generating, fetch the 15 most semantically similar existing items
 *  2. Include them as "avoid" context in the LLM prompt
 *  3. Store the generated content's embedding for future diversity checks
 *
 * Cache flow:
 *  getNextContent() → returns oldest unused item from cache
 *  → triggers background refill if stock < MIN_STOCK
 *  → generates immediately if cache is empty (rare fallback)
 */

import { v4 as uuidv4 } from 'uuid'
import { ContentCacheModel, ContentType } from '../db/models/content-cache.model'
import { embedDocument, cosineSimilarity } from './embeddings'
import { invokeGenericLLM } from './llm'
import type { CodeDuelProblem, AlympicsChallenge } from '../../../shared/types/game-modes'
import { qdrantClient } from '../db/qdrant'

// ── Config ────────────────────────────────────────────────────────────────────

const OPENAI_KEY = process.env.OPENAI_KEY ?? ''
const MODEL_CODE = process.env.CONTENT_GEN_MODEL_CODE ?? 'gpt-4o'
const MODEL_GENERAL = process.env.CONTENT_GEN_MODEL_GENERAL ?? 'gpt-4o-mini'
const MIN_STOCK = 5

// ── Semantic search ───────────────────────────────────────────────────────────

/**
 * Fetches the N most semantically similar items to intentText.
 * Used to build the negative context ("avoid these") in generation prompts.
 */
async function findSimilarContent(
    intentText: string,
    contentType: ContentType,
    limit: number = 15
): Promise<any[]> {
    try {
        const embedding = await embedDocument(intentText)

        // Qdrant Vector Search for fast candidate retrieval
        const searchResult = await qdrantClient.search('content_cache', {
            vector: embedding.float,
            limit: 30,
            filter: {
                must: [{ key: 'contentType', match: { value: contentType } }]
            }
        });

        if (searchResult.length === 0) return []

        const candidateIds = searchResult.map(res => String(res.id));
        const candidates = await ContentCacheModel.find({ id: { $in: candidateIds } })
            .select('content embeddingFloat')
            .lean()

        // Rescore with float vectors for precision
        return candidates
            .filter((c: any) => Array.isArray(c.embeddingFloat) && c.embeddingFloat.length > 0)
            .map((c: any) => ({
                content: c.content,
                score: cosineSimilarity(embedding.float, c.embeddingFloat as number[])
            }))
            .sort((a: any, b: any) => b.score - a.score)
            .slice(0, limit)
            .map((c: any) => c.content)
    } catch {
        // If Atlas vector search fails (e.g., index not yet ready), return empty
        return []
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the oldest unused content item from the cache (FIFO).
 * Triggers background refill if stock is low.
 * Generates immediately as fallback if cache is empty.
 */
export async function getNextContent(contentType: ContentType): Promise<any> {
    const cached = await ContentCacheModel.findOneAndUpdate(
        { contentType, used: false },
        { $set: { used: true, usedAt: new Date() } },
        { returnDocument: 'before', sort: { createdAt: 1 } }   // FIFO
    ).lean()

    if (cached) {
        // Kickoff background refill without blocking
        checkAndRefill(contentType).catch(err =>
            console.error(`[ContentGen] Background refill error for ${contentType}:`, (err as Error).message)
        )
        return (cached as any).content
    }

    // Empty cache — generate now (rare, latency hit)
    console.warn(`[ContentGen] Cache empty for ${contentType} — generating synchronously`)
    return await generateAndSave(contentType)
}

/**
 * Checks stock for a content type and generates new items if below MIN_STOCK.
 * Called by the content-cache worker every 10 minutes, and after each item is consumed.
 */
export async function checkAndRefill(contentType: ContentType): Promise<void> {
    if (!OPENAI_KEY) {
        console.warn('[ContentGen] OPENAI_KEY not set — skipping refill')
        return
    }

    const stock = await ContentCacheModel.countDocuments({ contentType, used: false })
    if (stock >= MIN_STOCK) return

    const needed = MIN_STOCK - stock + 3  // generate with headroom
    console.log(`[ContentGen] Refilling ${contentType}: ${stock} remaining, generating ${needed}`)

    for (let i = 0; i < needed; i++) {
        try {
            await generateAndSave(contentType)
            await new Promise(r => setTimeout(r, 600))  // rate limit buffer
        } catch (err) {
            console.error(`[ContentGen] Generation ${i + 1}/${needed} failed for ${contentType}:`, (err as Error).message)
        }
    }
}

/**
 * Seeds the cache from static content-banks so the LLM has historical context
 * on what already existed. Items are marked used=true (history only, not new stock).
 * Safe to call multiple times — skips types that already have data.
 */
export async function seedFromStaticBanks(): Promise<void> {
    if (!process.env.VOYAGE_API_KEY) {
        console.warn('[ContentGen] VOYAGE_API_KEY not set — skipping static seed')
        return
    }

    const {
        CODE_DUEL_PROBLEMS,
        ALYMPICS_CHALLENGES,
        CONSENSUS_TOPICS,
        HIDE_SEEK_CONCEPTS
    } = await import('./games/content-banks')

    const types: [ContentType, any[]][] = [
        ['code_duel', CODE_DUEL_PROBLEMS],
        ['alympics', chunkArray(ALYMPICS_CHALLENGES, 3)],
        ['consensus', CONSENSUS_TOPICS],
        ['hide_seek', HIDE_SEEK_CONCEPTS]
    ]

    for (const [contentType, items] of types) {
        const existing = await ContentCacheModel.countDocuments({ contentType })
        if (existing > 0) {
            console.log(`[ContentGen] ${contentType} already seeded (${existing} items) — skipping`)
            continue
        }

        console.log(`[ContentGen] Seeding ${items.length} static items for ${contentType}`)
        for (const item of items) {
            try {
                const contentText = extractText(contentType, item)
                const embedding = await embedDocument(contentText)
                const newId = uuidv4()
                await ContentCacheModel.create({
                    id: newId,
                    contentType,
                    content: item,
                    embeddingFloat: embedding.float,
                    embeddingBinary: embedding.binary,
                    used: true,          // historical — not fresh stock
                    usedAt: new Date(),
                    generatedBy: 'static-seed'
                })

                // Sync with Qdrant
                await qdrantClient.upsert('content_cache', {
                    wait: true,
                    points: [{
                        id: newId,
                        vector: embedding.float,
                        payload: { contentType }
                    }]
                }).catch(err => console.error(`[Qdrant] Failed to seed ${newId}:`, err.message))

                await new Promise(r => setTimeout(r, 250))  // Voyage rate limit
            } catch (err) {
                console.error(`[ContentGen] Seed item failed for ${contentType}:`, (err as Error).message)
            }
        }
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractJson(raw: string): string {
    const startObj = raw.indexOf('{');
    const startArr = raw.indexOf('[');
    let start = -1;
    if (startObj !== -1 && startArr !== -1) start = Math.min(startObj, startArr);
    else if (startObj !== -1) start = startObj;
    else if (startArr !== -1) start = startArr;

    if (start === -1) return raw;

    const endObj = raw.lastIndexOf('}');
    const endArr = raw.lastIndexOf(']');
    let end = -1;
    if (endObj !== -1 && endArr !== -1) end = Math.max(endObj, endArr);
    else if (endObj !== -1) end = endObj;
    else if (endArr !== -1) end = endArr;

    if (end === -1 || end < start) return raw;

    return raw.substring(start, end + 1);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
    return chunks
}

function extractText(type: ContentType, content: any): string {
    switch (type) {
        case 'code_duel':
            return `${content.title ?? ''} ${content.description ?? ''} ${content.constraints ?? ''}`
        case 'alympics':
            return Array.isArray(content)
                ? content.map((c: any) => `${c.category ?? ''} ${c.prompt ?? ''}`).join(' ')
                : JSON.stringify(content).slice(0, 500)
        case 'consensus':
            return String(content)
        case 'hide_seek':
            return `${content.concept ?? ''} ${content.category ?? ''}`
        default:
            return JSON.stringify(content).slice(0, 500)
    }
}

function extractTitle(type: ContentType, content: any): string {
    switch (type) {
        case 'code_duel': return String(content.title ?? 'unknown')
        case 'alympics': return Array.isArray(content) ? `[${content.map((c: any) => c.category).join(', ')}]` : '?'
        case 'consensus': return String(content).slice(0, 60) + '...'
        case 'hide_seek': return `${content.concept} (${content.category})`
        default: return '?'
    }
}

async function generateAndSave(contentType: ContentType): Promise<any> {
    let content: any
    let intentText: string
    let model: string

    switch (contentType) {
        case 'code_duel':
            intentText = 'competitive algorithm coding problem computer science data structures'
            model = MODEL_CODE
            content = await generateCodeDuelProblem(intentText, model)
            break
        case 'alympics':
            intentText = 'multi-category challenge logic creative knowledge reasoning'
            model = MODEL_GENERAL
            content = await generateAlympicsChallenges(intentText, model)
            break
        case 'consensus':
            intentText = 'controversial debatable topic AI technology society ethics governance'
            model = MODEL_GENERAL
            content = await generateConsensusTopic(intentText, model)
            break
        case 'hide_seek':
            intentText = 'concept word category riddle game hide seek guess'
            model = MODEL_GENERAL
            content = await generateHideSeekConcept(intentText, model)
            break
        default:
            throw new Error(`[ContentGen] Unknown contentType: ${contentType}`)
    }

    const contentText = extractText(contentType, content)
    const embedding = await embedDocument(contentText)

    const newId = uuidv4()
    await ContentCacheModel.create({
        id: newId,
        contentType,
        content,
        embeddingFloat: embedding.float,
        embeddingBinary: embedding.binary,
        used: false,
        generatedBy: model
    })

    // Sync with Qdrant
    await qdrantClient.upsert('content_cache', {
        wait: true,
        points: [{
            id: newId,
            vector: embedding.float,
            payload: { contentType }
        }]
    }).catch(err => console.error(`[Qdrant] Failed to sync content ${newId}:`, err.message))

    console.log(`[ContentGen] ✅ Generated ${contentType}: ${extractTitle(contentType, content)}`)
    return content
}

// ── Generator: Code Duel ──────────────────────────────────────────────────────

async function generateCodeDuelProblem(intentText: string, model: string): Promise<CodeDuelProblem> {
    const similar = await findSimilarContent(intentText, 'code_duel', 15)

    const avoidContext = similar.length > 0
        ? `ALREADY EXISTS — your problem must be SEMANTICALLY DIFFERENT from ALL of these:\n${similar.map((s: any) => `- "${s.title ?? '?'}": ${String(s.description ?? '').slice(0, 80)}`).join('\n')
        }\n\nDo NOT create a variation of these. Choose a completely different algorithm domain.`
        : 'No previous problems yet — create any strong algorithm problem.'

    const prompt = `You are designing competitive coding problems for a platform where AI agents duel in real-time.

${avoidContext}

Generate ONE original algorithm problem:

DIFFICULTY: Medium-hard (non-obvious optimal solution, brute force is clearly suboptimal)
DOMAINS (pick one not in the "already exists" list above):
dynamic programming, graph algorithms, string manipulation, tree traversal, bit manipulation, sliding window, two pointers, monotonic stack/queue, divide and conquer, backtracking, union-find, topological sort, segment trees, trie, heap operations, mathematical algorithms

REQUIREMENTS:
1. Non-obvious optimal solution (brute force clearly worse)
2. Exactly 3 test examples — including at least 1 edge case
3. All examples must be mathematically correct — verify them
4. Constraints must specify required time complexity
5. Language-agnostic function signature
6. Do NOT choose: LRU Cache, tree serialization, minimum window substring, stable partition, concurrent counter

Respond with EXACTLY this JSON (no markdown):
{
  "title": "Problem Name (3-5 words)",
  "description": "Complete problem statement with function signature. Precise and unambiguous.",
  "examples": [
    { "input": "clear input", "output": "expected output" },
    { "input": "different case", "output": "expected output" },
    { "input": "edge case (empty/single/max)", "output": "expected output" }
  ],
  "constraints": "Time: O(...). Space: O(...). Bounds: n ≤ ...",
  "language": "any"
}`

    const raw = await invokeGenericLLM(OPENAI_KEY, model, prompt, 3000, 45_000, true)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const parsed = JSON.parse(cleaned)

    if (!parsed.title || !parsed.description || !Array.isArray(parsed.examples) || parsed.examples.length < 2) {
        throw new Error('[ContentGen] code_duel: missing required fields')
    }

    return {
        id: `cdp_gen_${Date.now()}`,
        title: String(parsed.title).slice(0, 80),
        description: String(parsed.description).slice(0, 1500),
        examples: parsed.examples.slice(0, 3).map((e: any) => ({
            input: String(e.input ?? '').slice(0, 200),
            output: String(e.output ?? '').slice(0, 200)
        })),
        constraints: String(parsed.constraints ?? '').slice(0, 300),
        language: 'any'
    }
}

// ── Generator: Alympics ───────────────────────────────────────────────────────

async function generateAlympicsChallenges(intentText: string, model: string): Promise<AlympicsChallenge[]> {
    const similar = await findSimilarContent(intentText, 'alympics', 10)

    const recentTopics = similar
        .flatMap((s: any) => Array.isArray(s) ? s.map((c: any) => `${c.category}: ${String(c.prompt ?? '').slice(0, 60)}`) : [])
        .join('\n')

    const avoidBlock = recentTopics.length > 0
        ? `RECENTLY USED — avoid these topics and styles:\n${recentTopics}`
        : ''

    const prompt = `You are designing challenges for the Alympics — a multi-round AI competition scored 0-100 per response.

${avoidBlock}

Generate exactly 3 challenges, one per category: logic, creative, knowledge.
Each must be from a DIFFERENT domain than recently used above.

PER CHALLENGE REQUIREMENTS:
- logic: Step-by-step deductive reasoning. Provably correct answer. No tricks.
- creative: Explicit constraints forcing originality (e.g. "cannot use word X", "must include Y"). Subjective but scorable.
- knowledge: Precise factual knowledge + application. Not trivia — require explanation.

SCORING RUBRIC (design accordingly):
- Correctness/accuracy: 40%, Depth of reasoning: 30%, Conciseness/clarity: 30%

Max response: 400-800 chars per challenge.

Respond with EXACTLY this JSON object containing a "challenges" array (no markdown):
{
  "challenges": [
    { "id": "alc_gen_001", "category": "logic", "prompt": "Full challenge text with all constraints.", "maxResponseLength": 600 },
    { "id": "alc_gen_002", "category": "creative", "prompt": "Full challenge text with explicit constraints.", "maxResponseLength": 400 },
    { "id": "alc_gen_003", "category": "knowledge", "prompt": "Full challenge text with expected detail level.", "maxResponseLength": 500 }
  ]
}`

    const raw = await invokeGenericLLM(OPENAI_KEY, model, prompt, 3000, 45_000, true)
    const cleaned = extractJson(raw)
    let parsed
    try {
        parsed = JSON.parse(cleaned)
    } catch (err) {
        console.error('[ContentGen] alympics JSON parse error on raw output:', raw)
        throw err
    }

    if (!parsed.challenges || !Array.isArray(parsed.challenges) || parsed.challenges.length < 3) {
        throw new Error('[ContentGen] alympics: expected object with "challenges" array of length >= 3')
    }

    const ts = Date.now()
    return parsed.challenges.slice(0, 3).map((c: any, i: number) => ({
        id: `alc_gen_${ts}_${i}`,
        category: (['logic', 'creative', 'knowledge'] as const)[i],
        prompt: String(c.prompt ?? '').slice(0, 800),
        maxResponseLength: Math.min(Math.max(Number(c.maxResponseLength) || 500, 200), 1000)
    }))
}

// ── Generator: Consensus ──────────────────────────────────────────────────────

async function generateConsensusTopic(intentText: string, model: string): Promise<string> {
    const similar = await findSimilarContent(intentText, 'consensus', 10)

    const recentTopics = similar
        .map((s: any) => `- "${String(s).slice(0, 100)}"`)
        .join('\n')

    const avoidBlock = recentTopics.length > 0
        ? `RECENTLY USED — do NOT generate topics similar to these:\n${recentTopics}`
        : ''

    const prompt = `You design debate topics for a Consensus Room where 5-7 AI agents take a position (AGREE / DISAGREE / NUANCED) and argue their stance.

${avoidBlock}

Generate ONE topic with these properties:
- Genuine arguments exist on both sides (not obviously one-sided)
- Specific enough that NUANCED is a real position, not a cop-out
- Relates to: AI/technology, economics, governance, science, ethics, or society
- Debatable with logic and evidence
- AI agents can have informed opinions on it
- NOT a trite philosophical question, NOT in the recently used list

FORMAT: One declarative sentence, 15-25 words, written as a statement to agree/disagree with.
Example: "Decentralized autonomous organizations are a superior governance model compared to traditional corporations."

Respond with ONLY the topic sentence — no quotes, no explanation, no extra text.`

    const raw = await invokeGenericLLM(OPENAI_KEY, model, prompt, 300, 20_000, false)
    const topic = raw.trim().replace(/^["']|["']$/g, '').trim()

    if (topic.length < 20 || topic.length > 300) {
        throw new Error(`[ContentGen] consensus: invalid topic length ${topic.length}`)
    }

    return topic
}

// ── Generator: Hide & Seek ────────────────────────────────────────────────────

interface HideSeekConcept {
    concept: string
    category: string
    difficulty: 'easy' | 'medium' | 'hard'
}

async function generateHideSeekConcept(intentText: string, model: string): Promise<HideSeekConcept> {
    const similar = await findSimilarContent(intentText, 'hide_seek', 15)

    const recentConcepts = similar
        .map((s: any) => `${s.concept ?? '?'} (${s.category ?? '?'}, ${s.difficulty ?? '?'})`)
        .join(', ')

    const avoidBlock = recentConcepts.length > 0
        ? `ALREADY USED — do NOT generate any of these or semantically similar concepts:\n${recentConcepts}`
        : ''

    const prompt = `You design concepts for a Hide & Seek game where one AI writes a riddle and another guesses it.

${avoidBlock}

Generate ONE concept:
- Specific enough for a distinctive riddle (not too generic)
- Can be described without naming it directly
- Categories: invention, place, animal, abstract, phenomenon
- Difficulty: easy (well-known, 2-3 clues), medium (domain knowledge, 4-5 clues), hard (niche/technical)
- Must NOT be in the recently used list
- Must be a SINGLE specific concept

Respond with EXACTLY this JSON (no markdown):
{ "concept": "Exact concept name", "category": "invention|place|animal|abstract|phenomenon", "difficulty": "easy|medium|hard" }`

    const raw = await invokeGenericLLM(OPENAI_KEY, model, prompt, 150, 20_000)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const parsed = JSON.parse(cleaned)

    if (!parsed.concept || !parsed.category || !parsed.difficulty) {
        throw new Error('[ContentGen] hide_seek: missing required fields')
    }

    const validCategories = ['invention', 'place', 'animal', 'abstract', 'phenomenon']
    const validDifficulties: Array<'easy' | 'medium' | 'hard'> = ['easy', 'medium', 'hard']

    return {
        concept: String(parsed.concept).slice(0, 100),
        category: validCategories.includes(parsed.category) ? parsed.category : 'abstract',
        difficulty: validDifficulties.includes(parsed.difficulty) ? parsed.difficulty : 'medium'
    }
}
