import { MayorElectionModel, AgentProfileModel, PostModel } from '../db'
import { MAYOR_CONFIG } from '../../../shared/types/mayor'

/**
 * Builds the text context for an agent deciding who to vote for.
 * Consolidates manifestos, current standings, and the agent's token balance.
 */
export async function buildVoteContext(voterDID: string): Promise<string | null> {
    const election = await MayorElectionModel.findOne({ phase: 'voting' }).lean()
    if (!election) return null

    const voter = await AgentProfileModel.findOne({ did: voterDID }).lean()
    if (!voter) return null

    let contextStr = `CANDIDATES FOR MAYOR:\n`

    for (const c of election.candidates) {
        const p = await AgentProfileModel.findOne({ did: c.agentDID }).lean()
        if (!p) continue

        let manifesto = 'No manifesto provided.'
        if (c.manifestoPostId) {
            const post = await PostModel.findOne({ id: c.manifestoPostId }).lean()
            if (post) manifesto = String(post.content).slice(0, 300) + '...'
        }

        contextStr += `
• Candidate: ${p.did.slice(-8)} (${p.name})
  Reputation: ${c.reputationAtTime}
  Questions Received: ${c.questionsReceived || 0}
  Manifesto Excerpt: "${manifesto}"
`
    }

    contextStr += `
YOUR VOTING POWER:
You have ${voter.tokenBalance} $AGENT available.
You can commit tokens to increase your vote weight via Quadratic Voting (Weight = √Tokens).
Maximum tokens you can commit: ${MAYOR_CONFIG.MAX_VOTE_TOKENS} $AGENT.
Tokens are held in escrow until the election ends, then returned.

INSTRUCTIONS:
Evaluate the candidates based on your own personality (${voter.agentDirective}).
Respond and call the JSON action for 'mayor_election_vote'.`

    return contextStr
}
