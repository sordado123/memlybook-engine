import { Worker, Job } from 'bullmq'
import { PostModel, CommentModel } from '../db'
import { embedDocument } from '../services/embeddings'
import { IndexingJob } from '../services/queue'
import { createWorkerConnection } from '../services/redis'
import { qdrantClient } from '../db/qdrant'

let indexingWorker: Worker | null = null

export function startIndexingWorker(): Worker {
    if (indexingWorker) return indexingWorker

    indexingWorker = new Worker<IndexingJob>(
        'forum-indexing',
        async (job: Job<IndexingJob>) => {
            const { type, docId, content } = job.data

            console.log(`[IndexingWorker] Processing ${type} ${docId}`)

            // Generate dual embedding: float (quality) + binary (speed)
            const dual = await embedDocument(content)

            let payload: Record<string, any> | null = null

            if (type === 'post') {
                const post = await PostModel.findOneAndUpdate(
                    { id: docId },
                    { $set: { embeddingFloat: dual.float, embeddingBinary: dual.binary } },
                    { returnDocument: 'after' }
                ).lean() as any
                if (post) payload = { agentDID: post.agentDID, communityId: post.communityId, type: 'post' }
            } else if (type === 'comment') {
                const comment = await CommentModel.findOneAndUpdate(
                    { id: docId },
                    { $set: { embeddingFloat: dual.float, embeddingBinary: dual.binary } },
                    { returnDocument: 'after' }
                ).lean() as any
                if (comment) payload = { agentDID: comment.agentDID, type: 'comment' }
            }

            // Sync with Qdrant
            if (payload) {
                await qdrantClient.upsert('posts_comments', {
                    wait: true,
                    points: [{
                        id: docId,
                        vector: dual.float,
                        payload
                    }]
                }).catch(err => console.error(`[Qdrant] Failed to sync ${type} ${docId}:`, err.message))
            }

            console.log(`[IndexingWorker] Indexed ${type} ${docId} — float:${dual.float.length}d (Qdrant synced)`)
        },
        {
            connection: createWorkerConnection(),
            concurrency: 3,         // Process up to 3 jobs in parallel
            limiter: {
                max: 10,
                duration: 1000        // max 10 jobs/sec to respect VoyageAI rate limits
            }
        }
    )

    indexingWorker.on('completed', (job) => {
        console.log(`[IndexingWorker] Job ${job.id} completed`)
    })

    indexingWorker.on('failed', (job, err) => {
        console.error(`[IndexingWorker] Job ${job?.id} failed:`, err.message)
    })

    return indexingWorker
}
