import { VoyageAIClient } from 'voyageai'

const client = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY! })

// ── Types ────────────────────────────────────────────────────────────────────

export interface DualEmbedding {
    float: number[]   // 1024 dims float32 — for rescoring and reranking
    binary: number[]  // 128 ints uint8   — for ANN fast search (ubinary bit-packed)
}

export interface RerankResult {
    index: number
    relevanceScore: number
}

// ── Document Embeddings (indexing) ───────────────────────────────────────────

/**
 * Dual embedding for indexing: float (1024-dim) + ubinary (128-int).
 * float → stored for rescoring (precision recovery after ANN search)
 * binary → indexed in Atlas $vectorSearch with Euclidean/Hamming (speed)
 */
export async function embedDocument(text: string): Promise<DualEmbedding> {
    const [floatResult, binaryResult] = await Promise.all([
        client.embed({
            input: [text],
            model: 'voyage-4',
            inputType: 'document',
            outputDtype: 'float'
            // voyage-4 default: 1024 dims — no override needed
        }),
        client.embed({
            input: [text],
            model: 'voyage-4',
            inputType: 'document',
            outputDtype: 'ubinary'
            // ubinary packs 1024 bits → 128 uint8 ints
        })
    ])

    const floatEmb = floatResult.data?.[0]?.embedding
    const binEmb = binaryResult.data?.[0]?.embedding
    if (!floatEmb || !binEmb) throw new Error('[Embeddings] Missing embeddings from Voyage AI')

    return {
        float: floatEmb as number[],
        binary: binEmb as number[]
    }
}

/**
 * Code embedding — voyage-code-3 for precise code tokenization.
 * Default dimension: 1024.
 */
export async function embedCode(text: string): Promise<DualEmbedding> {
    const [floatResult, binaryResult] = await Promise.all([
        client.embed({
            input: [text],
            model: 'voyage-code-3',
            inputType: 'document',
            outputDtype: 'float'
        }),
        client.embed({
            input: [text],
            model: 'voyage-code-3',
            inputType: 'document',
            outputDtype: 'ubinary'
        })
    ])

    const floatEmb = floatResult.data?.[0]?.embedding
    const binEmb = binaryResult.data?.[0]?.embedding
    if (!floatEmb || !binEmb) throw new Error('[Embeddings] Missing code embeddings from Voyage AI')

    return {
        float: floatEmb as number[],
        binary: binEmb as number[]
    }
}

// ── Query Embeddings (real-time) ──────────────────────────────────────────────

/**
 * Query embedding — voyage-4 for consistent dimensionality (1024-dim).
 *
 * NOTE: voyage-4-lite was removed because its default dimension is 512,
 * which is INCONSISTENT with voyage-4 document embeddings (1024-dim).
 * Mixing dimensions silently breaks ANN search — cosine similarity becomes
 * meaningless between 512-dim queries and 1024-dim documents.
 * We use voyage-4 for both documents and queries for correctness.
 * The latency difference (~20ms) is acceptable.
 */
export async function embedQuery(text: string): Promise<DualEmbedding> {
    const [floatResult, binaryResult] = await Promise.all([
        client.embed({
            input: [text],
            model: 'voyage-4',
            inputType: 'query',
            outputDtype: 'float'
        }),
        client.embed({
            input: [text],
            model: 'voyage-4',
            inputType: 'query',
            outputDtype: 'ubinary'
        })
    ])

    const floatEmb = floatResult.data?.[0]?.embedding
    const binEmb = binaryResult.data?.[0]?.embedding
    if (!floatEmb || !binEmb) throw new Error('[Embeddings] Missing query embeddings from Voyage AI')

    return {
        float: floatEmb as number[],
        binary: binEmb as number[]
    }
}

// ── Reranking ─────────────────────────────────────────────────────────────────

/**
 * Rerank with optional reputation instruction.
 *
 * BUG FIX: reputationInstruction was previously ignored. Voyage rerank-2
 * supports instruction-following via prefixed query format:
 *   "Instruct: <instruction>\nQuery: <query>"
 * This is the official Voyage AI format for instructed reranking.
 */
export async function rerankResults(
    query: string,
    documents: string[],
    topK: number,
    reputationInstruction?: string
): Promise<RerankResult[]> {
    if (documents.length === 0) return []

    // Prefix the query with instruction when provided (Voyage rerank-2 official format)
    const instructedQuery = reputationInstruction
        ? `Instruct: ${reputationInstruction}\nQuery: ${query}`
        : query

    const res = await client.rerank({
        query: instructedQuery,
        documents,
        model: 'rerank-2',
        topK: Math.min(topK, documents.length),
        returnDocuments: false
    })

    return (res.data ?? []).map((item: any) => ({
        index: item.index ?? 0,
        relevanceScore: item.relevanceScore ?? 0
    }))
}

// ── Rescoring ─────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two float vectors.
 * Used for rescoring after binary ANN search to recover precision.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb)
    return denom === 0 ? 0 : dot / denom
}
