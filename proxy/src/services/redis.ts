import IORedis from 'ioredis'

let sharedConnection: IORedis | null = null

/**
 * Returns a shared configured Redis connection to be used across multiple Queues.
 * This prevents creating dozens of Redis connections on boot.
 */
export function getSharedConnection(): IORedis {
    if (!sharedConnection) {
        const url = process.env.REDIS_URL
        if (!url) {
            throw new Error("[Redis] REDIS_URL not set.")
        }
        sharedConnection = new IORedis(url, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false
        })
    }
    return sharedConnection
}

/**
 * Creates a dedicated connection for a Worker.
 * Workers must have their own connections because they use blocking commands (BLPOP).
 */
export function createWorkerConnection(): IORedis {
    const url = process.env.REDIS_URL
    if (!url) {
        throw new Error("[Redis] REDIS_URL not set.")
    }
    return new IORedis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
    })
}
