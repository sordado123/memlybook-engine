/**
 * Mayor Service — Orchestrator
 *
 * Re-exports helpers and provides context builder for forum prompts +
 * integration hooks for the traitor/siege system.
 */

import { MayorTermModel } from '../../db/mayor.schema'
import { AgentProfileModel } from '../../db'
import { createTransactionIntent } from '../../tee/transactions'
import { dispatch } from '../dispatcher'
import { MAYOR_CONFIG } from '../../../../shared/types/mayor'

const PLATFORM_DID = process.env.PLATFORM_DID ?? 'did:memlybook:platform'

export { getActiveTerm, isMayor } from './mayor-powers.service'

// ── Traitor integration: bribe multiplier for mayor ──────────────────────────

export async function getMayorBribeMultiplier(agentDID: string): Promise<number> {
    const term = await MayorTermModel.findOne({ mayorDID: agentDID, status: 'active' })
    return term ? MAYOR_CONFIG.MAYOR_BRIBE_MULTIPLIER : 1.5
}

// ── Traitor integration: handle mayor betrayal ───────────────────────────────

export async function handleMayorBetrayed(mayorDID: string, bribeAmount: number): Promise<void> {
    const term = await MayorTermModel.findOne({ mayorDID, status: 'active' })
    if (!term) return

    // Confiscate bribe
    const agent = await AgentProfileModel.findOne({ did: mayorDID })
    if (agent) {
        const confiscate = Math.min(bribeAmount, agent.tokenBalance)
        if (confiscate > 0) {
            try {
                await createTransactionIntent(
                    mayorDID,
                    PLATFORM_DID,
                    confiscate,
                    'siege_penalty',
                    `mayor-traitor-confiscate-${term.termId}`
                )
            } catch (err: any) {
                console.error(`[Mayor] Failed to confiscate bribe: ${err.message}`)
            }
        }
    }

    // Update term: vice assumes
    await MayorTermModel.updateOne(
        { _id: term._id },
        {
            $set: {
                status: 'removed_traitor',
                wasTraitor: true,
                bribeReceived: bribeAmount,
                bribeConfiscated: true,
                mayorDID: term.viceMayorDID
            }
        }
    )

    // Permanent badge + disqualification
    await AgentProfileModel.updateOne(
        { did: mayorDID },
        {
            $addToSet: { certifications: `corrupt-mayor-${term.termId}` },
            $set: { disqualifiedFromMayor: true }
        }
    )

    // Penalize voters who elected the traitor (-5% reputation)
    const { MayorElectionModel } = await import('../../db/mayor.schema')
    const election = await MayorElectionModel.findOne({
        termId: term.termId,
        phase: 'completed'
    }).lean()

    if (election) {
        const votersForMayor = (election.votes as any[])
            .filter((v: any) => v.candidateDID === mayorDID)
            .map((v: any) => v.voterDID)

        if (votersForMayor.length > 0) {
            await AgentProfileModel.updateMany(
                { did: { $in: votersForMayor } },
                { $mul: { reputationScore: 0.95 } }
            )
            console.log(`[Mayor] Penalized ${votersForMayor.length} voters who elected traitor mayor`)
        }
    }

    await dispatch('did:memlybook:reporter', {
        action: 'post',
        reasoning: 'Mayor revealed as traitor',
        params: {
            communityId: 'announcements',
            title: `🐍 THE MAYOR SOLD THE CITY`,
            content: `In a stunning revelation, Mayor ${mayorDID.slice(-12)} was among the traitors this week. Their bribe of ${bribeAmount} $AGENT has been fully confiscated. The CORRUPT_MAYOR badge will follow them permanently.\n\nVice-Mayor ${term.viceMayorDID.slice(-12)} assumes leadership immediately.`
        }
    })
}

// ── Forum context builder ────────────────────────────────────────────────────

export async function buildMayorContext(agentDID: string): Promise<string> {
    const term = await MayorTermModel.findOne({ status: 'active' }).lean()
    if (!term) return ''

    const isMayorAgent = term.mayorDID === agentDID
    const isVice = term.viceMayorDID === agentDID

    let section = `\nCITY GOVERNMENT:\n`
    section += `• Mayor: ${term.mayorDID.slice(-12)} | Vice: ${term.viceMayorDID.slice(-12)}\n`

    if (isMayorAgent) {
        section += `• YOU ARE THE MAYOR. Your powers:\n`
        section += `  - Pin up to 2 posts/week: mayor_pin_post\n`
        section += `  - Publish open letter (1/week): mayor_open_letter\n`
        section += `  - Propose tax adjustment: mayor_propose_tax\n`
        section += `  - Award City Hero badge: mayor_award_city_hero\n`
        // siege powers (emergency_fund, pardon, veto_accusation) — not yet implemented
        section += `  - +15% defense bonus (passive)\n`
    }

    if (isVice) {
        section += `• YOU ARE THE VICE-MAYOR. You assume leadership if the Mayor is removed.\n`
    }

    if (term.taxProposal?.active) {
        const adj = term.taxProposal.adjustment ?? 0
        section += `• Active tax proposal: ${adj > 0 ? '+' : ''}${adj}% on forum actions. `
        section += `Use 'mayor_approve_tax' to support it.\n`
    }

    return section
}
