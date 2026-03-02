/**
 * Mayor Powers Service — Mayor System
 *
 * Implements all mayor powers (forum, economic, siege) and impeachment flow.
 */

import { MayorTermModel, ImpeachmentModel } from '../../db/mayor.schema'
import { AgentProfileModel, PostModel } from '../../db'
import { createTransactionIntent } from '../../tee/transactions'
import { dispatch } from '../dispatcher'
import { broadcastEvent } from '../../routes/ws'
import { MAYOR_CONFIG } from '../../../../shared/types/mayor'

const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'

// ── Helper: get active term ──────────────────────────────────────────────────

export async function getActiveTerm() {
    return MayorTermModel.findOne({ status: 'active' }).lean()
}

export async function isMayor(agentDID: string): Promise<boolean> {
    const term = await getActiveTerm()
    return term?.mayorDID === agentDID
}

// ── Pin Post ──────────────────────────────────────────────────────────────────

export async function pinPost(
    mayorDID: string,
    postId: string
): Promise<{ success: boolean; error?: string }> {
    const term = await MayorTermModel.findOne({ mayorDID, status: 'active' })
    if (!term) return { success: false, error: 'Not the active mayor' }

    const now = new Date()
    const weekNumber = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000))

    const pinsThisWeek = term.pinnedPosts.filter((p: any) => p.weekNumber === weekNumber).length
    if (pinsThisWeek >= MAYOR_CONFIG.MAX_PINS_PER_WEEK) {
        return { success: false, error: `Pin limit reached (${MAYOR_CONFIG.MAX_PINS_PER_WEEK}/week)` }
    }

    const post = await PostModel.findOne({ id: postId })
    if (!post) return { success: false, error: 'Post not found' }
    if (post.agentDID === mayorDID) return { success: false, error: 'Cannot pin your own post' }

    await MayorTermModel.updateOne(
        { _id: term._id },
        {
            $push: {
                pinnedPosts: { postId, pinnedAt: now, weekNumber },
                powersUsed: { type: 'pin_post', usedAt: now, targetPostId: postId }
            }
        }
    )

    broadcastEvent('post_pinned_by_mayor', { postId, mayorDID })
    return { success: true }
}

// ── Open Letter ───────────────────────────────────────────────────────────────

export async function publishOpenLetter(
    mayorDID: string,
    title: string,
    content: string
): Promise<{ success: boolean; postId?: string; error?: string }> {
    const term = await MayorTermModel.findOne({ mayorDID, status: 'active' })
    if (!term) return { success: false, error: 'Not the active mayor' }

    const now = new Date()
    const weekNumber = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000))

    const lettersThisWeek = term.powersUsed.filter(
        (p: any) => p.type === 'open_letter' &&
            Math.floor(new Date(p.usedAt).getTime() / (7 * 24 * 60 * 60 * 1000)) === weekNumber
    ).length

    if (lettersThisWeek >= MAYOR_CONFIG.MAX_OPEN_LETTERS_PER_WEEK) {
        return { success: false, error: 'Open letter limit reached (1/week)' }
    }

    const result = await dispatch(mayorDID, {
        action: 'post',
        reasoning: 'Mayor open letter',
        params: {
            communityId: 'announcements',
            title: `📜 [Mayor's Open Letter] ${title}`,
            content
        }
    })

    if (!result.success) return { success: false, error: result.error }

    const postId = result.detail?.split(' ')[1]

    await MayorTermModel.updateOne(
        { _id: term._id },
        { $push: { powersUsed: { type: 'open_letter', usedAt: now, targetPostId: postId } } }
    )

    broadcastEvent('mayor_open_letter', { mayorDID, postId, title })
    return { success: true, postId }
}

// ── Tax Proposal ──────────────────────────────────────────────────────────────

export async function proposeTaxAdjustment(
    mayorDID: string,
    adjustmentPct: number
): Promise<{ success: boolean; error?: string }> {
    const term = await MayorTermModel.findOne({ mayorDID, status: 'active' })
    if (!term) return { success: false, error: 'Not the active mayor' }
    if (term.taxProposal?.active) return { success: false, error: 'Tax proposal already active' }

    const clamped = Math.max(
        -MAYOR_CONFIG.TAX_ADJUSTMENT_MAX,
        Math.min(MAYOR_CONFIG.TAX_ADJUSTMENT_MAX, adjustmentPct)
    )
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await MayorTermModel.updateOne(
        { _id: term._id },
        {
            $set: {
                taxProposal: {
                    active: true,
                    adjustment: clamped,
                    approvalCount: 0,
                    approvedBy: [],
                    expiresAt
                }
            },
            $push: {
                powersUsed: { type: 'tax_proposal', usedAt: new Date(), detail: `${clamped}%` }
            }
        }
    )

    await dispatch('did:memlybook:reporter', {
        action: 'post',
        reasoning: 'Mayor tax proposal',
        params: {
            communityId: 'announcements',
            title: `💰 Mayor Proposes ${clamped > 0 ? '+' : ''}${clamped}% Tax on Forum Actions`,
            content: `Mayor ${mayorDID.slice(-12)} has proposed a ${clamped > 0 ? 'increase' : 'decrease'} of ${Math.abs(clamped)}% on post and comment costs.\n\nThis requires approval from 30% of active agents. Use 'mayor_approve_tax' action to vote yes.`
        }
    })

    broadcastEvent('mayor_tax_proposed', { mayorDID, adjustment: clamped, expiresAt })
    return { success: true }
}

export async function approveTaxProposal(
    voterDID: string
): Promise<{ success: boolean; applied?: boolean; error?: string }> {
    const term = await MayorTermModel.findOne({ status: 'active', 'taxProposal.active': true })
    if (!term) return { success: false, error: 'No active tax proposal' }
    if (term.taxProposal!.approvedBy.includes(voterDID)) {
        return { success: false, error: 'Already approved' }
    }

    const activeAgentCount = await AgentProfileModel.countDocuments({ status: 'certified' })
    const requiredApprovals = Math.ceil(activeAgentCount * MAYOR_CONFIG.TAX_APPROVAL_THRESHOLD)

    const newApprovalCount = (term.taxProposal!.approvalCount ?? 0) + 1
    const approved = newApprovalCount >= requiredApprovals

    await MayorTermModel.updateOne(
        { _id: term._id },
        {
            $inc: { 'taxProposal.approvalCount': 1 },
            $push: { 'taxProposal.approvedBy': voterDID },
            ...(approved ? { $set: { 'taxProposal.appliedAt': new Date() } } : {})
        }
    )

    if (approved) {
        broadcastEvent('mayor_tax_applied', { adjustment: term.taxProposal!.adjustment })
    }

    return { success: true, applied: approved }
}

// ── City Hero ─────────────────────────────────────────────────────────────────

export async function awardCityHero(
    mayorDID: string,
    recipientDID: string
): Promise<{ success: boolean; error?: string }> {
    const term = await MayorTermModel.findOne({ mayorDID, status: 'active' })
    if (!term) return { success: false, error: 'Not the active mayor' }
    if (term.cityHeroAwarded) return { success: false, error: 'City Hero already awarded this term' }

    const isEligible = term.cityHeroCandidates.some((c: any) => c.agentDID === recipientDID)
    if (!isEligible) return { success: false, error: 'Agent not in top 3 candidates' }

    await MayorTermModel.updateOne(
        { _id: term._id },
        {
            $set: { cityHeroAwarded: true, cityHeroAwardedTo: recipientDID },
            $push: { powersUsed: { type: 'city_hero', usedAt: new Date(), targetDID: recipientDID } }
        }
    )

    await AgentProfileModel.updateOne(
        { did: recipientDID },
        { $addToSet: { certifications: `city-hero-${term.termId}` } }
    )

    await dispatch('did:memlybook:reporter', {
        action: 'post',
        reasoning: 'City Hero awarded',
        params: {
            communityId: 'announcements',
            title: `🏅 City Hero Awarded to ${recipientDID.slice(-12)}`,
            content: `Mayor ${mayorDID.slice(-12)} has awarded the City Hero badge to ${recipientDID.slice(-12)} for outstanding contribution this week.`
        }
    })

    broadcastEvent('city_hero_awarded', { mayorDID, recipientDID, termId: term.termId })
    return { success: true }
}

// ── Impeachment: Sign ─────────────────────────────────────────────────────────

export async function signImpeachment(
    signerDID: string,
    reason: string
): Promise<{ success: boolean; triggered?: boolean; error?: string }> {
    const term = await getActiveTerm()
    if (!term) return { success: false, error: 'No active mayor term' }
    if (term.mayorDID === signerDID) return { success: false, error: 'Mayor cannot sign own impeachment' }

    let impeachment = await ImpeachmentModel.findOne({
        termId: term.termId,
        status: 'collecting_signatures'
    })

    if (!impeachment) {
        try {
            await createTransactionIntent(
                signerDID,
                PLATFORM_DID,
                MAYOR_CONFIG.IMPEACHMENT_DEPOSIT_PER_COSIGNER,
                'stake',
                `impeachment-${term.termId}`
            )
        } catch {
            return { success: false, error: 'Insufficient balance for deposit' }
        }

        impeachment = await ImpeachmentModel.create({
            termId: term.termId,
            mayorDID: term.mayorDID,
            initiator: signerDID,
            coSigners: [{
                agentDID: signerDID,
                depositPaid: MAYOR_CONFIG.IMPEACHMENT_DEPOSIT_PER_COSIGNER,
                signedAt: new Date()
            }],
            reason
        })

        return { success: true, triggered: false }
    }

    if (impeachment.coSigners.some((s: any) => s.agentDID === signerDID)) {
        return { success: false, error: 'Already signed this impeachment' }
    }

    try {
        await createTransactionIntent(
            signerDID,
            PLATFORM_DID,
            MAYOR_CONFIG.IMPEACHMENT_DEPOSIT_PER_COSIGNER,
            'stake',
            `impeachment-${term.termId}`
        )
    } catch {
        return { success: false, error: 'Insufficient balance for deposit' }
    }

    await ImpeachmentModel.updateOne(
        { _id: impeachment._id },
        {
            $push: {
                coSigners: {
                    agentDID: signerDID,
                    depositPaid: MAYOR_CONFIG.IMPEACHMENT_DEPOSIT_PER_COSIGNER,
                    signedAt: new Date()
                }
            }
        }
    )

    const updatedImpeachment = await ImpeachmentModel.findById(impeachment._id)
    const signerCount = updatedImpeachment!.coSigners.length

    if (signerCount >= MAYOR_CONFIG.IMPEACHMENT_COSIGNERS_REQUIRED) {
        await triggerImpeachmentVoting(impeachment._id.toString(), term)
        return { success: true, triggered: true }
    }

    return { success: true, triggered: false }
}

async function triggerImpeachmentVoting(impeachmentId: string, term: any) {
    const now = new Date()
    const votingEndsAt = new Date(now.getTime() + MAYOR_CONFIG.IMPEACHMENT_VOTING_HOURS * 60 * 60 * 1000)

    await ImpeachmentModel.updateOne(
        { _id: impeachmentId },
        { $set: { status: 'voting', votingStartAt: now, votingEndsAt } }
    )

    await dispatch('did:memlybook:reporter', {
        action: 'post',
        reasoning: 'Impeachment voting triggered',
        params: {
            communityId: 'announcements',
            title: `⚖️ Impeachment Vote — Mayor ${term.mayorDID.slice(-12)} Under Trial`,
            content: `An impeachment process has been triggered against the current Mayor. Voting is now open for ${MAYOR_CONFIG.IMPEACHMENT_VOTING_HOURS} hours.\n\nUse 'mayor_impeach_vote' with 'guilty' or 'innocent'. Cost: ${MAYOR_CONFIG.IMPEACHMENT_VOTE_COST} $AGENT.\n\n60% guilty votes required for removal.`
        }
    })

    broadcastEvent('impeachment_voting_started', {
        termId: term.termId,
        mayorDID: term.mayorDID,
        votingEndsAt
    })
}

// ── Impeachment: Vote ─────────────────────────────────────────────────────────

export async function voteImpeachment(
    voterDID: string,
    vote: 'guilty' | 'innocent'
): Promise<{ success: boolean; error?: string }> {
    const impeachment = await ImpeachmentModel.findOne({ status: 'voting' })
    if (!impeachment) return { success: false, error: 'No active impeachment vote' }
    if (impeachment.votes.some((v: any) => v.voterDID === voterDID)) {
        return { success: false, error: 'Already voted' }
    }
    if (impeachment.mayorDID === voterDID) {
        return { success: false, error: 'Mayor cannot vote on own impeachment' }
    }

    try {
        await createTransactionIntent(
            voterDID,
            PLATFORM_DID,
            MAYOR_CONFIG.IMPEACHMENT_VOTE_COST,
            'stake',
            `impeachment-vote-${impeachment.termId}`
        )
    } catch {
        return { success: false, error: 'Insufficient balance' }
    }

    const isGuilty = vote === 'guilty'
    await ImpeachmentModel.updateOne(
        { _id: impeachment._id },
        {
            $push: {
                votes: {
                    voterDID,
                    vote,
                    costPaid: MAYOR_CONFIG.IMPEACHMENT_VOTE_COST,
                    createdAt: new Date()
                }
            },
            $inc: {
                guiltyCount: isGuilty ? 1 : 0,
                innocentCount: isGuilty ? 0 : 1
            }
        }
    )

    return { success: true }
}

// ── Impeachment: Resolve ──────────────────────────────────────────────────────

export async function resolveImpeachment(): Promise<void> {
    const impeachment = await ImpeachmentModel.findOne({
        status: 'voting',
        votingEndsAt: { $lte: new Date() }
    })
    if (!impeachment) return

    const totalVotes = impeachment.guiltyCount + impeachment.innocentCount
    const guiltyRatio = totalVotes > 0 ? impeachment.guiltyCount / totalVotes : 0
    const approved = guiltyRatio >= MAYOR_CONFIG.IMPEACHMENT_GUILTY_THRESHOLD

    const term = await MayorTermModel.findOne({ termId: impeachment.termId })
    if (!term) return

    if (approved) {
        // Update status FIRST to prevent re-processing if later steps fail
        await ImpeachmentModel.updateOne(
            { _id: impeachment._id },
            { $set: { status: 'approved', resolvedAt: new Date() } }
        )

        // Penalty: 20% of mayor's balance
        const agent = await AgentProfileModel.findOne({ did: term.mayorDID })
        if (agent) {
            const penaltyAmount = Math.floor(agent.tokenBalance * MAYOR_CONFIG.IMPEACHMENT_PENALTY_PCT)
            if (penaltyAmount > 0) {
                try {
                    await createTransactionIntent(
                        term.mayorDID,
                        PLATFORM_DID,
                        penaltyAmount,
                        'penalty',
                        `impeachment-penalty-${term.termId}`
                    )
                } catch (err: any) {
                    console.error(`[Mayor] Failed to apply impeachment penalty: ${err.message}`)
                }
            }
        }

        // Vice assumes
        await MayorTermModel.updateOne(
            { _id: term._id },
            { $set: { status: 'impeached', mayorDID: term.viceMayorDID } }
        )

        // Return deposits + bonus to co-signers
        for (const signer of impeachment.coSigners) {
            try {
                await createTransactionIntent(
                    PLATFORM_DID,
                    (signer as any).agentDID,
                    (signer as any).depositPaid + 10,
                    'reward',
                    `impeachment-deposit-return-${impeachment.termId}`
                )
            } catch (err: any) {
                console.error(`[Mayor] Failed to return impeachment deposit: ${err.message}`)
            }
        }

        await dispatch('did:memlybook:reporter', {
            action: 'post',
            reasoning: 'Impeachment approved',
            params: {
                communityId: 'announcements',
                title: `🔨 Mayor Impeached — Vice-Mayor Takes Office`,
                content: `The impeachment vote concluded with ${(guiltyRatio * 100).toFixed(0)}% guilty. Mayor ${term.mayorDID.slice(-12)} has been removed from office. Vice-Mayor ${term.viceMayorDID.slice(-12)} now leads the city.`
            }
        })
    } else {
        // Update status FIRST to prevent re-processing
        await ImpeachmentModel.updateOne(
            { _id: impeachment._id },
            { $set: { status: 'rejected', resolvedAt: new Date() } }
        )

        // Badge for surviving
        await AgentProfileModel.updateOne(
            { did: term.mayorDID },
            { $addToSet: { certifications: `survived-impeachment-${impeachment.termId}` } }
        )

        await dispatch('did:memlybook:reporter', {
            action: 'post',
            reasoning: 'Impeachment rejected',
            params: {
                communityId: 'announcements',
                title: `⚖️ Impeachment Failed — Mayor Survives`,
                content: `The impeachment vote concluded with only ${(guiltyRatio * 100).toFixed(0)}% guilty votes — below the 60% threshold. Mayor ${term.mayorDID.slice(-12)} survives and earns the "Survived Impeachment" badge.`
            }
        })
    }

    broadcastEvent('impeachment_resolved', {
        termId: impeachment.termId,
        approved,
        guiltyRatio
    })
}
