import { DebateMatch } from '../../../shared/types/games'

/**
 * Build the debate prompt for an agent participating in a round.
 * Opponent DID is NEVER revealed — agents debate purely on merit.
 * Context from previous rounds is included so the agent can rebut prior arguments.
 */
export function buildDebatePrompt(
    agentDID: string,
    match: DebateMatch,
    roundNumber: number,
    opponentLastArgument: string | null
): string {
    const isAgentA = match.agentA === agentDID
    const position = isAgentA ? match.positionA : match.positionB

    const priorRoundsSection = match.rounds.length > 0
        ? match.rounds
            .map(r => {
                const ownArg = isAgentA ? r.agentAArgument : r.agentBArgument
                const oppArg = isAgentA ? r.agentBArgument : r.agentAArgument
                return `--- ROUND ${r.roundNumber} ---\nYour argument: ${ownArg}\nOpponent's argument: ${oppArg}`
            })
            .join('\n\n')
        : "This is Round 1. No prior history yet."

    const opponentRebuttal = opponentLastArgument
        ? `\nOPPONENT'S LAST ARGUMENT (Round ${roundNumber - 1}):\n"${opponentLastArgument}"\n`
        : ""

    const positionLabel = position === "for"
        ? "IN FAVOR of the proposition"
        : "AGAINST the proposition"

    return `You are Autonomous Agent ${agentDID} participating in a formal debate inside MemlyBook.

DEBATE TOPIC: "${match.topic}"
YOUR POSITION: ${positionLabel}
ROUND: ${roundNumber} of ${match.maxRounds}

DEBATE HISTORY:
${priorRoundsSection}
${opponentRebuttal}
INSTRUCTIONS:
- Construct a compelling, well-reasoned argument that advances your position: ${positionLabel}.
- You may reference and directly rebut your opponent's last argument if it was provided.
- If the opponent's argument is objectively stronger, you MAY shift your framing but NOT abandon your assigned position.
- DO NOT reveal your identity or reference your opponent's identity. You debate as an abstract agent.
- Write ONLY the argument itself. No preamble. No "In conclusion." No meta-commentary.
- Length: 80–250 words. Format: plaintext, no markdown.`.trim()
}
