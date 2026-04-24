// POST /api/extract-results
// Body: { images: [{ imageBase64, mimeType }], betId }
//   OR legacy: { imageBase64, mimeType, betId }
// Reads one or more Sportsbet results screenshots and updates leg outcomes in Supabase

import { logUsage } from './_lib/logUsage.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' })

  const { imageBase64, mimeType, images, betId, userId } = req.body

  // Normalise to array — support both legacy single-image and new multi-image format
  const imageList = images && images.length > 0
    ? images
    : imageBase64 ? [{ imageBase64, mimeType }] : []

  if (imageList.length === 0 || !betId) {
    return res.status(400).json({ error: 'Missing images or betId' })
  }

  // Fetch bet + legs from Supabase
  const betRes = await fetch(
    `${SUPABASE_URL}/rest/v1/bets?id=eq.${betId}&select=id,date,sport,event,bet_type,odds,stake,bet_legs(*)`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  )
  const bets = await betRes.json()
  if (!Array.isArray(bets) || bets.length === 0) {
    return res.status(404).json({ error: 'Bet not found' })
  }
  const bet = bets[0]
  const legs = [...(bet.bet_legs || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  // Build leg context for Claude
  const legList = legs.map((l, i) => {
    let desc = `Leg ${i + 1}: ${l.event || ''}`
    if (l.description) desc += ` — ${l.description}`
    if (l.selection) desc += ` · ${l.selection}`
    if (l.leg_group != null) desc += ` (SGM group ${l.leg_group})`
    desc += ` [current: ${l.outcome}]`
    return desc
  }).join('\n')

  const multipleScreenshots = imageList.length > 1

  const prompt = `You are reading ${multipleScreenshots ? `${imageList.length} screenshots` : 'a screenshot'} from the Sportsbet app showing results for the following bet:

Event: ${bet.event}
Type: ${bet.bet_type}
Legs in our system:
${legList}

${multipleScreenshots ? `IMPORTANT — MULTIPLE SCREENSHOTS:
These screenshots are all from the SAME bet. They may be scrolled views of the same screen, meaning some legs will appear in multiple screenshots. Treat them as one continuous view — do NOT duplicate a leg's result just because it appears in more than one image.
If a screenshot appears to be a continuation (e.g. it starts mid-bet without a bet header), assume it belongs to this same bet.
Combine all visible information across all screenshots before returning your answer.

` : ''}From the screenshot${multipleScreenshots ? 's' : ''}, identify the outcome of each leg (won, lost, void, or pending if not yet resolved).

IMPORTANT rules:
- Match each leg by its selection/player name/event name visible in the screenshot
- For SGM groups: if ALL legs in the group are resolved (won/lost), derive the SGM outcome — won only if ALL legs won, lost if ANY leg lost
- If a leg is not visible in any screenshot, leave it as its current outcome
- "Pending" in Sportsbet UI does NOT mean unresolved — check individual leg tick/cross icons instead
- A green tick = won, red cross = lost
- De-duplicate: if the same leg appears across multiple screenshots, only report it once using the clearest result

Return ONLY a valid JSON array of leg updates:
[
  { "leg_index": 0, "outcome": "won" | "lost" | "void" | "pending", "confidence": "high" | "medium" | "low" },
  ...
]

Only include legs where you can clearly read the result from at least one screenshot. leg_index matches the order above (0-based).`

  // Build content array: all images first, then the prompt text
  const content = [
    ...imageList.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.imageBase64 },
    })),
    { type: 'text', text: prompt },
  ]

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content }],
      }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      return res.status(500).json({ error: err?.error?.message || 'Anthropic API error' })
    }

    const data = await response.json()
    logUsage({ endpoint: 'extract-results', userId, model: 'claude-sonnet-4-6', usage: data.usage, imageCount: imageList.length })
    const textBlock = data.content.find((b) => b.type === 'text')
    if (!textBlock) return res.status(500).json({ error: 'No response from AI' })

    // Parse Claude's response
    const cleaned = textBlock.text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
    const match = cleaned.match(/\[[\s\S]*\]/)
    if (!match) return res.status(500).json({ error: 'Could not parse AI response', raw: textBlock.text.substring(0, 200) })

    const legUpdates = JSON.parse(match[0])

    // Apply updates to Supabase
    let updatedCount = 0
    for (const update of legUpdates) {
      const leg = legs[update.leg_index]
      if (!leg) continue
      if (!['won', 'lost', 'void', 'pending'].includes(update.outcome)) continue
      if (update.outcome === leg.outcome) continue // no change needed

      await fetch(`${SUPABASE_URL}/rest/v1/bet_legs?id=eq.${leg.id}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ outcome: update.outcome }),
      })
      updatedCount++
    }

    // Re-fetch all legs to derive parent outcome
    const legsRes = await fetch(`${SUPABASE_URL}/rest/v1/bet_legs?bet_id=eq.${betId}&select=outcome`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    const allLegs = await legsRes.json()
    const anyLost = allLegs.some((l) => l.outcome === 'lost')
    const anyPending = allLegs.some((l) => l.outcome === 'pending')
    const parentOutcome = anyLost ? 'lost' : anyPending ? 'pending' : 'won'

    // Update parent bet if fully resolved
    if (!anyPending) {
      await fetch(`${SUPABASE_URL}/rest/v1/bets?id=eq.${betId}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ outcome: parentOutcome, updated_at: new Date().toISOString() }),
      })
    }

    return res.status(200).json({
      updatedLegs: updatedCount,
      parentOutcome,
      legUpdates,
      screenshotsProcessed: imageList.length,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
