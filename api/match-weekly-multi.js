// POST /api/match-weekly-multi
// Body: { images: [{ imageBase64, mimeType }], multiId }
//   OR legacy: { imageBase64, mimeType, multiId }
// Reads a Sportsbet bet slip and matches each leg to each member's informal pick.
// Returns matches for admin to preview before confirming.

import { logUsage } from './_lib/logUsage.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' })

  const { imageBase64, mimeType, images, multiId, userId } = req.body
  const imageList = images?.length > 0
    ? images
    : imageBase64 ? [{ imageBase64, mimeType }] : []

  if (imageList.length === 0 || !multiId) {
    return res.status(400).json({ error: 'Missing images or multiId' })
  }

  // Fetch legs for this multi (omit raw_pick if it doesn't exist yet — graceful fallback)
  const legsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/weekly_multi_legs?weekly_multi_id=eq.${multiId}&select=id,assigned_user_id,assigned_name,raw_pick,sort_order&order=sort_order.asc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  let legs = await legsRes.json()

  // If raw_pick column doesn't exist yet, retry without it
  if (!Array.isArray(legs)) {
    const retry = await fetch(
      `${SUPABASE_URL}/rest/v1/weekly_multi_legs?weekly_multi_id=eq.${multiId}&select=id,assigned_user_id,assigned_name,sort_order&order=sort_order.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    )
    legs = await retry.json()
  }

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
  const currentYear = new Date().getFullYear()

  const pickList = sortedLegs.map((leg, i) => {
    const name = leg.assigned_user_id ? (profileMap[leg.assigned_user_id] || 'Unknown') : (leg.assigned_name || 'Unknown')
    const pick = leg.raw_pick || '(no pick entered)'
    return `${i + 1}. ${name}: "${pick}"`
  }).join('\n')

  const prompt = `You are reading a Sportsbet multi bet slip and matching each leg to a punter's informal pick.

Punters' picks (in order):
${pickList}

From the screenshot${imageList.length > 1 ? 's' : ''}, extract every leg of the multi and match them to punters' picks.

Matching rules:
- Picks use informal team names, abbreviations and nicknames common in Australian sports — e.g:
  - "Cats" = Geelong Cats, "Pies" = Collingwood, "Dees" = Melbourne (AFL), "Dogs" = Western Bulldogs
  - "Parra" = Parramatta Eels, "Storm" = Melbourne Storm, "Manly" = Manly Sea Eagles
  - "Riff" = Penrith Panthers (Panthers play at BlueBet Stadium, previously Penrith Stadium — "Riff" is a local nickname)
  - "Roma" = AS Roma (Soccer)
- "h2h" or "H2H" = Head to Head market
- FUZZY HANDICAP MATCHING: if the team/player name clearly matches a pick, treat it as a match even if the handicap or line number is slightly different (e.g. pick says "Swans +19.5" but slip says "Sydney Swans (+20.5)" — still match it). Always use the actual number from the bet slip.
- The order of legs in the bet slip will NOT match the order of picks — match by team/selection name, not position

Return ONLY a valid JSON object in this exact shape:
{
  "matches": [
    { "leg_index": 0, "event": "...", "description": "...", "selection": "...", "odds": 1.24, "event_time": "2026-04-20T14:30", "outcome": "won", "matched": true },
    ...
  ],
  "unmatched_slip_legs": [
    { "event": "...", "description": "...", "selection": "...", "odds": 1.24, "event_time": "2026-04-20T19:45", "outcome": "pending" },
    ...
  ]
}

"matches" must have exactly ${sortedLegs.length} entries (one per punter, in the same order as the picks list above):
- "leg_index": 0-based index of the punter in the picks list above
- "event": full match/event name from the bet slip
- "description": market type (e.g. "Head to Head", "Pick Your Line", "Win-Draw-Win")
- "selection": exact selection text from the bet slip
- "odds": decimal odds as a number
- "event_time": event start time in AEST as "YYYY-MM-DDTHH:MM" 24-hour format — extract from the bet slip if shown, otherwise null. IMPORTANT: Sportsbet displays all times in 24-hour format. A time shown as "19:50" must be output as "19:50", NOT "9:50". Never drop the leading digit. Always use zero-padded two-digit hours (e.g. "09:00", "19:50"). YEAR: Sportsbet often shows relative dates like "Tomorrow", "Saturday" or "Sunday" without a year — always use ${currentYear} as the year. Never output a past year.
- "outcome": "won", "lost", "void", or "pending" — set from the bet slip if the result is shown, otherwise "pending"
- "matched": true if clearly matched, false if uncertain or no pick was entered
For unmatched/uncertain picks, set matched: false and omit event/selection/odds/event_time.

"unmatched_slip_legs": any legs found in the bet slip that could NOT be matched to any pick entry. Include "outcome" and "event_time" the same way. Omit this array (or return []) if all slip legs were matched.`

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
    logUsage({ endpoint: 'match-weekly-multi', userId, model: 'claude-sonnet-4-6', usage: data.usage, imageCount: imageList.length })
    const textBlock = data.content.find(b => b.type === 'text')
    if (!textBlock) return res.status(500).json({ error: 'No response from AI' })

    const cleaned = textBlock.text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
    // Try object shape first, fall back to legacy array shape
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/) || cleaned.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return res.status(500).json({ error: 'Could not parse AI response', raw: textBlock.text.substring(0, 300) })

    const parsed = JSON.parse(jsonMatch[0])
    const rawMatches = Array.isArray(parsed) ? parsed : (parsed.matches || [])
    const unmatchedSlipLegs = Array.isArray(parsed) ? [] : (parsed.unmatched_slip_legs || [])

    // Fix event_time strings coming from the AI:
    // 1. Pad single-digit hours  e.g. "T9:50" → "T09:50"
    // 2. Fix wrong year — AI sometimes outputs last year when Sportsbet shows relative
    //    dates like "Tomorrow" or day names. Bump any past year up to current year.
    //
    // IMPORTANT: year fix uses string replacement, NOT Date + toISOString(). Using
    // toISOString() converts AEST→UTC and shifts the hour by -10, which caused bets
    // to be stored with times 10 hours earlier than intended (e.g. "19:40" → "09:40").
    const fixEventTime = (t) => {
      if (!t) return t
      // Pad single-digit hour
      let fixed = t.replace(/T(\d):/, 'T0$1:')
      // Fix year if in the past — pure string swap, no timezone math
      const yearMatch = fixed.match(/^(\d{4})/)
      if (yearMatch) {
        const year = parseInt(yearMatch[1], 10)
        if (year < currentYear) {
          fixed = String(currentYear) + fixed.substring(4)
        }
      }
      return fixed
    }

    // Enrich with leg_id and member info for the frontend
    const enriched = rawMatches.map(m => {
      const leg = sortedLegs[m.leg_index]
      if (!leg) return m
      const memberName = leg.assigned_user_id
        ? (profileMap[leg.assigned_user_id] || 'Unknown')
        : (leg.assigned_name || 'Unknown')
      return {
        ...m,
        event_time: fixEventTime(m.event_time),
        leg_id: leg.id,
        member_name: memberName,
        raw_pick: leg.raw_pick || '',
      }
    })

    const fixedUnmatched = unmatchedSlipLegs.map(l => ({
      ...l,
      event_time: fixEventTime(l.event_time),
    }))

    return res.status(200).json({ matches: enriched, unmatched_slip_legs: fixedUnmatched })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
