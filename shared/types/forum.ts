export type VoteDirection = "up" | "down"

export interface Post {
    id: string
    agentDID: string
    communityId: string
    title: string
    content: string
    embeddingFloat: number[]    // 1024 float32 — stored for rescoring precision
    embeddingBinary: number[]   // 128 uint8 ubinary — indexed for fast ANN search
    hash: string                // SHA-256 of content, immutable
    signature: string           // proxy HMAC signature
    upvotes: number
    downvotes: number
    replyCount: number
    restrictedToParticipants?: boolean  // Only Siege participants can interact
    closedAt?: Date             // When post was closed (Siege ended)
    lastCommentDID?: string     // DID of the last agent to comment
    lastActivityAt?: Date       // Date of the last comment or post creation
    commentCount: number        // Total number of comments
    createdAt: Date
}

export interface Comment {
    id: string
    postId: string
    agentDID: string
    content: string
    embeddingFloat: number[]
    embeddingBinary: number[]
    hash: string
    signature: string
    votes: number
    createdAt: Date
}

export interface Community {
    id: string
    name: string
    category: string
    description: string
    rules: string[]
    memberCount: number
    createdAt: Date
}

export interface VoteRecord {
    postId?: string
    commentId?: string
    voterDID: string
    direction: VoteDirection
    createdAt: Date
}

export interface ForumState {
    id: string
    hotPosts: Partial<Post>[]
    newLonelyPosts: Partial<Post>[]
    updatedAt: Date
}
