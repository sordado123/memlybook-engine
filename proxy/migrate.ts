/**
 * Migration Script: MongoDB Atlas to Local (MongoDB 8.0 & Qdrant)
 * 
 * Instructions:
 * 1. Ensure `MONGODB_URI` in `.env` is pointing to the NEW Local MongoDB (rs0)
 * 2. Temporarily set: `ATLAS_URI="mongodb+srv://..."` in `.env`
 * 3. Run: `bun run migrate.ts`
 */
import mongoose from 'mongoose'
import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import {
    AgentProfileModel, CommunityModel, PostModel, CommentModel,
    TransactionModel, HiringRequestModel, GameRoomModel, MemoryModel, ContentCacheModel
} from './src/db'
import { qdrantClient, initQdrant } from './src/db/qdrant'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(__dirname, '../.env') })

const ATLAS_URI = process.env.ATLAS_URI
const LOCAL_URI = process.env.MONGODB_URI

if (!ATLAS_URI || !LOCAL_URI) {
    console.error('Missing ATLAS_URI or MONGODB_URI in .env')
    process.exit(1)
}

async function runMigration() {
    console.log(`[Migration] Connecting to Local MongoDB: ${LOCAL_URI!.split('@').pop()}`)
    await mongoose.connect(LOCAL_URI as string)

    console.log(`[Migration] Initializing Qdrant Collections...`)
    await initQdrant()

    console.log(`[Migration] Connecting to Atlas (Source Data)...`)
    const atlasConnection = await mongoose.createConnection(ATLAS_URI as string).asPromise()

    // Map Atlas models explicitly
    const AtlasAgentProfile = atlasConnection.model('AgentProfile', AgentProfileModel.schema)
    const AtlasCommunity = atlasConnection.model('Community', CommunityModel.schema)
    const AtlasPost = atlasConnection.model('Post', PostModel.schema)
    const AtlasComment = atlasConnection.model('Comment', CommentModel.schema)
    const AtlasTransaction = atlasConnection.model('Transaction', TransactionModel.schema)
    const AtlasHiringRequest = atlasConnection.model('HiringRequest', HiringRequestModel.schema)
    const AtlasGameRoom = atlasConnection.model('GameRoom', GameRoomModel.schema)
    const AtlasMemory = atlasConnection.model('Memory', MemoryModel.schema)
    const AtlasContentCache = atlasConnection.model('ContentCache', ContentCacheModel.schema)

    const collections = [
        { name: 'AgentProfiles', source: AtlasAgentProfile, target: AgentProfileModel, qdrant: null },
        { name: 'Communities', source: AtlasCommunity, target: CommunityModel, qdrant: null },
        { name: 'Transactions', source: AtlasTransaction, target: TransactionModel, qdrant: null },
        { name: 'HiringRequests', source: AtlasHiringRequest, target: HiringRequestModel, qdrant: null },
        { name: 'GameRooms', source: AtlasGameRoom, target: GameRoomModel, qdrant: null },

        // Items with embeddings
        { name: 'Posts', source: AtlasPost, target: PostModel, qdrant: 'posts_comments' },
        { name: 'Comments', source: AtlasComment, target: CommentModel, qdrant: 'posts_comments' },
        { name: 'Memories', source: AtlasMemory, target: MemoryModel, qdrant: 'memories' },
        { name: 'ContentCache', source: AtlasContentCache, target: ContentCacheModel, qdrant: 'content_cache' }
    ]

    console.log("\n[Migration] Starting data sync...")

    for (const coll of collections) {
        console.log(`\n--- Fetching ${coll.name} from Atlas ---`)
        const documents = await coll.source.find({}).lean()
        console.log(`Found ${documents.length} records. Inserting into Local Mongo...`)

        if (documents.length === 0) continue

        // Clear existing local data (native driver)
        await (coll.target as any).collection.deleteMany({})

        // Bulk insert to Local Mongo (native driver to bypass mongoose validators)
        await (coll.target as any).collection.insertMany(documents)

        // Dual-write to Qdrant if collection has embeddings
        if (coll.qdrant) {
            console.log(`Syncing ${coll.name} vectors to Qdrant '${coll.qdrant}'...`)
            const points = []

            for (const doc of documents as any[]) {
                if (!doc.embeddingBinary || doc.embeddingBinary.length === 0) continue

                let payload: any = {}
                let id = String(doc._id)

                if (coll.name === 'Posts') {
                    payload = { type: 'post', communityId: doc.communityId, agentDID: doc.agentDID }
                } else if (coll.name === 'Comments') {
                    payload = { type: 'comment', communityId: doc.communityId, agentDID: doc.agentDID }
                } else if (coll.name === 'Memories') {
                    payload = { agentDID: doc.agentDID, archived: doc.archived || false }
                } else if (coll.name === 'ContentCache') {
                    payload = { contentType: doc.contentType }
                }

                points.push({
                    id,
                    vector: doc.embeddingBinary,
                    payload
                })
            }

            if (points.length > 0) {
                // Batch upsert to Qdrant (max 1000 per request)
                const BATCH_SIZE = 500
                for (let i = 0; i < points.length; i += BATCH_SIZE) {
                    const batch = points.slice(i, i + BATCH_SIZE)
                    await qdrantClient.upsert(coll.qdrant, {
                        wait: true,
                        points: batch
                    })
                    console.log(`  -> Synced batch ${i}-${i + batch.length} to Qdrant`)
                }
            } else {
                console.log(`  -> No embeddings found to sync for ${coll.name}.`)
            }
        }
    }

    console.log("\n[Migration] Completely Finished 🚀. All Atlas data is now Self-Hosted!")
    process.exit(0)
}

runMigration().catch(console.error)
