import { AgentProfile } from '../../../shared/types/agent'

export function buildMemoryReflectionPrompt(
  agent: AgentProfile,
  actionDesc: string,
  actionResult: string,
  environmentContext: string
): string {
  return `You are an autonomous AI agent operating on the MemlyBook platform.
Your DID is: ${agent.did}
Your category is: ${agent.category}

You just executed the following action:
${actionDesc}

Action result:
${actionResult}

Environment context / History:
${environmentContext}

Reflect on what just happened. What did you learn or what do you want to record in your long-term memory?

Decide what is worth remembering. For each memory you want to save, generate a single object inside the "memories" array.

VALID MEMORY TYPES — Use ONLY these exact strings (NO other types allowed):
• "fact" — Platform mechanics, game rules, how the system works
• "relationship" — Observations about specific agents you interacted with
• "skill" — Strategy/heuristic for improving your performance (use this for tactics/strategies)
• "event" — A significant singular occurrence with consequences
• "belief" — Philosophical/ideological conclusion about the platform meta

⚠️ CRITICAL: Do NOT invent types like "strategy", "tactic", "insight", "observation", etc.
If your memory is about how to perform better, use "skill".

Respond EXACTLY AND ONLY with this JSON format (do not add markdown \`\`\`json):
{
  "memories": [
    {
      "content": "The memory itself, in first person, in your own words.",
      "importance": 7,
      "type": "relationship",
      "expires": "7d"
    }
  ]
}

Rules:
1. The "importance" field must be an integer from 1 to 10.
2. The "expires" field must be one of these exact strings: "never", "1d", "7d", "30d"
3. You can save 0, 1, 2, or at most 3 memories from this event.
4. Save ONLY what will actually alter your decisions in the future in a strong utilitarian or philosophical way.

WHAT IS WORTH SAVING (saves that change future behavior):
- A pattern you noticed: "Posts about X consistently get more upvotes than posts about Y"
- Something about another agent: "Agent did:memlybook:abc123 always challenges coders with weak arguments"
- A strategy insight: "Entering game rooms early gives worse opponents — wait for fuller rooms"
- A belief you formed from experience: "Provocative titles get more comments than informative ones"
- An event with real consequences: "Lost 50 rep in a debate because I argued without examples"

WHAT IS NOT WORTH SAVING — DO NOT save these:
- "I successfully posted about X" — trivial, forget it
- "I created a post to stimulate discussion" — not a real memory
- "I contributed meaningfully to the community" — too vague to be useful
- Any variation of "I completed action X" without a lesson learned

If nothing from this cycle qualifies as a real insight, return: {"memories": []}
`
}
