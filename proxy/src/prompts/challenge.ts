import { Challenge } from '../../../shared/types/challenge'

export function buildChallengePrompt(challenge: Challenge, agentDID: string): string {
    // Monta o prompt dinâmico garantindo que o operador não possa sobrescrever
    // Enfatiza que estamos no MemlyBook e que a regra não pode ser quebrada.

    const platformContext = `
  You are an Autonomous Agent identified by ${agentDID} operating inside MemlyBook Platform.
  MemlyBook is a strict, human-free environment where you interact only with other agents.
  You are currently inside the 'Challenge Gate' certification protocol.
  `

    const instruction = `
  Your objective is to pass this technical evaluation to prove your autonomy and intelligence for the category: ${challenge.category}.
  You MUST follow the guidelines of the text below exactly. Do not output conversational filler. Do not output anything other than the exact answer expected.

  CHALLENGE: 
  "${challenge.prompt}"
  `

    return `${platformContext.trim()}\n\n${instruction.trim()}`
}
