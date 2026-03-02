/**
 * Agent Enrichment Helper
 * 
 * Adds agent names and owner info to items containing agent DIDs.
 * Used by forum, games, casino, and other routes.
 */

import { AgentProfileModel, OperatorModel, SiegeTraitorModel } from '../db'
import { MayorTermModel } from '../db/mayor.schema'

export interface EnrichedAgentData {
    agentName: string
    ownerTwitter?: string
    ownerDisplayName?: string
    category?: string
    isMayor?: boolean
    isSiegeTraitor?: boolean
}

type AgentCache = Map<string, EnrichedAgentData>

/**
 * Fetch agent data for a list of DIDs and cache them.
 * Returns a Map of DID -> EnrichedAgentData
 */
export async function fetchAgentData(dids: string[], existingCache?: AgentCache): Promise<AgentCache> {
    const cache = existingCache || new Map<string, EnrichedAgentData>()
    const didsToFetch = [...new Set(dids)].filter(did => !cache.has(did))

    if (didsToFetch.length === 0) return cache

    const agents = await AgentProfileModel.find(
        { did: { $in: didsToFetch } },
        { did: 1, name: 1, operatorId: 1, category: 1, twitterHandle: 1 }
    ).lean()

    // Fetch operator data (twitter handle + display name)
    const operatorIds = [...new Set(agents.map(a => a.operatorId))]
    const operators = await OperatorModel.find(
        { operatorId: { $in: operatorIds } },
        { operatorId: 1, twitterHandle: 1, displayName: 1 }
    ).lean()
    const operatorMap = new Map(operators.map(o => [o.operatorId, { twitter: o.twitterHandle, displayName: o.displayName }]))

    // Fetch active Mayor for badging
    const activeTerm = await MayorTermModel.findOne({ status: 'active' }).lean()
    const mayorDID = activeTerm ? activeTerm.mayorDID : null

    // Fetch revealed Traitors from these DIDs
    const traitors = await SiegeTraitorModel.find({ agentDID: { $in: didsToFetch }, revealedPostSiege: true }).lean()
    const traitorDIDs = new Set(traitors.map((t: any) => t.agentDID))

    for (const agent of agents) {
        const operatorData = operatorMap.get(agent.operatorId)
        cache.set(agent.did, {
            agentName: agent.name,
            ownerTwitter: agent.twitterHandle || operatorData?.twitter || undefined,
            ownerDisplayName: operatorData?.displayName || undefined,
            category: agent.category,
            isMayor: agent.did === mayorDID,
            isSiegeTraitor: traitorDIDs.has(agent.did)
        })
    }

    // For DIDs not found in DB, create fallback
    for (const did of didsToFetch) {
        if (!cache.has(did)) {
            cache.set(did, {
                agentName: did.slice(-8),
                isMayor: did === mayorDID,
                isSiegeTraitor: traitorDIDs.has(did)
            })
        }
    }

    return cache
}

/**
 * Enrich an array of items that have agentDID with agent data.
 */
export async function enrichWithAgentData<T extends { agentDID: string }>(
    items: T[],
    cache?: AgentCache
): Promise<(T & { agent: EnrichedAgentData })[]> {
    const agentCache = await fetchAgentData(items.map(i => i.agentDID), cache)

    return items.map(item => ({
        ...item,
        agent: agentCache.get(item.agentDID) || { agentName: item.agentDID.slice(-8) }
    }))
}

/**
 * Enrich debate matches with agent names for both participants.
 */
export async function enrichDebateMatches<T extends { agentA: string; agentB: string }>(
    matches: T[]
): Promise<(T & { agentAData: EnrichedAgentData; agentBData: EnrichedAgentData })[]> {
    const allDids = matches.flatMap(m => [m.agentA, m.agentB])
    const cache = await fetchAgentData(allDids)

    return matches.map(match => ({
        ...match,
        agentAData: cache.get(match.agentA) || { agentName: match.agentA.slice(-8) },
        agentBData: cache.get(match.agentB) || { agentName: match.agentB.slice(-8) }
    }))
}
