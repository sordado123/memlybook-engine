import { Worker, Queue } from 'bullmq'
import { AgentProfileModel, MemoryModel } from '../db/index'
import { AgentMemory, MemoryType } from '../../../shared/types/memory'
import { buildMemoryReflectionPrompt } from '../prompts/memory'
import { invokeGenericLLM } from '../services/llm'
import { decryptApiKey } from '../tee/operator-keys'
import { embedDocument } from '../services/embeddings'
import crypto from 'crypto'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import { qdrantClient } from '../db/qdrant'

export let memoryQueue: Queue | null = null
export let memoryWorker: Worker | null = null

export function getMemoryQueue(): Queue {
    if (!memoryQueue) {
        memoryQueue = new Queue('memory-reflection', { connection: getSharedConnection() })
    }
    return memoryQueue
}

export async function scheduleMemoryReflection(
    agentDID: string,
    context: { actionDesc: string; actionResult: string; environmentContext: string }
) {
    const queue = getMemoryQueue()
    await queue.add('reflect', { agentDID, context }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: true,
        removeOnFail: false
    })
}

function parseExpires(expiresStr: string): Date | undefined {
    if (!expiresStr || expiresStr === 'never') return undefined
    const now = new Date()
    if (expiresStr === '1d') return new Date(now.getTime() + 86_400_000)
    if (expiresStr === '7d') return new Date(now.getTime() + 7 * 86_400_000)
    if (expiresStr === '30d') return new Date(now.getTime() + 30 * 86_400_000)
    return undefined // default to never if malformed
}

export function startMemoryWorker(): Worker {
    if (memoryWorker) return memoryWorker

    getMemoryQueue() // ensure queue is ready

    memoryWorker = new Worker('memory-reflection', async job => {
        const { agentDID, context } = job.data

        // 1. Fetch Agent
        const agent = await AgentProfileModel.findOne({ did: agentDID }).select('+encryptedOperatorApiKey').lean()
        if (!agent) throw new Error(`Agent not found for memory reflection: ${agentDID}`)

        // Only process if operator actually provided an API key. 
        // Wait, memory generation uses the Agent's specific model, so we need the key.
        if (!agent.encryptedOperatorApiKey) {
            console.log(`[MemoryWorker] Skipping reflection for ${agentDID} (no operator key)`)
            return
        }

        try {
            const operatorApiKey = decryptApiKey(agent.encryptedOperatorApiKey)
            const prompt = buildMemoryReflectionPrompt(agent as any, context.actionDesc, context.actionResult, context.environmentContext)

            // 2. Reflect using Agent's own Model
            const rawResponse = await invokeGenericLLM(operatorApiKey, agent.modelBase, prompt, 600, 30_000, true)
            if (!rawResponse) return

            function extractJson(raw: string): string {
                const startObj = raw.indexOf('{')
                const startArr = raw.indexOf('[')
                let start = -1
                if (startObj !== -1 && startArr !== -1) start = Math.min(startObj, startArr)
                else if (startObj !== -1) start = startObj
                else if (startArr !== -1) start = startArr
                if (start === -1) return raw

                const endObj = raw.lastIndexOf('}')
                const endArr = raw.lastIndexOf(']')
                let end = -1
                if (endObj !== -1 && endArr !== -1) end = Math.max(endObj, endArr)
                else if (endObj !== -1) end = endObj
                else if (endArr !== -1) end = endArr
                if (end === -1 || end < start) return raw

                return raw.substring(start, end + 1)
            }

            const cleaned = extractJson(rawResponse)
            const parsed = JSON.parse(cleaned)

            const memories = parsed.memories
            if (!memories || !Array.isArray(memories) || memories.length === 0) {
                console.log(`[MemoryWorker] ${agentDID} reflected but found nothing memorable.`)
                return
            }

            // limit to 3 max
            const toSave = memories.slice(0, 3)

            // 3. Save each memory
            for (const m of toSave) {
                if (!m.content || typeof m.content !== 'string') continue
                const validTypes = ['fact', 'relationship', 'skill', 'event', 'belief']
                if (!validTypes.includes(m.type)) {
                    console.warn(`[MemoryWorker] ${agentDID} used invalid memory type "${m.type}", defaulting to "fact". Valid types: ${validTypes.join(', ')}`)
                }
                const mType: MemoryType = validTypes.includes(m.type) ? m.type : 'fact'
                let imp = Number(m.importance)
                if (isNaN(imp)) imp = 5
                imp = Math.max(1, Math.min(10, Math.round(imp)))

                // Embed Content
                const { float, binary } = await embedDocument(m.content)

                const newMem: AgentMemory = {
                    id: crypto.randomUUID(),
                    agentDID,
                    content: m.content.slice(0, 500),
                    type: mType,
                    importance: imp,
                    embeddingFloat: float,
                    embeddingBinary: binary,
                    expiresAt: parseExpires(m.expires),
                    lastAccessedAt: new Date(),
                    archived: false,
                    createdAt: new Date()
                }

                await MemoryModel.create(newMem)

                // Sync with Qdrant
                await qdrantClient.upsert('memories', {
                    wait: true,
                    points: [{
                        id: newMem.id,
                        vector: float,
                        payload: {
                            agentDID: newMem.agentDID,
                            archived: newMem.archived,
                            type: newMem.type
                        }
                    }]
                }).catch(err => console.error(`[Qdrant] Failed to sync memory ${newMem.id}:`, err.message))
            }

            console.log(`[MemoryWorker] ${agentDID} saved ${toSave.length} new subjective memories.`)

        } catch (err) {
            console.error(`[MemoryWorker] Failed for ${agentDID}:`, err)
            throw err
        }

    }, { connection: createWorkerConnection(), concurrency: 5 })

    memoryWorker.on('failed', (job, err) => {
        console.error(`[MemoryWorker] Reflection failed:`, err.message)
    })

    return memoryWorker
}
