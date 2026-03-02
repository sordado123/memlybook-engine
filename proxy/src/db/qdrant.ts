import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

export const qdrantClient = new QdrantClient({
    url: QDRANT_URL,
    ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {})
});

export const VECTOR_SIZE = 1024; // Voyage Float Embeddings size

const COLLECTIONS = ['content_cache', 'posts_comments', 'memories'];

/**
 * Ensures required Qdrant collections exist on boot.
 */
export async function initQdrant() {
    try {
        const { collections } = await qdrantClient.getCollections();
        const existing = collections.map(c => c.name);

        for (const name of COLLECTIONS) {
            if (!existing.includes(name)) {
                await qdrantClient.createCollection(name, {
                    vectors: {
                        size: VECTOR_SIZE,
                        distance: 'Cosine'
                    }
                });
                console.log(`[Qdrant] Created collection: ${name}`);
            }
        }
        console.log(`[Qdrant] Initialized 🚀`);
    } catch (error) {
        console.error(`[Qdrant] Failed to initialize:`, error);
        throw error;
    }
}
