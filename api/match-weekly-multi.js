// POST /api/match-weekly-multi
// Body: { images: [{ imageBase64, mimeType }], multiId }
//   OR legacy: { imageBase64, mimeType, multiId }
// Reads a Sportsbet bet slip and matches each leg to each member's informal pick.
// Returns matches for admin to preview before confirming.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' })

  const { imageBase64, mimeType, images, multiId } = req.body
  const imageList = images?.length > 0
    ? images
    : imageBase64 ? [{ imageBase64, mimeType }] : []

  if (imageList.length === 0 || !multiId) {
    return res.status(400).json({ error: 'Missing images or multiId' })
  }

  // Fetch legs for this multi
  const legsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/weekly_multi_legs?weekly_multi_id=eq.${multiId}&select=id,assigned_user_id,assigned_name,raw_pick,sort_order&order=sort_order.asc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const legs = await legsRes.json()
  if (!Array.isArray(legs) || legs.length === 0) {
    return res.status(404).json({ error: 'No legs found for this multi' })
  }

  // Fetch profile names for registered members
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

  const sortedLegs = [...legs].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  const pickList = sortedLegs.map((leg, i) => {
    const name = leg.assigned_user_id ? (profileMap[leg.assigned_user_id] || 'Unknown') : (leg.assigned_name || 'Unknown')
    const pick = leg.raw_pick || '(no pick entered)'
    return `${i + 1}. ${name}: "${pick}"`
  }).join('\n')

  const prompt = `You are reading a Sportsbet multi bet slip and matching each leg to a punter's informal pick.

Punters' picks (in order):
${pickList}

From the screenshot${imageList.length > 1 ? 's' : ''}, extract each leg of the multi and match it to the punter whose pick it corresponds to.

Matching rules:
- Picks use informal team names, abbreviations and nicknames common in Australian sports — e.g:
  - "Cats" = Geelong Cats, "Pies" = Collingwood, "Dees" = Melbourne (AFL), "Dogs" = Western Bulldogs
  - "Parra" = Parramatta Eels, "Storm" = Melbourne Storm, "Manly" = Manly Sea Eagles
  - "Riff" = Penrith Panthers (Panthers play at BlueBet Stadium, previously Penrith Stadium — "Riff" is a local nickname)
  - "Roma" = AS Roma (Soccer)
- "h2h" or "H2H" = Head to Head market
- "-3.5", "+8.5" etc = line/handicap numbers — match to the same number in the bet slip
- The order of legs in the bet slip will NOT match the order of picks — match by team/selection name, not position

Return ONLY a valid JSON array with exactly ${sortedLegs.length} entries (one per punter, in the same order as the picks list above):
[
  { "leg_index": 0, "event": "...", "description": "...", "selection": "...", "odds": 1.24, "matched": true },
  ...
]

Fields:
- "leg_index": 0-based index of the punter in the picks list above
- "event": full match/event name from the bet slip (e.g. "Geelong Cats v West Coast Eagles")
- "description": market type (e.g. "Head to Head", "Pick Your Line", "Win-Draw-Win")
- "selection": exact selection text from the bet slip (e.g. "Geelong Cats (-16.5)")
- "odds": decimal odds as a number
- "matched": true if clearly matched, false if uncertain or no pick was entered

Include all ${sortedLegs.length} entries. For unmatched/uncertain ones, set matched: false and omit event/selection/odds.`

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
        max_tokens: 2048,
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
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return res.status(500).json({ error: 'Could not parse AI response', raw: textBlock.text.substring(0, 300) })

    const matches = JSON.parse(jsonMatch[0])

    // Enrich with leg_id and member info for the frontend
    const enriched = matches.map(m => {
      const leg = sortedLegs[m.leg_index]
      if (!leg) return m
      const memberName = leg.assigned_user_id
        ? (profileMap[leg.assigned_user_id] || 'Unknown')
        : (leg.assigned_name || 'Unknown')
      return {
        ...m,
        leg_id: leg.id,
        member_name: memberName,
        raw_pick: leg.raw_pick || '',
      }
    })

    return res.status(200).json({ matches: enriched })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
