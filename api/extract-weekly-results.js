// POST /api/extract-weekly-results
// Body: { images: [{ imageBase64, mimeType }], multiId }
// Reads results screenshots and updates weekly_multi_legs outcomes in Supabase

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' })

  const { imageBase64, mimeType, images, multiId } = req.body
  const imageList = images && images.length > 0
    ? images
    : imageBase64 ? [{ imageBase64, mimeType }] : []

  if (imageList.length === 0 || !multiId) {
    return res.status(400).json({ error: 'Missing images or multiId' })
  }

  // Fetch weekly multi + legs
  const multiRes = await fetch(
    `${SUPABASE_URL}/rest/v1/weekly_multis?id=eq.${multiId}&select=id,week_label,stake,weekly_multi_legs(*)`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const multis = await multiRes.json()
  if (!Array.isArray(multis) || multis.length === 0) {
    return res.status(404).json({ error: 'Weekly multi not found' })
  }
  const multi = multis[0]
  const legs = [...(multi.weekly_multi_legs || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  if (legs.length === 0) return res.status(400).json({ error: 'No legs found for this multi' })

  // Fetch member names
  const userIds = legs.filter(l => l.assigned_user_id).map(l => l.assigned_user_id)
  let profileMap = {}
  if (userIds.length > 0) {
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=in.(${userIds.join(',')})&select=id,full_name,username`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    )
    const profiles = await profileRes.json()
    profiles.forEach(p => { profileMap[p.id] = p.full_name || p.username })
  }

  const legList = legs.map((l, i) => {
    const name = l.assigned_user_id ? (profileMap[l.assigned_user_id] || 'Unknown') : (l.assigned_name || 'Unknown')
    let desc = `Leg ${i + 1} (${name}): ${l.event || l.selection || '?'}`
    if (l.description) desc += ` — ${l.description}`
    if (l.selection && l.event) desc += ` · ${l.selection}`
    desc += ` [current: ${l.outcome}]`
    return desc
  }).join('\n')

  const multipleScreenshots = imageList.length > 1

  const prompt = `You are reading ${multipleScreenshots ? `${imageList.length} screenshots` : 'a screenshot'} from the Sportsbet app showing results for a group multi bet called "${multi.week_label}".

Legs in this multi:
${legList}

${multipleScreenshots ? `IMPORTANT — MULTIPLE SCREENSHOTS:
These are all from the SAME multi bet. Treat them as one continuous view — do NOT duplicate a leg's result.
Combine all information across all screenshots before returning your answer.

` : ''}From the screenshot${multipleScreenshots ? 's' : ''}, identify the outcome of each leg (won, lost, void, or pending if not yet resolved).

Rules:
- Match each leg by its selection/event name visible in the screenshot
- A green tick = won, red cross = lost
- If a leg is not visible, leave it as its current outcome
- De-duplicate: if the same leg appears across multiple screenshots, report it once using the clearest result

Return ONLY a valid JSON array:
[
  { "leg_index": 0, "outcome": "won" | "lost" | "void" | "pending", "confidence": "high" | "medium" | "low" },
  ...
]

Only include legs where you can clearly read the result. leg_index is 0-based matching the list above.`

  const content = [
    ...imageList.map(img => ({
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
    const textBlock = data.content.find(b => b.type === 'text')
    if (!textBlock) return res.status(500).json({ error: 'No response from AI' })

    const cleaned = textBlock.text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
    const match = cleaned.match(/\[[\s\S]*\]/)
    if (!match) return res.status(500).json({ error: 'Could not parse AI response', raw: textBlock.text.substring(0, 200) })

    const legUpdates = JSON.parse(match[0])

    let updatedCount = 0
    for (const update of legUpdates) {
      const leg = legs[update.leg_index]
      if (!leg) continue
      if (!['won', 'lost', 'void', 'pending'].includes(update.outcome)) continue
      if (update.outcome === leg.outcome) continue

      await fetch(`${SUPABASE_URL}/rest/v1/weekly_multi_legs?id=eq.${leg.id}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ outcome: update.outcome, updated_at: new Date().toISOString() }),
      })
      updatedCount++
    }

    // Re-fetch legs to derive multi outcome and auto-mark resulted
    const legsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/weekly_multi_legs?weekly_multi_id=eq.${multiId}&select=outcome`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    )
    const allLegs = await legsRes.json()
    const nonVoid = allLegs.filter(l => l.outcome !== 'void')
    const anyPending = nonVoid.some(l => l.outcome === 'pending')
    const anyLost = nonVoid.some(l => l.outcome === 'lost')
    const multiOutcome = anyPending ? 'pending' : anyLost ? 'lost' : 'won'

    // Auto-mark as resulted if fully resolved
    if (!anyPending) {
      await fetch(`${SUPABASE_URL}/rest/v1/weekly_multis?id=eq.${multiId}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ status: 'resulted' }),
      })
    }

    return res.status(200).json({ updatedLegs: updatedCount, multiOutcome, screenshotsProcessed: imageList.length })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
