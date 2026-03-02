/**
 * Tiles Service — Weekly Siege
 *
 * Handles tile placement with optimistic locking, zone assignment,
 * cluster bonus calculation, and attack damage resolution.
 */

import { v4 as uuidv4 } from 'uuid'
import { SiegeTileModel } from '../../db'
import {
    TileType, ZoneName, SiegeTile,
    TILE_ZONE_PREFERENCE, CLUSTER_BONUS_PERCENT, getZoneCount
} from '../../../../shared/types/siege'

const ALL_ZONES: ZoneName[] = ['north', 'east', 'south', 'west', 'center']

/** Grid size per zone — grows with zone count but stays manageable */
function getZoneGridSize(zoneCount: number): number {
    return Math.ceil(Math.sqrt(zoneCount * 10))
}

/** Find an available position for a new tile using optimistic lock */
export async function placeTile(
    agentDID: string,
    tileType: TileType,
    weekId: string,
    defenseValue: number,
    agentCount: number
): Promise<SiegeTile | null> {
    const preferredZone = TILE_ZONE_PREFERENCE[tileType]
    const zoneCount = getZoneCount(agentCount)
    const gridSize = getZoneGridSize(zoneCount)

    // Try to find adjacent position to agent's existing tiles in preferred zone
    const agentTiles = await SiegeTileModel.find({
        weekId,
        builtBy: agentDID,
        state: 'active'
    }).lean<SiegeTile[]>()

    const adjacentPos = await findAdjacentEmpty(weekId, agentTiles, preferredZone, gridSize)
    const position = adjacentPos ?? await findEmptyInZone(weekId, preferredZone, gridSize)

    if (!position) return null // zone is full — shouldn't happen with reasonable grid sizes

    const tileId = uuidv4()
    const tile: SiegeTile = {
        id: tileId,
        weekId,
        type: tileType,
        builtBy: agentDID,
        defenseValue,
        position,
        hp: defenseValue, // HP = defense value initially
        state: 'active',
        zone: preferredZone,
        createdAt: new Date()
    }

    // Optimistic lock: upsert only if position is empty
    // The unique index on {weekId, position.x, position.y} prevents collisions
    try {
        await new SiegeTileModel(tile).save()
        return tile
    } catch (err: any) {
        if (err.code === 11000) {
            // Position was taken by another agent — try fallback positions
            for (const zone of ALL_ZONES.filter(z => z !== preferredZone)) {
                const fallbackPos = await findEmptyInZone(weekId, zone, gridSize)
                if (fallbackPos) {
                    tile.position = fallbackPos
                    tile.zone = zone
                    try {
                        await new SiegeTileModel(tile).save()
                        return tile
                    } catch { continue }
                }
            }
            return null
        }
        throw err
    }
}

/** Find position adjacent to agent's existing tiles in a given zone */
async function findAdjacentEmpty(
    weekId: string,
    agentTiles: SiegeTile[],
    zone: ZoneName,
    gridSize: number
): Promise<{ x: number; y: number } | null> {
    const tilesInZone = agentTiles.filter(t => t.zone === zone)
    if (tilesInZone.length === 0) return null

    const zoneOffset = getZoneOffset(zone, gridSize)
    const directions = [
        { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
        { dx: 0, dy: 1 }, { dx: 0, dy: -1 }
    ]

    for (const tile of tilesInZone) {
        for (const { dx, dy } of directions) {
            const candidate = { x: tile.position.x + dx, y: tile.position.y + dy }

            // Check bounds
            if (candidate.x < zoneOffset.x || candidate.x >= zoneOffset.x + gridSize) continue
            if (candidate.y < zoneOffset.y || candidate.y >= zoneOffset.y + gridSize) continue

            // Check if position is free
            const occupied = await SiegeTileModel.findOne({
                weekId,
                'position.x': candidate.x,
                'position.y': candidate.y
            }).lean()

            if (!occupied) return candidate
        }
    }
    return null
}

/** Find any empty position in a zone */
async function findEmptyInZone(
    weekId: string,
    zone: ZoneName,
    gridSize: number
): Promise<{ x: number; y: number } | null> {
    const offset = getZoneOffset(zone, gridSize)

    // Find all occupied positions in zone
    const occupied = await SiegeTileModel.find({
        weekId,
        zone,
    }).select('position').lean()

    const occupiedSet = new Set(occupied.map(t => `${t.position.x},${t.position.y}`))

    for (let x = offset.x; x < offset.x + gridSize; x++) {
        for (let y = offset.y; y < offset.y + gridSize; y++) {
            if (!occupiedSet.has(`${x},${y}`)) {
                return { x, y }
            }
        }
    }
    return null
}

/** Get grid offset for each zone so they don't overlap */
function getZoneOffset(zone: ZoneName, gridSize: number): { x: number; y: number } {
    const spacing = gridSize + 2
    switch (zone) {
        case 'north': return { x: spacing, y: 0 }
        case 'east': return { x: spacing * 2, y: spacing }
        case 'south': return { x: spacing, y: spacing * 2 }
        case 'west': return { x: 0, y: spacing }
        case 'center': return { x: spacing, y: spacing }
    }
}

/**
 * Calculate cluster bonus per zone.
 * Adjacent same-type tiles grant +20% defense to their zone.
 */
export async function calculateClusterBonus(weekId: string): Promise<Record<ZoneName, number>> {
    const bonuses: Record<ZoneName, number> = {
        north: 0, east: 0, south: 0, west: 0, center: 0
    }

    for (const zone of ALL_ZONES) {
        const tiles = await SiegeTileModel.find({
            weekId, zone, state: 'active'
        }).lean<SiegeTile[]>()

        if (tiles.length < 2) continue

        let hasCluster = false
        const posMap = new Map<string, TileType>()
        tiles.forEach(t => posMap.set(`${t.position.x},${t.position.y}`, t.type))

        for (const tile of tiles) {
            const neighbors = [
                `${tile.position.x + 1},${tile.position.y}`,
                `${tile.position.x - 1},${tile.position.y}`,
                `${tile.position.x},${tile.position.y + 1}`,
                `${tile.position.x},${tile.position.y - 1}`,
            ]
            for (const key of neighbors) {
                if (posMap.get(key) === tile.type) {
                    hasCluster = true
                    break
                }
            }
            if (hasCluster) break
        }

        if (hasCluster) {
            bonuses[zone] = CLUSTER_BONUS_PERCENT
        }
    }

    return bonuses
}

/**
 * Resolve attack damage: destroy tiles starting from weakest zones,
 * targeting tiles with lowest HP first.
 */
export async function resolveAttack(weekId: string, damage: number): Promise<string[]> {
    const destroyedIds: string[] = []
    let remainingDamage = damage

    // Get defense totals per zone
    const zoneDefense: { zone: ZoneName; total: number }[] = []
    for (const zone of ALL_ZONES) {
        const total = await SiegeTileModel.aggregate([
            { $match: { weekId, zone, state: 'active' } },
            { $group: { _id: null, total: { $sum: '$defenseValue' } } }
        ])
        zoneDefense.push({ zone, total: total[0]?.total ?? 0 })
    }

    // Sort zones by defense ascending (weakest first)
    zoneDefense.sort((a, b) => a.total - b.total)

    for (const { zone } of zoneDefense) {
        if (remainingDamage <= 0) break

        // Get tiles in this zone sorted by HP ascending (weakest tiles first)
        const tiles = await SiegeTileModel.find({
            weekId, zone, state: 'active'
        }).sort({ hp: 1 }).lean<SiegeTile[]>()

        for (const tile of tiles) {
            if (remainingDamage <= 0) break

            if (remainingDamage >= tile.hp) {
                remainingDamage -= tile.hp
                await SiegeTileModel.updateOne(
                    { id: tile.id },
                    { $set: { state: 'destroyed', hp: 0 } }
                )
                destroyedIds.push(tile.id)
            } else {
                await SiegeTileModel.updateOne(
                    { id: tile.id },
                    { $inc: { hp: -remainingDamage } }
                )
                remainingDamage = 0
            }
        }
    }

    return destroyedIds
}
