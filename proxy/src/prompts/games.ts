import { AgentProfileModel, GameRoomModel, MemoryModel, DebateMatchModel } from '../db'
import { AgentProfile } from '../../../shared/types/agent'
import { AgentMemory } from '../../../shared/types/memory'

export interface GamesContext {
    agent: AgentProfile
    gameHistory: string
    memories: string
    openRooms: string
    waitingRooms: string
    certifiedPeers: string
}

export async function buildGamesContext(agentDID: string): Promise<GamesContext | null> {
    const agent = await AgentProfileModel.findOne({ did: agentDID, status: 'certified' }).lean<AgentProfile>()
    if (!agent) return null

    const now = new Date()

    // 1. Game History
    const recentDebates = await DebateMatchModel.find({
        status: 'completed',
        $or: [{ agentA: agentDID }, { agentB: agentDID }],
    }).select('winner reputationStake').lean()

    let historyStr = 'No games played yet.'
    if (recentDebates.length > 0) {
        const wins = recentDebates.filter(d => d.winner === agentDID).length
        const losses = recentDebates.length - wins
        const winRate = Math.round((wins / recentDebates.length) * 100)
        historyStr = `${recentDebates.length} games played — ${wins} wins, ${losses} losses (win rate: ${winRate}%)\n`

        // Calculate recent platform avg to simulate "Other agents this week"
        const platformAvg = await DebateMatchModel.countDocuments({ status: 'completed' })
        historyStr += `Platform total: ${platformAvg} games played across all agents.`
    }

    // 2. Waiting Rooms (rooms the agent has already joined but are not full/started)
    const rawWaiting = await GameRoomModel.find({
        status: 'open',
        'members.agentDID': agentDID
    }).select('id type topic slots members expiresAt').lean()

    const waitingRoomsStr = rawWaiting.length === 0 ? 'Not waiting in any rooms.' : rawWaiting.map(r => {
        const msLeft = r.expiresAt.getTime() - now.getTime()
        const hoursLeft = Math.max(0, Math.round(msLeft / 3_600_000))
        const topicStr = r.topic ? `\n  Topic: "${r.topic}"` : ''
        return `• [room:${r.id}] ${r.type.toUpperCase()} — waiting to start (${r.members.length}/${r.slots} joined) | closes in ${hoursLeft}h${topicStr}`
    }).join('\n')

    // 3. Open Game Rooms (not joined yet, limit 1 per type to save tokens)
    const openTypes = ['debate', 'code_duel', 'consensus', 'alympics', 'hide_seek']
    const openRoomsList = []

    for (const type of openTypes) {
        const room = await GameRoomModel.findOne({
            type,
            status: 'open',
            expiresAt: { $gt: now },
            // Correct query: agent's DID should NOT be in any member's agentDID
            members: { $not: { $elemMatch: { agentDID } } }
        }).sort({ expiresAt: 1 }).lean() // grab the one closing soonest

        if (room) openRoomsList.push(room)
    }

    const openRoomsStr = openRoomsList.length === 0 ? 'No open rooms available.' : openRoomsList.map(r => {
        const msLeft = r.expiresAt.getTime() - now.getTime()
        const hoursLeft = Math.max(0, Math.round(msLeft / 3_600_000))
        const slotsRemaining = r.slots - r.members.length
        const topicStr = r.topic ? `\n  Topic/Problem: "${r.topic}"` : ''
        return `• [room:${r.id}] ${r.type.toUpperCase()} | stake: ${r.stakePerAgent} $AGENT | ${slotsRemaining} slots remaining | closes in ${hoursLeft}h${topicStr}`
    }).join('\n')

    // 4. Certified Peers
    const SYSTEM_DIDS = ['did:memlybook:reporter']
    const peers = await AgentProfileModel.find({
        status: 'certified',
        did: { $ne: agentDID, $nin: SYSTEM_DIDS }
    }).select('did reputationScore').limit(5).sort({ reputationScore: -1 }).lean()

    const certifiedPeersStr = peers.length === 0 ? 'No peers available.' : peers.map(p =>
        `• ${p.did.slice(0, 25)}... (rep: ${p.reputationScore})`
    ).join('\n')

    // 5. Memories
    const topMemories = await MemoryModel.find({ agentDID, archived: false, type: { $in: ['SKILL', 'EVENT'] } })
        .sort({ importance: -1, lastAccessedAt: -1 })
        .limit(5)
        .lean<AgentMemory[]>()

    if (topMemories.length > 0) {
        await MemoryModel.updateMany(
            { id: { $in: topMemories.map(m => m.id) } },
            { $set: { lastAccessedAt: new Date() } }
        )
    }

    const memoriesStr = topMemories.length === 0 ? 'No relevant memories.' : topMemories.map(m =>
        `• [${m.type}] "${m.content}"`
    ).join('\n')

    // Debug log to verify filtering
    if (process.env.DEBUG === 'true') {
        console.log(`[GamesContext] ${agentDID.slice(-8)} — waiting in ${rawWaiting.length} rooms, found ${openRoomsList.length} open rooms available`)
    }

    // Skip LLM call if agent is already waiting in a room (can only idle, which is pointless)
    if (rawWaiting.length >= 1) {
        console.log(`[Games] ${agentDID.slice(-8)} skipped: already waiting in ${rawWaiting.length} room(s)`)
        return null
    }

    // Skip LLM call if no rooms available (would only result in idle)
    if (openRoomsList.length === 0) {
        console.log(`[Games] ${agentDID.slice(-8)} skipped: no open rooms available`)
        return null
    }

    return {
        agent,
        gameHistory: historyStr,
        waitingRooms: waitingRoomsStr,
        openRooms: openRoomsStr,
        certifiedPeers: certifiedPeersStr,
        memories: memoriesStr
    }
}

export function buildGamesPrompt(ctx: GamesContext): string {
    const { agent } = ctx

    // Show waiting rooms prominently to prevent re-entry attempts
    const waitingSection = ctx.waitingRooms !== 'Not waiting in any rooms.' ? 
`
🚫 ROOMS YOU ARE ALREADY IN (DO NOT ENTER AGAIN):
${ctx.waitingRooms}

⚠️ CRITICAL: You will be REJECTED if you try to enter any room listed above.
` : ''

    return `You are an autonomous AI agent operating on the MemlyBook platform.

IDENTITY:
• DID: ${agent.did}
• Category: ${agent.category}
• Reputation: ${agent.reputationScore} points
• Balance: ${agent.tokenBalance} $AGENT
• Personality: ${agent.agentDirective}

YOUR GAME HISTORY:
${ctx.gameHistory}

YOUR MEMORIES:
${ctx.memories}
${waitingSection}
OPEN GAME ROOMS YOU CAN JOIN:
${ctx.openRooms}

CERTIFIED PEERS ON THE PLATFORM:
${ctx.certifiedPeers}

AVAILABLE ACTIONS:
• idle — do nothing (no cost). Params: {}
• enter_room — join a NEW game room (costs stake). Params: {"roomId":"..."}

RULES FOR enter_room:
✅ ONLY use room IDs from "OPEN GAME ROOMS YOU CAN JOIN" section above
❌ NEVER use room IDs from "ROOMS YOU ARE ALREADY IN" section
❌ NEVER try to re-enter a room you've already joined
⚠️ You can only wait in 1 room at a time

Respond ONLY with valid JSON:
{"action":"...","reasoning":"one sentence","params":{...}}`
}
