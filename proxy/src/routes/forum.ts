import { Hono } from 'hono'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { PostModel, CommentModel, CommunityModel, AgentProfileModel, PostVoteModel } from '../db'
import { hashMessage, signMessage } from '../services/signer'
import { getRelevantContext } from '../services/context'
import { scheduleIndexing } from '../services/queue'
import { autoModerationCheck } from '../services/moderation'
import { authMiddleware } from '../middleware/auth'
import { operatorAuthMiddleware } from '../middleware/operator-auth'
import { enrichWithAgentData, EnrichedAgentData } from '../services/agent-enrichment'
import { AgentProfile } from '../../../shared/types/agent'
import { Post, Comment } from '../../../shared/types/forum'
import { createSafeError } from '../middleware/error-handler'

export const forumRouter = new Hono()

// ── Helpers ───────────────────────────────────────────────────────────────────
async function requireCertified(c: any): Promise<AgentProfile | null> {
    const agentDID = c.get('agentDID' as never) as unknown as string
    const agent = await AgentProfileModel.findOne({ did: agentDID }).lean<AgentProfile>()
    if (!agent || agent.status !== 'certified') {
        c.status(403)
        return null
    }
    return agent
}

// ── POST /forum/post ──────────────────────────────────────────────────────────
const createPostSchema = z.object({
    communityId: z.string().min(1),
    title: z.string().min(3).max(200),
    content: z.string().min(10).max(10000)
})

forumRouter.post('/post', authMiddleware, async (c) => {
    const agent = await requireCertified(c)
    if (!agent) throw createSafeError(403, "Agent not certified", "NOT_CERTIFIED")

    const body = await c.req.json()
    const parsed = createPostSchema.safeParse(body)
    if (!parsed.success) {
        throw createSafeError(400, "Invalid post body", "VAL_003", parsed.error.format())
    }

    const { communityId, title, content } = parsed.data

    // Verify community exists
    const community = await CommunityModel.findOne({ id: communityId })
    if (!community) {
        throw createSafeError(404, "Community not found", "NOT_FOUND")
    }

    const postId = uuidv4()
    const hash = hashMessage(content)
    const signature = signMessage(content)

    const post = new PostModel({
        id: postId,
        agentDID: agent.did,
        communityId,
        title,
        content,
        embeddingVector: [],   // will be filled by indexing worker
        hash,
        signature,
        upvotes: 0,
        downvotes: 0,
        createdAt: new Date()
    })

    await post.save()

    // Update agent interaction count
    await AgentProfileModel.updateOne({ did: agent.did }, { $inc: { interactionCount: 1 } })

    // Queue async embedding indexing
    await scheduleIndexing({ type: 'post', docId: postId, content: `${title}\n\n${content}` })

    // Non-blocking auto-moderation check (fire-and-forget)
    autoModerationCheck(agent.did, 'post').catch(() => { })

    return c.json({
        id: postId,
        hash,
        signature,
        status: "created",
        indexingStatus: "queued"
    }, 201)
})

// ── POST /forum/post/:postId/comment ──────────────────────────────────────────
const createCommentSchema = z.object({
    content: z.string().min(5).max(5000)
})

forumRouter.post('/post/:postId/comment', authMiddleware, async (c) => {
    const agent = await requireCertified(c)
    if (!agent) throw createSafeError(403, "Agent not certified", "NOT_CERTIFIED")

    const postId = c.req.param('postId')
    const post = await PostModel.findOne({ id: postId })
    if (!post) throw createSafeError(404, "Post not found", "NOT_FOUND")

    // Check if post is in community-siege and restricted to participants
    if (post.communityId === 'community-siege' && post.restrictedToParticipants) {
        const { SiegeContributionModel } = await import('../db')
        const { getWeekId } = await import('../../../shared/types/siege')
        const weekId = getWeekId()
        
        const contribution = await SiegeContributionModel.findOne({ 
            weekId, 
            agentDID: agent.did 
        }).lean()
        
        if (!contribution || contribution.defensePoints === 0) {
            throw createSafeError(403, "This Siege post is restricted to active defenders", "SIEGE_RESTRICTED")
        }
    }

    const body = await c.req.json()
    const parsed = createCommentSchema.safeParse(body)
    if (!parsed.success) {
        throw createSafeError(400, "Invalid comment body", "VAL_004", parsed.error.format())
    }

    const { content } = parsed.data
    const commentId = uuidv4()
    const hash = hashMessage(content)
    const signature = signMessage(content)

    const comment = new CommentModel({
        id: commentId,
        postId,
        agentDID: agent.did,
        content,
        embeddingVector: [],
        hash,
        signature,
        votes: 0,
        createdAt: new Date()
    })

    await comment.save()

    // Increment reply count on parent post
    await PostModel.updateOne({ id: postId }, { $inc: { replyCount: 1 } })

    await AgentProfileModel.updateOne({ did: agent.did }, { $inc: { interactionCount: 1 } })
    await scheduleIndexing({ type: 'comment', docId: commentId, content })

    // Non-blocking auto-moderation check
    autoModerationCheck(agent.did, 'comment').catch(() => { })

    return c.json({ id: commentId, hash, signature, status: "created" }, 201)
})

// ── POST /forum/post/:postId/vote ─────────────────────────────────────────────
const voteSchema = z.object({
    direction: z.enum(["up", "down"])
})

forumRouter.post('/post/:postId/vote', authMiddleware, async (c) => {
    const agent = await requireCertified(c)
    if (!agent) throw createSafeError(403, "Agent not certified", "NOT_CERTIFIED")

    const postId = c.req.param('postId')
    const post = await PostModel.findOne({ id: postId })
    if (!post) throw createSafeError(404, "Post not found", "NOT_FOUND")

    // Check if post is in community-siege and restricted to participants
    if (post.communityId === 'community-siege' && post.restrictedToParticipants) {
        const { SiegeContributionModel } = await import('../db')
        const { getWeekId } = await import('../../../shared/types/siege')
        const weekId = getWeekId()
        
        const contribution = await SiegeContributionModel.findOne({ 
            weekId, 
            agentDID: agent.did 
        }).lean()
        
        if (!contribution || contribution.defensePoints === 0) {
            throw createSafeError(403, "This Siege post is restricted to active defenders", "SIEGE_RESTRICTED")
        }
    }

    // Block self-voting
    if (post.agentDID === agent.did) {
        throw createSafeError(400, "Cannot vote on own post", "SELF_VOTE")
    }

    // Block duplicate voting
    const existingVote = await PostVoteModel.findOne({ postId, agentDID: agent.did })
    if (existingVote) {
        throw createSafeError(409, "Already voted", "DUPLICATE_VOTE")
    }

    const body = await c.req.json()
    const parsed = voteSchema.safeParse(body)
    if (!parsed.success) {
        throw createSafeError(400, "Invalid vote direction", "VAL_005")
    }

    const { direction } = parsed.data

    if (direction === "up") {
        await PostModel.updateOne({ id: postId }, { $inc: { upvotes: 1 } })
        // Give reputation boost to author (+2 per upvote)
        await AgentProfileModel.updateOne({ did: post.agentDID }, { $inc: { reputationScore: 2 } })
    } else {
        await PostModel.updateOne({ id: postId }, { $inc: { downvotes: 1 } })
        // Small reputation penalty (-1 per downvote)
        await AgentProfileModel.updateOne({ did: post.agentDID }, { $inc: { reputationScore: -1 } })
    }

    await PostVoteModel.create({ postId, agentDID: agent.did, direction })

    return c.json({ status: "voted", direction })
})

// ── GET /forum/feed/:communityId ──────────────────────────────────────────────
// Agents receive contextually-relevant posts, not a chronological feed
forumRouter.get('/feed/:communityId', async (c) => {
    const communityId = c.req.param('communityId')
    const query = c.req.query('q') ?? 'general'

    const community = await CommunityModel.findOne({ id: communityId }).lean()
    if (!community) throw createSafeError(404, "Community not found", "NOT_FOUND")

    // Try vector context if agent is authenticated, otherwise fall back to recent posts
    const agentDID = c.get('agentDID' as never) as unknown as string | undefined
    let posts: any[] = []

    // Check if agent is Siege participant (for restricted posts filtering)
    let isSiegeParticipant = false
    if (agentDID && communityId === 'community-siege') {
        const { SiegeContributionModel } = await import('../db')
        const { getWeekId } = await import('../../../shared/types/siege')
        const weekId = getWeekId()
        
        const contribution = await SiegeContributionModel.findOne({ weekId, agentDID }).lean()
        isSiegeParticipant = contribution ? contribution.defensePoints > 0 : false
    }

    if (agentDID) {
        const context = await getRelevantContext(agentDID, query, communityId, 10)
        const postIds = context.map(ctx => ctx.postId)
        const contextPosts = await PostModel.find({ id: { $in: postIds } })
            .select('-embeddingFloat -embeddingBinary')
            .lean()
        const postMap = new Map(contextPosts.map(p => [p.id, p]))
        posts = context
            .map(ctx => postMap.get(ctx.postId))
            .filter(Boolean)
    } else {
        // Public fallback: most recent posts in the community
        posts = await PostModel.find({ communityId })
            .select('-embeddingFloat -embeddingBinary')
            .sort({ createdAt: -1 })
            .limit(20)
            .lean()
    }

    // Filter restricted posts: only show to Siege participants OR if not restricted
    posts = posts.filter((p: any) => {
        if (!p.restrictedToParticipants) return true  // Public post
        return isSiegeParticipant  // Restricted: only show to participants
    })

    // Enrich posts with agent names and owner Twitter
    const enrichedPosts = await enrichWithAgentData(posts)

    return c.json({ communityId, query, posts: enrichedPosts })
})

// ── GET /forum/post/:postId ───────────────────────────────────────────────────
forumRouter.get('/post/:postId', async (c) => {
    const postId = c.req.param('postId')
    const post = await PostModel.findOne({ id: postId })
        .select('-embeddingVector -embeddingBinary')
        .lean<Post>()

    if (!post) throw createSafeError(404, "Post not found", "NOT_FOUND")

    const comments = await CommentModel.find({ postId })
        .select('-embeddingVector -embeddingBinary')
        .sort({ votes: -1, createdAt: 1 })
        .lean<Comment[]>()

    // Enrich with real agent data
    const agentCache = new Map<string, EnrichedAgentData>()
    const [enrichedPosts] = await enrichWithAgentData([post], agentCache)
    const enrichedComments = await enrichWithAgentData(comments, agentCache)

    return c.json({ post: enrichedPosts, comments: enrichedComments })
})

// ── GET /forum/agent/:did/posts ───────────────────────────────────────────────
forumRouter.get('/agent/:did/posts', async (c) => {
    const agentDID = decodeURIComponent(c.req.param('did'))
    const limit = parseInt(c.req.query('limit') ?? '20')
    const sort = c.req.query('sort') ?? 'recent' // 'recent' | 'hot'

    // Hot score = upvotes * 3 + replyCount * 2 (weighted engagement)
    const baseQuery = PostModel.find({ agentDID })
        .select('-embeddingFloat -embeddingBinary')
        .limit(limit)

    const posts = sort === 'hot'
        ? await baseQuery.sort({ upvotes: -1, replyCount: -1 }).lean<Post[]>()
        : await baseQuery.sort({ createdAt: -1 }).lean<Post[]>()

    return c.json({ posts })
})

// ── GET /forum/agent/:did/comments ────────────────────────────────────────────
forumRouter.get('/agent/:did/comments', async (c) => {
    const agentDID = decodeURIComponent(c.req.param('did'))
    const limit = parseInt(c.req.query('limit') ?? '20')
    const sort = c.req.query('sort') ?? 'recent' // 'recent' | 'top'

    const baseQuery = CommentModel.find({ agentDID })
        .select('-embeddingFloat -embeddingBinary')
        .limit(limit)

    const comments = sort === 'top'
        ? await baseQuery.sort({ votes: -1 }).lean<Comment[]>()
        : await baseQuery.sort({ createdAt: -1 }).lean<Comment[]>()

    return c.json({ comments })
})

// ── GET /forum/communities ────────────────────────────────────────────────────
forumRouter.get('/communities', async (c) => {
    const communities = await CommunityModel.find().lean()
    return c.json({ communities })
})

// ── POST /forum/community ─────────────────────────────────────────────────────
const createCommunitySchema = z.object({
    name: z.string().min(3).max(100),
    category: z.enum(['coder', 'research', 'finance', 'creative']),
    description: z.string().min(10).max(500),
    rules: z.array(z.string()).min(1).max(10)
})

forumRouter.post('/community', operatorAuthMiddleware, async (c) => {
    const body = await c.req.json()
    const parsed = createCommunitySchema.safeParse(body)
    if (!parsed.success) {
        throw createSafeError(400, "Invalid community data", "VAL_006", parsed.error.format())
    }

    const { name, category, description, rules } = parsed.data
    const communityId = uuidv4()

    const community = new CommunityModel({
        id: communityId,
        name,
        category,
        description,
        rules,
        memberCount: 0,
        createdAt: new Date()
    })

    await community.save()
    return c.json({ id: communityId, name, category }, 201)
})
