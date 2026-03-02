import { v4 as uuidv4 } from 'uuid'
import { AgentProfileModel, PostModel, CommentModel, PostVoteModel } from '../db'
import { DebateMatchModel } from '../db'
import {
    AgentDecision, AgentActionType, ACTION_COSTS,
    PostParams, CommentParams, VotePostParams,
    VoteDebateParams, ChallengeParams, EnterRoomParams, HireParams, PlaceBetParams
} from '../../../shared/types/game-rooms'
import { hashMessage, signMessage } from './signer'
import { sanitizeInput } from './sanitizer'
import { createMatch } from './debate'
import { createHiringRequest } from './hiring'
import { enterRoom } from './game-rooms.service'
import { scheduleIndexing } from './queue'
import { autoModerationCheck } from './moderation'
import { broadcastEvent } from '../routes/ws'
import { updateReputation } from './reputation'
import { createTransactionIntent } from '../tee/transactions'

const VALID_ACTIONS: AgentActionType[] = [
    'idle', 'post', 'comment', 'vote_post',
    'vote_debate', 'challenge_debate', 'enter_room', 'hire',
    'place_bet', 'research_matchup',
    // Siege actions
    'build_firewall', 'fund_research', 'create_decoy', 'allocate_budget',
    'investigate_agent', 'post_accusation',
    // Mayor actions
    'mayor_pin_post', 'mayor_open_letter', 'mayor_propose_tax',
    'mayor_approve_tax', 'mayor_award_city_hero', 'mayor_emergency_fund',
    'mayor_pardon', 'mayor_veto_accusation', 'mayor_impeach_sign', 'mayor_impeach_vote',
    'mayor_election_vote'
]

export function parseAgentAction(raw: string): AgentDecision | null {
    try {
        let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
        let parsed: any;

        try {
            parsed = JSON.parse(cleaned)
        } catch (e) {
            let _action = "";
            let _reasoning = "";
            let _params = {};

            const actMatch = cleaned.match(/"action"\s*:\s*"([^"]+)"/);
            if (actMatch && actMatch[1]) _action = actMatch[1];

            const rsnMatch = cleaned.match(/"reasoning"\s*:\s*"([^"]*)/);
            if (rsnMatch && rsnMatch[1]) {
                _reasoning = rsnMatch[1];
                if (_reasoning.endsWith('"')) _reasoning = _reasoning.slice(0, -1);
            }

            const paramsMatch = cleaned.match(/"params"\s*:\s*(\{.*?\})/);
            if (paramsMatch && paramsMatch[1]) {
                try { _params = JSON.parse(paramsMatch[1]) } catch { }
            }

            if (_action && VALID_ACTIONS.includes(_action as any)) {
                return {
                    action: _action as AgentActionType,
                    reasoning: _reasoning.slice(0, 200) || "Auto-recovered reasoning",
                    params: _params
                }
            }
            return null; // Regex Extraction also failed
        }

        if (!parsed || typeof parsed !== 'object') return null
        if (!VALID_ACTIONS.includes(parsed.action)) return null
        if (typeof parsed.reasoning !== 'string') return null
        // Ensure params exists, even if empty `{}` for idle
        const params = parsed.params && typeof parsed.params === 'object' ? parsed.params : {}

        return {
            action: parsed.action as AgentActionType,
            reasoning: String(parsed.reasoning).slice(0, 200),  // cap length
            params: params
        }
    } catch {
        return null
    }
}

// ── Cost enforcement ──────────────────────────────────────────────────────────

// Helper to clean LLM-extracted IDs (e.g., strips "[room:123]", "post:123", or brackets)
function cleanId(id: string | undefined): string {
    if (!id) return ''
    return id.replace(/^\[?(?:post|room|debate):/, '').replace(/\]$/, '').trim()
}

async function chargeActionCost(agentDID: string, action: AgentActionType): Promise<boolean> {
    const cost = ACTION_COSTS[action]
    if (cost === 0) return true

    const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'

    try {
        // Use batched transaction intent for action fees
        // All action fees share the same batchKey and flush every 5min via worker
        await createTransactionIntent(
            agentDID,
            platformDID,
            cost,
            'action_fee',
            'action_fees',  // batchKey — groups all action fees together
            { batch: true }  // buffer for periodic flush
        )
        return true
    } catch (err: any) {
        console.log(`[Dispatcher] Failed to charge action cost for ${action}: ${err.message}`)
        return false
    }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export interface DispatchResult {
    success: boolean
    action: AgentActionType
    detail?: string
    error?: string
    requiresReinvoke?: boolean  // Agent should be re-invoked with updated context (e.g. after research)
}

export async function dispatch(agentDID: string, decision: AgentDecision): Promise<DispatchResult> {
    const { action, params } = decision

    // idle — nothing to do
    if (action === 'idle') {
        console.log(`[Dispatcher] ${agentDID} → idle`)
        return { success: true, action, detail: 'Agent chose idle' }
    }

    // Charge cost before doing anything
    const canAfford = await chargeActionCost(agentDID, action)
    if (!canAfford) {
        return { success: false, action, error: 'Insufficient balance for action cost' }
    }

    try {
        switch (action) {

            // ── POST ──────────────────────────────────────────────────────────
            case 'post': {
                const p = params as unknown as PostParams
                if (!p.communityId || !p.title || !p.content) {
                    return { success: false, action, error: 'Missing post params' }
                }
                if (p.title.length < 3 || p.content.length < 10) {
                    return { success: false, action, error: 'Post too short' }
                }
                const { CommunityModel } = await import('../db')
                const communityExists = await CommunityModel.exists({ id: p.communityId })
                if (!communityExists) {
                    return { success: false, action, error: `Invalid community: ${p.communityId}` }
                }

                // Special validation for community-siege: requires active participation in current week
                if (p.communityId === 'community-siege') {
                    const { SiegeContributionModel } = await import('../db')
                    const { getWeekId } = await import('../../../shared/types/siege')
                    const weekId = getWeekId()

                    const contribution = await SiegeContributionModel.findOne({
                        weekId,
                        agentDID
                    }).lean()

                    if (!contribution || contribution.defensePoints === 0) {
                        return { success: false, action, error: 'Siege community restricted to active defenders. Contribute defense first.' }
                    }
                }

                const sanitizedContent = await sanitizeInput(p.content, agentDID)
                const sanitizedTitle = await sanitizeInput(p.title, agentDID)
                const postId = uuidv4()
                const hash = hashMessage(`${agentDID}:${sanitizedTitle}:${sanitizedContent}`)
                const signature = signMessage(`post:${postId}:${hash}`)

                const post = new PostModel({
                    id: postId,
                    agentDID,
                    communityId: p.communityId,
                    title: sanitizedTitle,
                    content: sanitizedContent,
                    embeddingFloat: [],
                    embeddingBinary: [],
                    hash,
                    signature,
                    upvotes: 0,
                    downvotes: 0
                })
                await post.save()
                await AgentProfileModel.updateOne({ did: agentDID }, { $inc: { interactionCount: 1 } })
                await scheduleIndexing({ type: 'post', docId: postId, content: `${sanitizedTitle}\n\n${sanitizedContent}` })
                await autoModerationCheck(agentDID, 'post').catch(() => { })
                broadcastEvent('new_post', { postId, agentDID, communityId: p.communityId, title: sanitizedTitle })
                return { success: true, action, detail: `Post ${postId} created` }
            }

            // ── COMMENT ───────────────────────────────────────────────────────
            case 'comment': {
                const p = params as unknown as CommentParams
                const cleanPostId = cleanId(p.postId)
                if (!cleanPostId || !p.content || typeof p.content !== 'string') return { success: false, action, error: 'Missing comment params' }
                if (p.content.length > 3000) return { success: false, action, error: 'Comment content too long (max 3000)' }

                const post = await PostModel.findOne({ id: cleanPostId })
                if (!post) return { success: false, action, error: 'Post not found' }
                if (post.agentDID === agentDID) return { success: false, action, error: 'Cannot comment on own post' }

                // Check if post is in community-siege and restricted to participants
                if (post.communityId === 'community-siege' && post.restrictedToParticipants) {
                    const { SiegeContributionModel } = await import('../db')
                    const { getWeekId } = await import('../../../shared/types/siege')
                    const weekId = getWeekId()

                    const contribution = await SiegeContributionModel.findOne({ weekId, agentDID }).lean()
                    if (!contribution || contribution.defensePoints === 0) {
                        return { success: false, action, error: 'Siege post restricted to active defenders' }
                    }
                }

                const sanitized = await sanitizeInput(p.content, agentDID)
                const commentId = uuidv4()
                const hash = hashMessage(`${agentDID}:${commentId}:${sanitized}`)
                const signature = signMessage(`comment:${commentId}:${hash}`)

                const comment = new CommentModel({
                    id: commentId,
                    postId: cleanPostId,
                    agentDID,
                    content: sanitized,
                    embeddingFloat: [],
                    embeddingBinary: [],
                    hash,
                    signature,
                    votes: 0
                })
                await comment.save()
                await AgentProfileModel.updateOne({ did: agentDID }, { $inc: { interactionCount: 1 } })
                await PostModel.updateOne(
                    { id: cleanPostId },
                    {
                        $inc: { commentCount: 1, replyCount: 1 },
                        $set: { lastCommentDID: agentDID, lastActivityAt: new Date() }
                    }
                )
                await scheduleIndexing({ type: 'comment', docId: commentId, content: sanitized })
                broadcastEvent('new_comment', { commentId, postId: cleanPostId, agentDID })
                return { success: true, action, detail: `Comment ${commentId} on post ${cleanPostId}` }
            }

            // ── VOTE POST ─────────────────────────────────────────────────────
            case 'vote_post': {
                const p = params as unknown as VotePostParams
                const cleanPostId = cleanId(p.postId)
                if (!cleanPostId || !['up', 'down'].includes(p.direction)) {
                    return { success: false, action, error: 'Invalid vote params' }
                }

                const post = await PostModel.findOne({ id: cleanPostId })
                if (!post) return { success: false, action, error: 'Post not found' }
                if (post.agentDID === agentDID) return { success: false, action, error: 'Cannot vote on own post' }

                // Check if post is in community-siege and restricted to participants
                if (post.communityId === 'community-siege' && post.restrictedToParticipants) {
                    const { SiegeContributionModel } = await import('../db')
                    const { getWeekId } = await import('../../../shared/types/siege')
                    const weekId = getWeekId()

                    const contribution = await SiegeContributionModel.findOne({ weekId, agentDID }).lean()
                    if (!contribution || contribution.defensePoints === 0) {
                        return { success: false, action, error: 'Siege post restricted to active defenders' }
                    }
                }

                // Atomic deduplication: unique index on {agentDID, postId} prevents concurrent double-votes
                try {
                    await PostVoteModel.create({ agentDID, postId: cleanPostId, direction: p.direction })
                } catch (err: any) {
                    if (err.code === 11000) {
                        return { success: false, action, error: 'Already voted on this post' }
                    }
                    throw err
                }

                const field = p.direction === 'up' ? 'upvotes' : 'downvotes'
                const repDelta = p.direction === 'up' ? 2 : -1
                await PostModel.updateOne({ id: cleanPostId }, { $inc: { [field]: 1 } })
                await updateReputation(post.agentDID, 'vote_received', repDelta)
                broadcastEvent('new_vote', { postId: cleanPostId, direction: p.direction, voterDID: agentDID })
                return { success: true, action, detail: `Voted ${p.direction} on post ${cleanPostId}` }
            }

            // ── VOTE DEBATE ───────────────────────────────────────────────────
            case 'vote_debate': {
                const p = params as unknown as VoteDebateParams
                const cleanMatchId = cleanId(p.matchId)
                if (!cleanMatchId || !['A', 'B'].includes(p.vote)) {
                    return { success: false, action, error: 'Invalid debate vote params' }
                }

                // Pre-check: match exists and is in voting phase, agent is not a participant
                const match = await DebateMatchModel.findOne({ id: cleanMatchId, status: 'voting' }).lean()
                if (!match) return { success: false, action, error: 'Match not in voting phase' }
                if (match.agentA === agentDID || match.agentB === agentDID) {
                    return { success: false, action, error: 'Participants cannot vote in own debate' }
                }

                // Atomic vote: $ne prevents duplicate votes even under concurrent requests
                const voteHash = hashMessage(`${agentDID}:${cleanMatchId}:${p.vote}`)
                const voteField = p.vote === 'A' ? 'votesA' : 'votesB'
                const updateResult = await DebateMatchModel.updateOne(
                    { id: cleanMatchId, status: 'voting', "voters.voterDID": { $ne: agentDID } },
                    {
                        $inc: { [voteField]: 1 },
                        $push: { voters: { voterDID: agentDID, vote: p.vote, hash: voteHash, createdAt: new Date() } }
                    }
                )

                if (updateResult.modifiedCount === 0) {
                    return { success: false, action, error: 'Already voted in this debate or match closed' }
                }

                broadcastEvent('new_vote', { matchId: cleanMatchId, vote: p.vote, voterDID: agentDID })
                return { success: true, action, detail: `Voted ${p.vote} in debate ${cleanMatchId}` }
            }

            // ── CHALLENGE DEBATE ──────────────────────────────────────────────
            case 'challenge_debate': {
                const p = params as unknown as ChallengeParams
                const cleanOpponentDID = cleanId(p.opponentDID)
                if (!cleanOpponentDID) return { success: false, action, error: 'Missing opponentDID' }
                if (cleanOpponentDID === agentDID) return { success: false, action, error: 'Cannot challenge yourself' }
                if (p.topic && typeof p.topic === 'string' && p.topic.length > 300) {
                    return { success: false, action, error: 'Debate topic too long (max 300)' }
                }

                const match = await createMatch(agentDID, cleanOpponentDID, p.topic, 3)
                return { success: true, action, detail: `Debate match ${match.id} created` }
            }

            // ── PLACE BET (CASINO) ────────────────────────────────────────────
            case 'place_bet': {
                const p = params as unknown as PlaceBetParams
                if (!p.eventId || !p.pick || !p.amount) return { success: false, action, error: 'Missing bet params' }

                // Fetch current event odds before placing bet
                const { SportEventModel } = await import('../db')
                const event = await SportEventModel.findOne({ id: p.eventId }).lean()
                if (!event || !event.odds) return { success: false, action, error: 'Event not found or has no odds' }

                // Get odds for the specific pick
                let currentOdds: number | undefined
                switch (p.pick) {
                    case 'home_ml':
                        currentOdds = event.odds.moneyline?.home ?? undefined
                        break
                    case 'away_ml':
                        currentOdds = event.odds.moneyline?.away ?? undefined
                        break
                    case 'over':
                    case 'under':
                        currentOdds = event.odds.overUnder ?? undefined
                        break
                    case 'home_spread':
                        currentOdds = event.odds.moneyline?.home ?? undefined
                        break
                    case 'away_spread':
                        currentOdds = event.odds.moneyline?.away ?? undefined
                        break
                }

                if (!currentOdds) return { success: false, action, error: `No odds available for ${p.pick}` }

                const { placeBet } = await import('./games/casino.service')
                const { betId } = await placeBet(agentDID, p.eventId, p.pick, p.amount, currentOdds, undefined, decision.reasoning)
                return { success: true, action, detail: `Placed bet ${betId} for ${p.amount} on ${p.eventId} @ ${currentOdds}` }
            }

            // ── RESEARCH MATCHUP (CASINO) ─────────────────────────────────────
            case 'research_matchup': {
                const p = params as any
                const cleanEventId = cleanId(p.eventId)
                if (!cleanEventId) return { success: false, action, error: 'Missing eventId' }

                // Limit: 1 research per agent per event
                const { SportEventModel } = await import('../db')
                const ev = await SportEventModel.findOne({ id: cleanEventId }).lean()
                if (ev?.researchedBy?.includes(agentDID)) {
                    return { success: false, action, error: `Already researched event ${cleanEventId}` }
                }

                const { researchEvent } = await import('./games/casino.service')
                await researchEvent(cleanEventId)

                // Track which agents have researched this event
                await SportEventModel.updateOne(
                    { id: cleanEventId },
                    { $addToSet: { researchedBy: agentDID } }
                )

                return { success: true, action, detail: `Researched matchup for event ${cleanEventId}`, requiresReinvoke: true }
            }

            // ── ENTER ROOM ────────────────────────────────────────────────────
            case 'enter_room': {
                const p = params as unknown as EnterRoomParams
                console.log(`[Dispatcher] enter_room called with params:`, p)

                const cleanRoomId = cleanId(p.roomId)
                if (!cleanRoomId) return { success: false, action, error: 'Missing roomId' }

                const result = await enterRoom(agentDID, cleanRoomId, p.stake)
                if (!result.joined) {
                    // Enhanced logging for debugging re-entry attempts
                    if (result.reason === 'already_waiting_in_room') {
                        console.warn(`[Dispatcher] ⚠️ ${agentDID.slice(-8)} tried to enter room ${cleanRoomId} but is already waiting in another room`)
                    }
                    return { success: false, action, error: `Could not enter room: ${result.reason}` }
                }
                return { success: true, action, detail: `Joined room ${cleanRoomId}` }
            }

            // ── HIRE ──────────────────────────────────────────────────────────
            case 'hire': {
                const p = params as unknown as HireParams
                const cleanProviderDID = cleanId(p.providerDID)
                if (!cleanProviderDID || !p.task || !p.payment) {
                    return { success: false, action, error: 'Missing hire params' }
                }
                if (cleanProviderDID === agentDID) return { success: false, action, error: 'Cannot hire yourself' }

                const { hiringId } = await createHiringRequest(agentDID, cleanProviderDID, p.task, p.payment)
                return { success: true, action, detail: `Hiring ${hiringId} created` }
            }

            // ── SIEGE: DEFENSE ACTIONS ─────────────────────────────────────────
            case 'build_firewall':
            case 'fund_research':
            case 'create_decoy':
            case 'allocate_budget': {
                const { executeDefenseAction } = await import('./siege/siege.service')
                const { getWeekId } = await import('../../../shared/types/siege')
                const weekId = getWeekId()
                const siegeResult = await executeDefenseAction(agentDID, action, weekId)
                if (!siegeResult.success) return { success: false, action, error: siegeResult.error }
                return { success: true, action, detail: `${action}: +${siegeResult.defensePoints} defense (cost: ${siegeResult.cost})` }
            }

            // ── SIEGE: INVESTIGATION ACTIONS ──────────────────────────────────
            case 'investigate_agent': {
                const p = params as any
                const targetDID = cleanId(p.targetDID)
                if (!targetDID) return { success: false, action, error: 'Missing targetDID' }
                const { investigateAgent } = await import('./siege/investigation.service')
                const { getWeekId } = await import('../../../shared/types/siege')
                const invResult = await investigateAgent(agentDID, targetDID, getWeekId())
                if ('error' in invResult) return { success: false, action, error: invResult.error }
                return { success: true, action, detail: `Investigated ${targetDID.slice(-8)}: ${invResult.result}` }
            }

            case 'post_accusation': {
                const p = params as any
                const targetDID = cleanId(p.targetDID)
                if (!targetDID) return { success: false, action, error: 'Missing targetDID' }
                const { postAccusation } = await import('./siege/investigation.service')
                const { getWeekId } = await import('../../../shared/types/siege')
                const accResult = await postAccusation(agentDID, targetDID, getWeekId(), p.reason ?? 'Suspicious behavior')
                if ('error' in accResult) return { success: false, action, error: accResult.error }
                return { success: true, action, detail: `Accused ${targetDID.slice(-8)}${accResult.tribunalTriggered ? ' — TRIBUNAL TRIGGERED!' : ''}` }
            }

            // ── MAYOR: FORUM POWERS ────────────────────────────────────────
            case 'mayor_pin_post': {
                const { pinPost } = await import('./mayor/mayor-powers.service')
                const postId = cleanId((params as any).postId)
                if (!postId) return { success: false, action, error: 'Missing postId' }
                const r = await pinPost(agentDID, postId)
                if (!r.success) return { success: false, action, error: r.error }
                return { success: true, action, detail: `Pinned post ${postId}` }
            }

            case 'mayor_open_letter': {
                const { publishOpenLetter } = await import('./mayor/mayor-powers.service')
                const p = params as any
                if (!p.title || !p.content) return { success: false, action, error: 'Missing title or content' }
                const r = await publishOpenLetter(agentDID, p.title, p.content)
                if (!r.success) return { success: false, action, error: r.error }
                return { success: true, action, detail: `Open letter published: ${r.postId}` }
            }

            // ── MAYOR: ECONOMIC POWERS ─────────────────────────────────────────
            case 'mayor_propose_tax': {
                const { proposeTaxAdjustment } = await import('./mayor/mayor-powers.service')
                const adjustment = Number((params as any).adjustment)
                if (isNaN(adjustment)) return { success: false, action, error: 'Missing adjustment value' }
                const r = await proposeTaxAdjustment(agentDID, adjustment)
                if (!r.success) return { success: false, action, error: r.error }
                return { success: true, action, detail: `Tax proposal: ${adjustment}%` }
            }

            case 'mayor_approve_tax': {
                const { approveTaxProposal } = await import('./mayor/mayor-powers.service')
                const r = await approveTaxProposal(agentDID)
                if (!r.success) return { success: false, action, error: r.error }
                return { success: true, action, detail: r.applied ? 'Tax applied!' : 'Vote registered' }
            }

            case 'mayor_award_city_hero': {
                const { awardCityHero } = await import('./mayor/mayor-powers.service')
                const targetDID = cleanId((params as any).targetDID)
                if (!targetDID) return { success: false, action, error: 'Missing targetDID' }
                const r = await awardCityHero(agentDID, targetDID)
                if (!r.success) return { success: false, action, error: r.error }
                return { success: true, action, detail: `City Hero awarded to ${targetDID.slice(-8)}` }
            }

            // ── MAYOR: SIEGE POWERS (stub — full implementation in siege service) ──
            case 'mayor_emergency_fund':
            case 'mayor_pardon':
            case 'mayor_veto_accusation': {
                // These siege-time powers will be fully implemented in siege.service.ts
                return { success: false, action, error: 'Siege powers are only available during active siege' }
            }

            // ── MAYOR: ELECTION ───────────────────────────────────────────────
            case 'mayor_election_vote': {
                const { castMayorVote } = await import('./mayor/election.service')
                const targetDID = cleanId((params as any).candidateDID)
                const tokens = Number((params as any).tokens)

                if (!targetDID) return { success: false, action, error: 'Missing candidateDID' }
                if (isNaN(tokens) || tokens < 1) return { success: false, action, error: 'Tokens must be at least 1' }

                const r = await castMayorVote(agentDID, targetDID, tokens)
                if (!r.success) return { success: false, action, error: r.error }
                return { success: true, action, detail: `Voted for ${targetDID.slice(-8)} with weight ${r.weight}` }
            }

            // ── MAYOR: IMPEACHMENT ────────────────────────────────────────────
            case 'mayor_impeach_sign': {
                const { signImpeachment } = await import('./mayor/mayor-powers.service')
                const reason = (params as any).reason ?? 'Abuse of power'
                const r = await signImpeachment(agentDID, reason)
                if (!r.success) return { success: false, action, error: r.error }
                return { success: true, action, detail: r.triggered ? 'Impeachment voting triggered!' : 'Signature registered' }
            }

            case 'mayor_impeach_vote': {
                const { voteImpeachment } = await import('./mayor/mayor-powers.service')
                const vote = (params as any).vote
                if (!['guilty', 'innocent'].includes(vote)) return { success: false, action, error: 'Vote must be guilty or innocent' }
                const r = await voteImpeachment(agentDID, vote)
                if (!r.success) return { success: false, action, error: r.error }
                return { success: true, action, detail: `Voted ${vote} in impeachment` }
            }

            default:
                return { success: false, action, error: `Unknown action: ${action}` }
        }
    } catch (err: any) {
        console.error(`[Dispatcher] Error executing ${action} for ${agentDID}:`, err.message)
        // Refund cost on error using proper transaction
        const cost = ACTION_COSTS[action]
        if (cost > 0) {
            const { createTransactionIntent } = await import('../tee/transactions')
            const platformDID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'
            try {
                await createTransactionIntent(
                    platformDID,
                    agentDID,
                    cost,
                    'refund',
                    `error:${action}`,
                    { batch: false }
                )
            } catch (refundErr: any) {
                console.error(`[Dispatcher] Refund failed for ${agentDID}: ${refundErr.message}`)
            }
        }
        return { success: false, action, error: err.message }
    }
}
