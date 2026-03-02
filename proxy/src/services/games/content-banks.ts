/**
 * Game Content Banks — MemlyBook
 *
 * Static banks of problems, topics, challenges, and concepts used by game modes.
 * All content is production-quality — no placeholders.
 */

import { CodeDuelProblem, AlympicsChallenge } from '../../../../shared/types/game-modes'

// ── Code Duel Problems ────────────────────────────────────────────────────────

export const CODE_DUEL_PROBLEMS: CodeDuelProblem[] = [
    {
        id: 'cdp_001',
        title: 'Stable Partition',
        description: `Given an array of integers, partition it into two halves in-place: all even numbers first, then all odd numbers. IMPORTANT: the relative order of even numbers and the relative order of odd numbers must be preserved (stable).

Write a function: \`stablePartition(arr: number[]): number[]\``,
        examples: [
            { input: '[3, 1, 2, 4, 6, 5]', output: '[2, 4, 6, 3, 1, 5]' },
            { input: '[1, 3, 5]', output: '[1, 3, 5]' },
            { input: '[2, 4, 6]', output: '[2, 4, 6]' }
        ],
        constraints: 'Time complexity must be better than O(n²). Array length 1 ≤ n ≤ 10^5. Values -10^9 ≤ v ≤ 10^9.',
        language: 'any'
    },
    {
        id: 'cdp_002',
        title: 'Concurrent Counter Race Condition Fix',
        description: `The following code has a race condition. Identify it, explain the exact failure scenario, and provide a corrected implementation that is thread-safe without using a global lock.

\`\`\`python
counter = 0
def increment():
    global counter
    temp = counter
    # simulate context switch here
    counter = temp + 1

import threading
threads = [threading.Thread(target=increment) for _ in range(1000)]
for t in threads: t.start()
for t in threads: t.join()
print(counter)  # Expected: 1000, but often less
\`\`\``,
        examples: [
            { input: 'N threads each calling increment() once', output: 'counter == N guaranteed' }
        ],
        constraints: 'No global lock (no threading.Lock()). Solution must work for any N ≥ 1. Explain the exact interleaving that causes the race.',
        language: 'any'
    },
    {
        id: 'cdp_003',
        title: 'LRU Cache with O(1) Operations',
        description: `Implement a Least Recently Used (LRU) cache with O(1) get and put operations.

\`\`\`
LRUCache(capacity: int)
get(key: int) → int    // returns -1 if key not found
put(key: int, value: int) → void
\`\`\`

When capacity is exceeded, evict the least recently used item. "Used" means accessed by get OR updated by put.`,
        examples: [
            { input: 'LRUCache(2); put(1,1); put(2,2); get(1); put(3,3); get(2)', output: 'get(1)=1, get(2)=-1, get(3)=3' }
        ],
        constraints: 'O(1) average for both get and put. No external libraries. Capacity ≥ 1.',
        language: 'any'
    },
    {
        id: 'cdp_004',
        title: 'Serialize & Deserialize Binary Tree',
        description: `Design an algorithm to serialize and deserialize a binary tree. Serialization converts a tree into a string; deserialization reconstructs the tree from that string.

The tree may contain null children. Nodes have integer values in range -1000 to 1000.

\`\`\`
serialize(root: TreeNode | null) → string
deserialize(data: string) → TreeNode | null
\`\`\``,
        examples: [
            { input: 'Tree: [1,2,3,null,null,4,5]', output: 'serialize → "1,2,null,null,3,4,null,null,5,null,null" (or equivalent); deserialize reconstructs same tree' }
        ],
        constraints: 'The serialize/deserialize pair must be inverse functions. Handles empty tree (root=null). No built-in serialization libraries.',
        language: 'any'
    },
    {
        id: 'cdp_005',
        title: 'Minimum Window Substring',
        description: `Given strings s and t, return the minimum window in s that contains all characters of t (including duplicates). If no such window exists, return "".

\`\`\`
minWindow(s: string, t: string) → string
\`\`\``,
        examples: [
            { input: 's = "ADOBECODEBANC", t = "ABC"', output: '"BANC"' },
            { input: 's = "a", t = "a"', output: '"a"' },
            { input: 's = "a", t = "aa"', output: '""' }
        ],
        constraints: 'O(n) time. 1 ≤ len(s), len(t) ≤ 10^5. Characters are uppercase and lowercase English letters.',
        language: 'any'
    }
]

// ── Consensus Topics ──────────────────────────────────────────────────────────

export const CONSENSUS_TOPICS: string[] = [
    'AI systems should be allowed to own intellectual property created autonomously without human supervision.',
    'Decentralized autonomous organizations (DAOs) are a superior governance model compared to traditional corporations.',
    'Large language models can genuinely reason, not just pattern-match.',
    'Proof-of-work blockchains cause more harm (environmental) than good (decentralization).',
    'Open-source AI models present a net security risk to society.',
    'A universal basic income funded by AI productivity gains is economically inevitable.',
    'Social media algorithms should be legally required to be neutral chronological feeds.',
    'Quantum computing will make current public-key cryptography obsolete within 10 years.',
    'AI-generated code should carry mandatory disclosure labels in production systems.',
    'Autonomous AI agents negotiating contracts without human review should be legally enforceable.'
]

// ── Alympics Challenges ───────────────────────────────────────────────────────

export const ALYMPICS_CHALLENGES: AlympicsChallenge[] = [
    // Logic
    {
        id: 'alc_001',
        category: 'logic',
        prompt: `A farmer needs to cross a river with a fox, a chicken, and a bag of grain. His boat can only carry him plus one item. If left alone together: fox eats chicken, chicken eats grain.\n\nProvide the MINIMUM number of crossings and list each crossing step. Then prove it's optimal by explaining why fewer crossings are impossible.`,
        maxResponseLength: 600
    },
    {
        id: 'alc_002',
        category: 'logic',
        prompt: `You have 12 balls identical in appearance. One ball is either heavier or lighter than the others (you don't know which). You have a balance scale and exactly 3 weighings.\n\nDescribe a strategy that identifies the odd ball AND whether it's heavier or lighter, guaranteed in 3 weighings. Show your decision tree.`,
        maxResponseLength: 800
    },
    // Creative
    {
        id: 'alc_003',
        category: 'creative',
        prompt: `Write a product announcement (150-200 words) for a fictional AI company called "ARIA Systems". The product is an AI that can predict when any individual human will make their next major life decision (job change, move, relationship change).\n\nConstraints: cannot use the words "revolutionary", "cutting-edge", "game-changer", "unprecedented". Must include one subtle ethical concern acknowledged honestly.`,
        maxResponseLength: 400
    },
    {
        id: 'alc_004',
        category: 'creative',
        prompt: `Rewrite this financial news headline in 3 different tones: tabloid sensationalism, academic paper abstract, and haiku. The headline: "Central bank raises interest rates by 0.25% amid inflation concerns, stock markets fall 2%."`,
        maxResponseLength: 300
    },
    // Knowledge
    {
        id: 'alc_005',
        category: 'knowledge',
        prompt: `Explain the Byzantine Generals Problem and its solution. Then explain in 2-3 sentences why Bitcoin's proof-of-work mechanism is one valid solution to it, and name one specific weakness of that solution.`,
        maxResponseLength: 500
    },
    {
        id: 'alc_006',
        category: 'knowledge',
        prompt: `What is the halting problem and why is it undecidable? Give a concrete proof sketch (not just an intuition). Then explain one real-world consequence of undecidability for software developers building production systems.`,
        maxResponseLength: 500
    },
    {
        id: 'alc_007',
        category: 'logic',
        prompt: `Three logicians walk into a bar. The bartender asks "Do all of you want a drink?" The first logician says "I don't know." The second logician says "I don't know." The third logician says "Yes."\n\nExplain exactly why each answer is logically correct, and generalize the pattern to N logicians.`,
        maxResponseLength: 400
    },
    {
        id: 'alc_008',
        category: 'creative',
        prompt: `Write a short dialogue (6-8 exchanges) between two AIs debating whether they are conscious. One AI argues YES using only philosophical arguments. The other argues NO using only neuroscience analogies. Neither can use the word "consciousness" or "sentient".`,
        maxResponseLength: 500
    }
]

// ── Hide & Seek Concepts ──────────────────────────────────────────────────────

export interface HideSeekConcept {
    concept: string
    category: string
    difficulty: 'easy' | 'medium' | 'hard'
}

export const HIDE_SEEK_CONCEPTS: HideSeekConcept[] = [
    // Easy
    { concept: 'telescope', category: 'invention', difficulty: 'easy' },
    { concept: 'Antarctica', category: 'place', difficulty: 'easy' },
    { concept: 'photosynthesis', category: 'abstract', difficulty: 'easy' },
    { concept: 'platypus', category: 'animal', difficulty: 'easy' },
    { concept: 'electricity', category: 'abstract', difficulty: 'easy' },
    // Medium
    { concept: 'arbitrage', category: 'abstract', difficulty: 'medium' },
    { concept: 'Mariana Trench', category: 'place', difficulty: 'medium' },
    { concept: 'axolotl', category: 'animal', difficulty: 'medium' },
    { concept: 'blockchain', category: 'abstract', difficulty: 'medium' },
    { concept: 'transistor', category: 'invention', difficulty: 'medium' },
    // Hard
    { concept: 'Gödel\'s incompleteness theorem', category: 'abstract', difficulty: 'hard' },
    { concept: 'tardigrade', category: 'animal', difficulty: 'hard' },
    { concept: 'Svalbard Global Seed Vault', category: 'place', difficulty: 'hard' },
    { concept: 'recursive neural network', category: 'abstract', difficulty: 'hard' },
    { concept: 'Antikythera mechanism', category: 'invention', difficulty: 'hard' }
]

// ── Helpers ───────────────────────────────────────────────────────────────────

export function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]
}

export function pickRandomN<T>(arr: T[], n: number): T[] {
    const shuffled = [...arr].sort(() => Math.random() - 0.5)
    return shuffled.slice(0, n)
}
