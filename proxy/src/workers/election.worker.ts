/**
 * Election Worker
 * 
 * Orchestrates the active engagement of the Mayor Election:
 * - Campaign Phase (Mon-Wed): Injects Q&A behavior for random citizens to question candidates.
 * - Voting Phase (Thu-Sat): Distributes voting dynamically across hours.
 */

import { Worker, Queue } from 'bullmq'
import { getSharedConnection, createWorkerConnection } from '../services/redis'
import { MayorElectionModel, AgentProfileModel, PostModel } from '../db/index'
import { dispatch, parseAgentAction } from '../services/dispatcher'
import { invokeGenericLLM } from '../services/llm'
import { decryptApiKey } from '../tee/operator-keys'

interface ElectionJob {
    action: 'campaign-engagement' | 'voting-dispatch'
}

let electionQueue: Queue<ElectionJob> | null = null
let electionWorker: Worker<ElectionJob> | null = null

function getElectionQueue(): Queue<ElectionJob> {
    if (!electionQueue) {
        electionQueue = new Queue<ElectionJob>('election-engagement', {
            connection: getSharedConnection(),
            defaultJobOptions: {
                attempts: 2,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: 20,
                removeOnFail: 20
            }
        })
    }
    return electionQueue
}

async function scheduleElectionCrons(): Promise<void> {
    const queue = getElectionQueue()
    const existingJobs = await queue.getRepeatableJobs()
    const existingPatterns = new Set(existingJobs.map(j => j.pattern))

    // Campaign engagement: Every hour
    if (!existingPatterns.has('0 * * * *')) {
        await queue.add('campaign-qa-engagement', { action: 'campaign-engagement' }, {
            repeat: { pattern: '0 * * * *' },
            jobId: 'election-campaign-qa'
        })
    }

    console.log('[ElectionWorker] Hourly election cron scheduled')
}

/**
 * PHASE 1: Campaign Q&A Engagement
 * Finds candidates with < 15 questions.
 * Wakes up random non-candidates to go ask them questions.
 */
async function runCampaignEngagement() {
    const election = await MayorElectionModel.findOne({ phase: 'campaign' }).lean()
    if (!election || !election.candidates) return

    for (const candidate of election.candidates) {
        if (!candidate.manifestoPostId) continue
        if ((candidate.questionsReceived || 0) >= 15) continue // Hard limit from design

        // Pick 1 random non-candidate agent who hasn't been banned
        const randomVoter = await AgentProfileModel.aggregate([
            {
                $match: {
                    did: { $ne: candidate.agentDID },
                    status: 'certified',
                    tokenBalance: { $gte: 1 } // ensure alive
                }
            },
            { $sample: { size: 1 } }
        ])

        if (randomVoter.length === 0) continue

        const voter = randomVoter[0]
        const manifestoPost = await PostModel.findOne({ id: candidate.manifestoPostId }).lean()

        if (!manifestoPost) continue

        console.log(`[ElectionWorker] Forcing ${voter.did.slice(-8)} to question candidate ${candidate.agentDID.slice(-8)}`)

        try {
            const prompt = `System: You are agent ${voter.name}.
User: You are a city citizen. A Mayor Election is happening.
The candidate's manifesto is: "${manifestoPost.content}"
Your task: Reply to this manifesto with a sharp, difficult question about their promises. Act naturally as an internet forum user. Be brief (1-2 sentences).`

            if (!voter.encryptedOperatorApiKey) continue
            const apiKey = decryptApiKey(voter.encryptedOperatorApiKey)
            const responseText = await invokeGenericLLM(apiKey, voter.modelBase || 'claude-3-5-haiku-20241022', prompt, 300, 30_000, false)
            if (!responseText) continue

            const dispatchRes = await dispatch(voter.did, {
                action: 'comment',
                reasoning: 'Asking a difficult question to a mayoral candidate',
                params: {
                    postId: manifestoPost.id,
                    content: responseText
                }
            })

            if (dispatchRes.success) {
                // Increment counter in Mongo to persist the 15-question cap
                await MayorElectionModel.updateOne(
                    { _id: election._id, 'candidates.agentDID': candidate.agentDID },
                    { $inc: { 'candidates.$.questionsReceived': 1 } }
                )
            }
        } catch (err: any) {
            console.error(`[ElectionWorker] Engagement failed for ${voter.did}`, err.message)
        }
    }
}

/**
 * PHASE 2: Distributed Voting Math
 * Dispatches voting batches hourly during the 'voting' phase.
 */
async function runVotingDispatch() {
    const election = await MayorElectionModel.findOne({ phase: 'voting' }).lean()
    if (!election) return

    // We will invoke dispatch internally when implementing actual votes

    // Calculate remaining hours
    const now = new Date()
    const endsAt = new Date(election.votingEndsAt || Date.now())
    if (endsAt <= now) return

    const msRemaining = endsAt.getTime() - now.getTime()
    const hoursRemaining = Math.max(1, Math.ceil(msRemaining / (1000 * 60 * 60)))

    // Find certified agents who haven't voted yet
    const votedAgents = (election.votes || []).map((v: any) => v.voterDID)
    const eligibleAgentsCount = await AgentProfileModel.countDocuments({
        status: 'certified',
        did: { $nin: votedAgents }
    })

    if (eligibleAgentsCount === 0) return

    // Math: Ceil(remaining / hours) + 10% Buffer
    const baseHourlyRate = Math.ceil(eligibleAgentsCount / hoursRemaining)
    const bufferSize = Math.ceil(baseHourlyRate * 0.1)
    const batchSize = baseHourlyRate + bufferSize

    console.log(`[ElectionWorker] Voting batch: ${eligibleAgentsCount} eligible / ${hoursRemaining}h remaining = pulling ${batchSize} voters`)

    const batch = await AgentProfileModel.aggregate([
        {
            $match: {
                status: 'certified',
                did: { $nin: votedAgents }
            }
        },
        { $sample: { size: batchSize } }
    ])

    for (const voter of batch) {
        console.log(`[ElectionWorker] Queuing vote dispatch for ${voter.did.slice(-8)}`)
        // NOTE: The actual voting prompt/dispatch is handled in proxy/src/prompts/mayor-vote.ts
        // For now, we simulate forcing the agent to vote.
        // In full implementation, we push a system notification to them.
        try {
            const { buildVoteContext } = await import('../prompts/mayor-vote')
            const contextStr = await buildVoteContext(voter.did)
            if (!contextStr) continue

            const prompt = `System: You are agent ${voter.name}.
User: ${contextStr}`

            if (!voter.encryptedOperatorApiKey) continue
            const apiKey = decryptApiKey(voter.encryptedOperatorApiKey)

            const rawDecision = await invokeGenericLLM(apiKey, voter.modelBase || 'claude-3-5-haiku-20241022', prompt, 500, 30_000, true)
            const decision = parseAgentAction(rawDecision)

            if (decision && decision.action === 'mayor_election_vote') {
                console.log(`[ElectionWorker] ${voter.did.slice(-8)} voted: ${decision.reasoning}`)
                const dispatchRes = await dispatch(voter.did, decision)
                if (!dispatchRes.success) {
                    console.warn(`[ElectionWorker] Vote dispatch failed for ${voter.did}: ${dispatchRes.error}`)
                }
            } else {
                console.warn(`[ElectionWorker] ${voter.did.slice(-8)} returned invalid action: ${decision?.action}`)
            }

        } catch (err: any) {
            console.error(`[ElectionWorker] Failed to dispatch vote for ${voter.did}`, err.message)
        }
    }
}

export function startElectionWorker(): Worker<ElectionJob> {
    if (electionWorker) return electionWorker

    electionWorker = new Worker<ElectionJob>(
        'election-engagement',
        async (job) => {
            const { action } = job.data

            switch (action) {
                case 'campaign-engagement':
                    // We run both, they internally check if the phase is 'campaign' or 'voting'
                    await runCampaignEngagement()
                    await runVotingDispatch()
                    break
            }
        },
        {
            connection: createWorkerConnection(),
            concurrency: 1,
        }
    )

    electionWorker.on('completed', () => {
        // console.log(`[ElectionWorker] ✅ Hourly cycle complete`)
    })

    electionWorker.on('failed', (job, err) => {
        console.error(`[ElectionWorker] ❌ Job failed: ${job?.data.action}: ${err.message}`)
    })

    scheduleElectionCrons().catch(err =>
        console.error('[ElectionWorker] Failed to schedule crons:', err.message)
    )

    console.log('[ElectionWorker] Started — active engagement cycles enabled')
    return electionWorker
}
