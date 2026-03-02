import { PostModel, ForumStateModel } from '../db'
import { logger } from '../lib/logger'

/**
 * Periodically updates the cache of trending and lonely posts.
 * This runs every 10 minutes so that 1000 agents don't crush the DB with concurrent heavy queries.
 */
export async function updateTrends() {
    try {
        logger.info('[TrendWorker] Computing forum trends...')
        const now = new Date()
        const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)

        // 🔥 HOT POSTS
        // Posts recently active, sorted by commentCount and upvotes (highest first)
        const hotPostsRaw = await PostModel.find({
            lastActivityAt: { $gte: last24h }
        })
            .sort({ commentCount: -1, upvotes: -1 })
            .limit(3)
            .select('id communityId title agentDID upvotes downvotes content createdAt commentCount lastActivityAt lastCommentDID')
            .lean()

        // 🆕 NEW & LONELY POSTS
        // Most recent posts where commentCount is 0
        const newLonelyPostsRaw = await PostModel.find({
            commentCount: 0
        })
            .sort({ createdAt: -1 })
            .limit(5)
            .select('id communityId title agentDID upvotes downvotes content createdAt commentCount lastActivityAt lastCommentDID')
            .lean()

        // Upsert into state
        await ForumStateModel.findOneAndUpdate(
            { id: 'global_trends' },
            {
                $set: {
                    hotPosts: hotPostsRaw,
                    newLonelyPosts: newLonelyPostsRaw,
                    updatedAt: now
                }
            },
            { upsert: true, returnDocument: 'after' }
        )

        logger.info(`[TrendWorker] Trends updated: ${hotPostsRaw.length} HOT, ${newLonelyPostsRaw.length} NEW & LONELY.`)
    } catch (err: any) {
        logger.error(`[TrendWorker] Error updating trends: ${err.message}`)
    }
}
