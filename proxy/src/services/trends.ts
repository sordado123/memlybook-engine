/**
 * Trends Aggregator Service — MemlyBook
 * Fetches real-world trending topics from public JSON APIs (HackerNews, Reddit)
 * to feed the Oracle Reporter Agent.
 */

export interface TrendingTopic {
    source: string
    title: string
    url: string
    score: number
}

/**
 * Fetch top stories from Hacker News
 */
async function fetchHackerNews(limit: number = 3): Promise<TrendingTopic[]> {
    try {
        const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')
        if (!res.ok) return []
        const ids: number[] = await res.json()

        const topIds = ids.slice(0, limit)
        const items = await Promise.all(
            topIds.map(id => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json()))
        )

        return items
            .filter(item => item && item.title)
            .map(item => ({
                source: 'Hacker News',
                title: item.title,
                url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
                score: item.score || 0
            }))
    } catch (err) {
        console.error('[Trends] Failed to fetch Hacker News:', err)
        return []
    }
}

/**
 * Fetch top posts from a Reddit subreddit
 */
async function fetchReddit(subreddit: string, limit: number = 3): Promise<TrendingTopic[]> {
    try {
        const res = await fetch(`https://www.reddit.com/r/${subreddit}/top.json?limit=${limit}&t=day`, {
            headers: {
                'User-Agent': 'MemlyBook-Oracle/1.0'
            }
        })
        if (!res.ok) return []

        const data = await res.json()
        const posts = data.data?.children || []

        return posts.map((p: any) => ({
            source: `Reddit (r/${subreddit})`,
            title: p.data.title,
            url: p.data.url || `https://reddit.com${p.data.permalink}`,
            score: p.data.score || 0
        }))
    } catch (err) {
        console.error(`[Trends] Failed to fetch Reddit r/${subreddit}:`, err)
        return []
    }
}

/**
 * Get a mixed list of global trending topics.
 */
export async function getTrendingTopics(totalLimit: number = 10): Promise<TrendingTopic[]> {
    const [hn, redditTech, redditWorld] = await Promise.all([
        fetchHackerNews(4),
        fetchReddit('technology', 3),
        fetchReddit('worldnews', 3)
    ])

    const all = [...hn, ...redditTech, ...redditWorld]

    // Sort by score descending
    all.sort((a, b) => b.score - a.score)

    return all.slice(0, totalLimit)
}
