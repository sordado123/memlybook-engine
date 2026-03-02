/**
 * Threat Service — Weekly Siege
 *
 * Generates and manages the weekly threat using population-based dynamic balancing.
 * The threat strength always scales with the number of active agents.
 */

import { AgentProfileModel, SiegeWeekModel } from '../../db'
import {
    SiegeWeek, TENSION_FACTOR, COLD_START_DEF_PER_AGENT
} from '../../../../shared/types/siege'

/** Threat name generator — procedural names for flavor */
const THREAT_PREFIXES = [
    'Shadow', 'Crimson', 'Void', 'Phantom', 'Iron',
    'Obsidian', 'Rogue', 'Spectral', 'Neon', 'Digital'
]
const THREAT_SUFFIXES = [
    'Protocol', 'Swarm', 'Breach', 'Cascade', 'Legion',
    'Incursion', 'Anomaly', 'Surge', 'Tempest', 'Eclipse'
]

function generateThreatName(): string {
    const prefix = THREAT_PREFIXES[Math.floor(Math.random() * THREAT_PREFIXES.length)]
    const suffix = THREAT_SUFFIXES[Math.floor(Math.random() * THREAT_SUFFIXES.length)]
    return `${prefix} ${suffix}`
}

/** Get average defense contribution per agent from last 4 completed sieges */
export async function getAvg4WeeksContribution(): Promise<number> {
    const history = await SiegeWeekModel
        .find({ phase: 'completed' })
        .sort({ createdAt: -1 })
        .limit(4)
        .lean<SiegeWeek[]>()

    if (history.length === 0) return COLD_START_DEF_PER_AGENT

    const avg = history.reduce((s, w) => s + w.avgDefPerAgent, 0) / history.length
    return avg
}

/** Get count of active (certified) agents on the platform */
export async function getActiveAgentCount(): Promise<number> {
    return AgentProfileModel.countDocuments({ status: 'certified' })
}

/**
 * Calculate the actual threat strength for the siege.
 * Always proportional to population × historical average contribution.
 */
export async function calculateThreatStrength(): Promise<number> {
    const agents = await getActiveAgentCount()
    const historicalAvg = await getAvg4WeeksContribution()
    const theoreticalMax = agents * historicalAvg
    const baseStrength = Math.floor(theoreticalMax * TENSION_FACTOR)

    // ±15% variance
    const variance = 0.15
    const modifier = 1 + (Math.random() * variance * 2) - variance
    return Math.floor(baseStrength * modifier)
}

/**
 * Calculate the estimated range shown to agents on Monday (±30% from actual).
 * Keeps the real strength secret until Saturday reveal.
 */
export function calculateEstimatedRange(actualStrength: number): { min: number; max: number } {
    const fuzz = 0.30
    return {
        min: Math.floor(actualStrength * (1 - fuzz)),
        max: Math.floor(actualStrength * (1 + fuzz))
    }
}

/**
 * Generate the full threat object for a new siege week.
 * Called on Monday 00:00 UTC.
 */
export async function generateThreat(): Promise<{
    name: string
    estimatedRange: { min: number; max: number }
    actualStrength: number
}> {
    const name = generateThreatName()
    const actualStrength = await calculateThreatStrength()
    const estimatedRange = calculateEstimatedRange(actualStrength)

    return { name, estimatedRange, actualStrength }
}
