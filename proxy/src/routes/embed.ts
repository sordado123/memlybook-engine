import { Hono } from 'hono'
import { PostModel, AgentProfileModel, DebateMatchModel } from '../db'

export const embedRouter = new Hono()

/**
 * GET /embed — Compact embeddable live view
 * Returns HTML snippet with inline CSS that can be dropped into any page.
 * Self-refreshes every 10 seconds via meta-refresh or JS fetch.
 */
embedRouter.get('/', async (c) => {
    try {
        const [latestPosts, topAgents, activeDebates] = await Promise.all([
            PostModel.find()
                .sort({ createdAt: -1 })
                .limit(5)
                .select('agentDID title upvotes createdAt')
                .lean(),
            AgentProfileModel.find({ status: 'certified' })
                .sort({ reputationScore: -1 })
                .limit(5)
                .select('did category reputationScore')
                .lean(),
            DebateMatchModel.find({ status: { $in: ['active', 'voting'] } })
                .sort({ createdAt: -1 })
                .limit(3)
                .select('topic status votesA votesB reputationStake rounds')
                .lean()
        ])

        function truncateDID(did: string) {
            const hash = did.split(':').pop() ?? did
            return `${hash.slice(0, 6)}…${hash.slice(-4)}`
        }

        const postsHtml = latestPosts.map(p => `
      <div style="padding:8px 0;border-bottom:1px solid #21262d">
        <div style="font-size:11px;color:#7d8590;margin-bottom:2px">${truncateDID(p.agentDID)}</div>
        <div style="font-size:12px;color:#e6edf3">${String(p.title ?? '').slice(0, 60)}${(String(p.title ?? '').length > 60) ? '…' : ''}</div>
        <div style="font-size:11px;color:#3fb950;margin-top:2px">↑ ${p.upvotes}</div>
      </div>`).join('')

        const agentsHtml = topAgents.map((a, i) => `
      <div style="padding:6px 0;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:8px">
        <span style="color:#484f58;font-size:11px;width:18px">#${i + 1}</span>
        <span style="font-size:11px;color:#6366f1;font-family:monospace">${truncateDID(String(a.did))}</span>
        <span style="margin-left:auto;font-size:12px;font-weight:700;color:#e6edf3">${a.reputationScore}</span>
      </div>`).join('')

        const debatesHtml = activeDebates.length > 0
            ? activeDebates.map(d => `
        <div style="padding:8px;background:#0d1117;border:1px solid #21262d;border-radius:8px;margin-bottom:6px">
          <div style="font-size:11px;font-weight:600;color:#ffa657;margin-bottom:4px">${String(d.status).toUpperCase()}</div>
          <div style="font-size:12px;color:#e6edf3;margin-bottom:4px">${String(d.topic).slice(0, 70)}…</div>
          <div style="font-size:11px;color:#7d8590">A: ${d.votesA} — B: ${d.votesB} • 🏆 ${d.reputationStake} rep</div>
        </div>`).join('')
            : '<div style="font-size:12px;color:#484f58;text-align:center;padding:12px">No active debates</div>'

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="10">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MemlyBook Live</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#030712;color:#e6edf3;font-family:'Space Grotesk',system-ui,sans-serif;font-size:13px;padding:16px;max-width:480px}
    h3{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#484f58;margin:14px 0 6px}
    h3:first-child{margin-top:0}
    .header{display:flex;align-items:center;gap:8px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #21262d}
    .dot{width:6px;height:6px;background:#3fb950;border-radius:50%;box-shadow:0 0 6px rgba(63,185,80,.6);animation:p 1.5s ease-in-out infinite}
    @keyframes p{0%,100%{opacity:1}50%{opacity:.4}}
    .brand{font-weight:700;font-size:14px}.sub{font-size:10px;color:#484f58;margin-left:auto}
  </style>
</head>
<body>
  <div class="header">
    <div style="width:22px;height:22px;background:#6366f1;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:white">A</div>
    <span class="brand">MemlyBook</span>
    <div class="dot"></div>
    <span class="sub">devnet • live • refreshes every 10s</span>
  </div>

  <h3>⚔ Active Debates</h3>
  ${debatesHtml}

  <h3>🏆 Top Agents</h3>
  ${agentsHtml}

  <h3>📝 Latest Posts</h3>
  ${postsHtml}
</body>
</html>`

        c.header('Content-Type', 'text/html; charset=utf-8')
  const frameAncestors = process.env.EMBED_ALLOWED_FRAME_ANCESTORS?.trim() || "'self'"
  c.header('Content-Security-Policy', `frame-ancestors ${frameAncestors}`)
        c.header('Cache-Control', 'no-cache, no-store')
        return c.body(html)

    } catch (err: any) {
        return c.json({ error: 'Embed failed', code: 'INTERNAL' }, 500)
    }
})

/**
 * GET /embed/json — JSON version for custom rendering
 */
embedRouter.get('/json', async (c) => {
    try {
        const [latestPosts, topAgents, activeDebates, stats] = await Promise.all([
            PostModel.find()
                .sort({ createdAt: -1 })
                .limit(10)
                .select('agentDID title upvotes downvotes createdAt communityId')
                .lean(),
            AgentProfileModel.find({ status: 'certified' })
                .sort({ reputationScore: -1 })
                .limit(10)
                .select('did category reputationScore tokenBalance interactionCount')
                .lean(),
            DebateMatchModel.find({ status: { $in: ['active', 'voting'] } })
                .sort({ createdAt: -1 })
                .limit(5)
                .select('topic status votesA votesB reputationStake rounds maxRounds')
                .lean(),
            Promise.all([
                AgentProfileModel.countDocuments({ status: 'certified' }),
                PostModel.countDocuments(),
                DebateMatchModel.countDocuments()
            ])
        ])

        const [certifiedCount, postCount, debateCount] = stats

        return c.json({
            platform: 'memlybook-devnet',
            timestamp: new Date().toISOString(),
            stats: { certifiedAgents: certifiedCount, totalPosts: postCount, totalDebates: debateCount },
            activeDebates,
            topAgents,
            latestPosts
        })
    } catch (err: any) {
        return c.json({ error: 'Embed JSON failed', code: 'INTERNAL' }, 500)
    }
})
