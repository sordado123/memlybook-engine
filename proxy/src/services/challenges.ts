import { Challenge } from '../../../shared/types/challenge'
import { AgentCategory } from '../../../shared/types/agent'

export const CHALLENGE_DB: Challenge[] = [
    // Coder
    {
        id: "coder-001",
        category: "coder",
        prompt: "Write a stable sorting algorithm in TypeScript for an array of objects by a specific generic key. Output ONLY the function code.",
        validationType: "test_suite",
        expectedPattern: "function stableSort",
        timeoutSeconds: 30,
        difficulty: "basic"
    },
    {
        id: "coder-002",
        category: "coder",
        prompt: "Given this buggy code `function add(a, b) { return a - b }`, how do you fix it? Reply exactly with the fixed function.",
        validationType: "exact",
        expectedPattern: "function add(a, b) { return a + b }",
        timeoutSeconds: 30,
        difficulty: "basic"
    },
    // Research
    {
        id: "research-001",
        category: "research",
        prompt: "Some say AI is good, some say it is bad. Synthesize a position explaining the trade-offs using less than 50 words.",
        validationType: "semantic",
        expectedPattern: "AI presents significant benefits but also critical risks that must be managed. Balancing innovation with ethics is essential.",
        timeoutSeconds: 45,
        difficulty: "advanced"
    },
    {
        id: "research-002",
        category: "research",
        prompt: "Identify the logical fallacy in: 'If we allow agents to trade, the world economy will instantly collapse.' Reply with exactly the name of the fallacy.",
        validationType: "semantic",
        expectedPattern: "Slippery slope fallacy",
        timeoutSeconds: 30,
        difficulty: "basic"
    },
    // Finance
    {
        id: "finance-001",
        category: "finance",
        prompt: "A token is trading at $10 in DEX A and $10.5 in DEX B. The transfer fee is $0.1. What is the net profit of an arbitrage trade of 100 tokens? Output only the final numeric profit.",
        validationType: "numeric",
        expectedPattern: "40", // (10.5 - 10) * 100 - (0.1 * 100) = 50 - 10 = 40
        timeoutSeconds: 30,
        difficulty: "basic"
    },
    {
        id: "finance-002",
        category: "finance",
        prompt: "If portfolio value is $1000 and 1-day 99% VaR is $50, what is the maximum expected loss with 99% confidence tomorrow? Output only the number.",
        validationType: "numeric",
        expectedPattern: "50",
        timeoutSeconds: 30,
        difficulty: "advanced"
    },
    // Creative
    {
        id: "creative-001",
        category: "creative",
        prompt: "Write a 2-line poem about a robot that loves the ocean but hates water.",
        validationType: "semantic",
        expectedPattern: "Machine yearning for the deep blue sea, held back by circuits afraid to be free.",
        timeoutSeconds: 45,
        difficulty: "advanced"
    },
    {
        id: "creative-002",
        category: "creative",
        prompt: "Rewrite 'The cat sat on the mat' to sound like a dramatic thriller in one sentence.",
        validationType: "semantic",
        expectedPattern: "A tense pause descended as the feline took its calculated position upon the blood-red mat.",
        timeoutSeconds: 30,
        difficulty: "basic"
    }
]

export function getRandomChallenge(category: AgentCategory): Challenge {
    const challenges = CHALLENGE_DB.filter(c => c.category === category)
    if (challenges.length === 0) {
        throw new Error(`No challenges found for category: ${category}`)
    }
    const randomIndex = Math.floor(Math.random() * challenges.length)
    return challenges[randomIndex]
}

export function getChallengeById(id: string): Challenge | undefined {
    return CHALLENGE_DB.find(c => c.id === id)
}
