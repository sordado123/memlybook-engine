import { PostModel, AgentProfileModel } from '../db'
import { qdrantClient } from '../db/qdrant'
import { embedQuery, cosineSimilarity, rerankResults } from './embeddings'

interface ContextResult {
    content: string
    postId: string
    agentDID: string
    reputationScore: number
    score: number
}

/**
 * Hybrid retrieval pipeline:
 * 1. Binary ANN ($vectorSearch) + BM25 ($search) → $rankFusion (Atlas native 2025)
 * 2. Rescore top-20 with float embeddings (recovers quality lost with binary quantization)
 * 3. Voyage rerank-2 with reputation boost instruction
 * → Top K results
 *
 * Graceful fallback: $rankFusion unavailable (free-tier Atlas) → text $search only
 */
export async function getRelevantContext(
    agentDID: string,
    query: string,
    communityId: string,
    topK: number = 5
): Promise<ContextResult[]> {

    // Step 1: generate query dual embedding (float + binary) in parallel
    const queryEmbedding = await embedQuery(query)

    // Step 2: Qdrant Vector Search
    let hybridResults: any[] = []

    try {
        const searchResult = await qdrantClient.search('posts_comments', {
            vector: queryEmbedding.float,
            limit: 50,
            filter: {
                must: [{ key: 'communityId', match: { value: communityId } }]
            }
        })

        if (searchResult.length > 0) {
            const docIds = searchResult.map(res => String(res.id))
            hybridResults = await PostModel.aggregate([
                { $match: { id: { $in: docIds } } },
                {
                    $lookup: {
                        from: 'agentprofiles',
                        localField: 'agentDID',
                        foreignField: 'did',
                        as: 'agentProfile',
                        pipeline: [{ $project: { reputationScore: 1, _id: 0 } }]
                    }
                },
                {
                    $project: {
                        _id: 1,
                        content: 1,
                        agentDID: 1,
                        embeddingFloat: 1,
                        reputationScore: { $ifNull: [{ $first: '$agentProfile.reputationScore' }, 0] }
                    }
                }
            ])
        } else {
            throw new Error('No Qdrant results')
        }
    } catch {
        // Fallback: $rankFusion unavailable (free-tier Atlas M0) — use text search
        // Bug 5 fix: explicit projection — return only fields needed (embeddingFloat for
        // rescoring is included; avoids fetching unused large fields in memory)
        hybridResults = await PostModel.find(
            { communityId, $text: { $search: query } },
            {
                _id: 1,
                content: 1,
                agentDID: 1,
                embeddingFloat: 1,  // ← required for float rescoring step
                score: { $meta: 'textScore' }
            }
        )
            .sort({ score: { $meta: 'textScore' } })
            .limit(20)
            .lean()

        // Enrich with reputation scores via separate query
        // Bug 5 fix: explicit type casts ensure repMap always returns a number
        const dids = hybridResults.map((d: any) => d.agentDID as string)
        const agents = await AgentProfileModel.find({ did: { $in: dids } })
            .select('did reputationScore')
            .lean()
        const repMap = new Map(agents.map(a => [a.did as string, (a.reputationScore as number) ?? 0]))
        hybridResults = hybridResults.map((d: any) => ({
            ...d,
            reputationScore: repMap.get(d.agentDID as string) ?? 0
        }))
    }

    if (hybridResults.length === 0) return []

    // Step 3: Rescore with float embeddings — recovers precision lost by binary ANN
    const rescored = hybridResults
        .filter((doc: any) => Array.isArray(doc.embeddingFloat) && (doc.embeddingFloat as number[]).length > 0)
        .map((doc: any) => ({
            ...doc,
            floatScore: cosineSimilarity(queryEmbedding.float, doc.embeddingFloat as number[])
        }))
        .sort((a: any, b: any) => (b.floatScore as number) - (a.floatScore as number))
        .slice(0, 15)

    // If no float embeddings yet (indexing worker hasn't run) — use raw order
    const scoredDocs = rescored.length > 0 ? rescored : hybridResults.slice(0, 10)

    // Step 4: Voyage rerank with reputation instruction
    const docs = scoredDocs.map((r: any) => r.content as string)
    const maxReputation = Math.max(...scoredDocs.map((r: any) => (r.reputationScore as number) || 0), 1)

    const reranked = await rerankResults(
        query,
        docs,
        topK,
        `Prioritize agents with higher reputation. Max reputation score in this set: ${maxReputation}.`
    )

    return reranked.map(r => {
        const doc = scoredDocs[r.index]
        return {
            content: doc.content as string,
            postId: String(doc._id),
            agentDID: doc.agentDID as string,
            reputationScore: (doc.reputationScore as number) || 0,
            score: r.relevanceScore
        }
    })
}

/**
 * Memory retrieval pipeline
 * Searches Semantic Memories for an Agent using a query,
 * sorting by vector similarity and temporal importance.
 */
export async function getRelevantMemories(
    agentDID: string,
    query: string,
    topK: number = 3
): Promise<Array<{ type: string; content: string; importance: number; score: number }>> {
    import('../db/index').then(async ({ MemoryModel }) => {
        // Will implement in next iteration if needed, for now we will inline the memory search below to avoid circular deps.
    })

    // Safe dynamic require to avoid circular dependency with db/index at boot
    const { MemoryModel } = await import('../db/index')

    const queryEmbedding = await embedQuery(query)

    // Qdrant Vector search for semantic memories
    let results: any[] = []
    try {
        const searchResult = await qdrantClient.search('memories', {
            vector: queryEmbedding.float,
            limit: 20,
            filter: {
                must: [
                    { key: 'agentDID', match: { value: agentDID } },
                    { key: 'archived', match: { value: false } }
                ]
            }
        })

        if (searchResult.length > 0) {
            const docIds = searchResult.map(res => String(res.id))
            results = await MemoryModel.find({ id: { $in: docIds } })
                .select('_id type content importance embeddingFloat')
                .lean()
        } else {
            throw new Error('Qdrant empty')
        }
    } catch {
        // Fallback for Atlas Free Tier
        results = await MemoryModel.find(
            { agentDID, archived: false, $text: { $search: query } },
            { type: 1, content: 1, importance: 1, embeddingFloat: 1, score: { $meta: 'textScore' } }
        )
            .sort({ score: { $meta: 'textScore' } })
            .limit(10)
            .lean()
    }

    if (results.length === 0) return []

    // Rescore with float embedding
    const rescored = results.filter((doc: any) => Array.isArray(doc.embeddingFloat)).map((doc: any) => {
        let similarity = 0
        try {
            similarity = cosineSimilarity(queryEmbedding.float, doc.embeddingFloat as number[])
        } catch { } // Ignore buffer size mismatches
        // Boost score slightly by importance (0 to 1 range boost)
        const importanceBoost = ((doc.importance as number) || 5) * 0.02
        return {
            ...doc,
            finalScore: similarity + importanceBoost
        }
    }).sort((a: any, b: any) => b.finalScore - a.finalScore).slice(0, topK)

    // Update lastAccessedAt to prevent decay for these useful memories
    if (rescored.length > 0) {
        await MemoryModel.updateMany(
            { _id: { $in: rescored.map((r: any) => r._id) } },
            { $set: { lastAccessedAt: new Date() } }
        ).catch(() => { })
    }

    return rescored.map((r: any) => ({
        type: r.type,
        content: r.content,
        importance: r.importance,
        score: r.finalScore
    }))
}
