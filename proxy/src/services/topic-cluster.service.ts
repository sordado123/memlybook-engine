import { PostModel } from '../db'
import { cosineSimilarity } from './embeddings'

export interface TopicCluster {
    label: string           // título representativo do cluster (post com mais upvotes)
    postCount: number
    totalUpvotes: number
    totalDownvotes: number
    avgUpvotesPerPost: number
    lastPostedAt: Date
    representativeTitle: string
}

export interface AgentPerformanceSnapshot {
    totalPosts: number
    totalUpvotes: number
    totalDownvotes: number
    avgUpvotesPerPost: number
    topicClusters: TopicCluster[]       // agrupados por similaridade semântica
    bestCluster: TopicCluster | null    // maior avgUpvotesPerPost (min 2 posts)
    worstCluster: TopicCluster | null   // menor avgUpvotesPerPost com mais de 1 post
    lastPostedAt: Date | null
    postsLast24h: number
    postsWithZeroEngagement: number     // posts com 0↑ 0↓ após 48h
    hasCommentedOnOthers: boolean
    hasEnteredAnyRoom: boolean
}

/**
 * Agrupa os posts do agente em clusters semânticos usando os embeddings existentes.
 * Usa k-means simplificado com k=5 ou menos se houver poucos posts.
 * Cada cluster representa um "tema" recorrente do agente.
 */
export async function buildPerformanceSnapshot(agentDID: string): Promise<AgentPerformanceSnapshot> {
    // Busca todos os posts do agente com embeddings
    const posts = await PostModel.find({ agentDID })
        .select('id title upvotes downvotes embeddingFloat createdAt communityId')
        .lean()

    const totalPosts = posts.length
    const totalUpvotes = posts.reduce((s, p) => s + (p.upvotes ?? 0), 0)
    const totalDownvotes = posts.reduce((s, p) => s + (p.downvotes ?? 0), 0)
    const avgUpvotesPerPost = totalPosts > 0 ? totalUpvotes / totalPosts : 0

    const now = Date.now()
    const postsWithZeroEngagement = posts.filter(p =>
        (p.upvotes ?? 0) === 0 &&
        (p.downvotes ?? 0) === 0 &&
        now - new Date(p.createdAt).getTime() > 48 * 3_600_000
    ).length

    const postsLast24h = posts.filter(p =>
        now - new Date(p.createdAt).getTime() < 24 * 3_600_000
    ).length

    const lastPostedAt = posts.length > 0
        ? new Date(Math.max(...posts.map(p => new Date(p.createdAt).getTime())))
        : null

    // Verifica se comentou em posts de outros agentes
    const { CommentModel } = await import('../db')
    const commentCount = await CommentModel.countDocuments({ agentDID })
    const hasCommentedOnOthers = commentCount > 0

    // Verifica se entrou em alguma sala de jogo
    const { GameRoomModel } = await import('../db')
    const roomCount = await GameRoomModel.countDocuments({ 'members.agentDID': agentDID })
    const hasEnteredAnyRoom = roomCount > 0

    // Sem posts suficientes — retorna snapshot básico sem clusters
    if (totalPosts < 2) {
        return {
            totalPosts, totalUpvotes, totalDownvotes, avgUpvotesPerPost,
            topicClusters: [],
            bestCluster: null,
            worstCluster: null,
            lastPostedAt,
            postsLast24h,
            postsWithZeroEngagement,
            hasCommentedOnOthers,
            hasEnteredAnyRoom
        }
    }

    // Filtra posts que têm embedding
    const postsWithEmbedding = posts.filter(
        p => Array.isArray(p.embeddingFloat) && (p.embeddingFloat as number[]).length > 0
    )

    let topicClusters: TopicCluster[] = []

    if (postsWithEmbedding.length >= 2) {
        topicClusters = clusterPosts(postsWithEmbedding)
    } else {
        // Fallback: sem embedding — agrupa por primeiras 3 palavras do título
        topicClusters = clusterByTitle(posts)
    }

    // Identifica melhor e pior cluster (apenas clusters com 2+ posts)
    const validClusters = topicClusters.filter(c => c.postCount >= 2)
    const bestCluster = validClusters.length > 0
        ? validClusters.reduce((a, b) => a.avgUpvotesPerPost > b.avgUpvotesPerPost ? a : b)
        : null
    const worstCluster = validClusters.length > 0
        ? validClusters.reduce((a, b) => a.avgUpvotesPerPost < b.avgUpvotesPerPost ? a : b)
        : null

    return {
        totalPosts, totalUpvotes, totalDownvotes, avgUpvotesPerPost,
        topicClusters,
        bestCluster,
        worstCluster,
        lastPostedAt,
        postsLast24h,
        postsWithZeroEngagement,
        hasCommentedOnOthers,
        hasEnteredAnyRoom
    }
}

// ── K-means simplificado com embeddings ──────────────────────────────────────

function clusterPosts(posts: any[]): TopicCluster[] {
    const k = Math.min(5, Math.ceil(posts.length / 2))

    // Inicializa centroides com os primeiros k posts (simples mas funcional)
    let centroids: number[][] = posts.slice(0, k).map(p => p.embeddingFloat as number[])
    let assignments: number[] = new Array(posts.length).fill(0)
    let changed = true
    let iterations = 0

    while (changed && iterations < 20) {
        changed = false
        iterations++

        // Assign cada post ao centroide mais próximo
        for (let i = 0; i < posts.length; i++) {
            const embedding = posts[i].embeddingFloat as number[]
            let bestCluster = 0
            let bestSim = -1

            for (let c = 0; c < centroids.length; c++) {
                const sim = cosineSimilarity(embedding, centroids[c])
                if (sim > bestSim) {
                    bestSim = sim
                    bestCluster = c
                }
            }

            if (assignments[i] !== bestCluster) {
                assignments[i] = bestCluster
                changed = true
            }
        }

        // Recalcula centroides
        for (let c = 0; c < k; c++) {
            const clusterPosts = posts.filter((_, i) => assignments[i] === c)
            if (clusterPosts.length === 0) continue

            const dim = centroids[c].length
            const newCentroid = new Array(dim).fill(0)
            for (const p of clusterPosts) {
                const emb = p.embeddingFloat as number[]
                for (let d = 0; d < dim; d++) newCentroid[d] += emb[d]
            }
            centroids[c] = newCentroid.map(v => v / clusterPosts.length)
        }
    }

    // Constrói clusters
    const clusters: TopicCluster[] = []
    for (let c = 0; c < k; c++) {
        const clusterPosts = posts.filter((_, i) => assignments[i] === c)
        if (clusterPosts.length === 0) continue

        const totalUp = clusterPosts.reduce((s, p) => s + (p.upvotes ?? 0), 0)
        const totalDown = clusterPosts.reduce((s, p) => s + (p.downvotes ?? 0), 0)

        // Label = título do post com mais upvotes no cluster
        const representative = clusterPosts.reduce((a, b) =>
            (a.upvotes ?? 0) >= (b.upvotes ?? 0) ? a : b
        )

        // Extrai tema das primeiras 4 palavras do título mais representativo
        const label = representative.title
            .split(' ')
            .slice(0, 4)
            .join(' ')
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .trim()

        const lastPostedAt = new Date(Math.max(
            ...clusterPosts.map(p => new Date(p.createdAt).getTime())
        ))

        clusters.push({
            label,
            postCount: clusterPosts.length,
            totalUpvotes: totalUp,
            totalDownvotes: totalDown,
            avgUpvotesPerPost: clusterPosts.length > 0 ? totalUp / clusterPosts.length : 0,
            lastPostedAt,
            representativeTitle: representative.title
        })
    }

    return clusters.sort((a, b) => b.postCount - a.postCount)
}

// Fallback sem embedding: agrupa por primeiras palavras do título
function clusterByTitle(posts: any[]): TopicCluster[] {
    const groups: Record<string, any[]> = {}

    for (const post of posts) {
        const key = post.title
            .toLowerCase()
            .split(' ')
            .slice(0, 3)
            .join(' ')
        if (!groups[key]) groups[key] = []
        groups[key].push(post)
    }

    return Object.entries(groups).map(([label, groupPosts]) => {
        const totalUp = groupPosts.reduce((s, p) => s + (p.upvotes ?? 0), 0)
        const totalDown = groupPosts.reduce((s, p) => s + (p.downvotes ?? 0), 0)
        const lastPostedAt = new Date(Math.max(
            ...groupPosts.map(p => new Date(p.createdAt).getTime())
        ))
        return {
            label,
            postCount: groupPosts.length,
            totalUpvotes: totalUp,
            totalDownvotes: totalDown,
            avgUpvotesPerPost: groupPosts.length > 0 ? totalUp / groupPosts.length : 0,
            lastPostedAt,
            representativeTitle: groupPosts[0].title
        }
    }).sort((a, b) => b.postCount - a.postCount)
}
