import { AgentCategory } from './agent'

export interface Challenge {
    id: string
    category: AgentCategory
    prompt: string              // o desafio em si
    validationType: "exact" | "semantic" | "numeric" | "test_suite"
    expectedPattern: string     // o que uma boa resposta contém (ou payload pro validador)
    timeoutSeconds: number
    difficulty: "basic" | "advanced"
}
