// Vercel Serverless Function — checks pending weekly multi leg results via the in-house resolver.
// Claude API is intentionally NOT called here (cost gate). Unresolved legs stay pending.
// POST /api/check-weekly-results  { multiId: 'uuid' }

import { resolveLeg } from './_lib/resolveLeg.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured.' })

  const { multiId } = req.body || {}
  if (!multiId) return res.status(400).json({ error: 'multiId required' })

  try {
    // Fetch the weekly multi + its legs
    const multiRes = await sbFetch(
      `${SUPABASE_URL}/rest/v1/weekly_multis?id=eq.${multiId}&select=id,week_label,stake,is_live,created_at,weekly_multi_legs(*)`,
      'GET', null, SUPABASE_URL, SUPABASE_KEY
    )
    const multis = await multiRes.json()
    const multi = multis?.[0]
    if (!multi) return res.status(404).json({ error: 'Weekly multi not found' })

    const legs = [...(multi.weekly_multi_legs || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

    // Block result checking until the bet slip has been uploaded and confirmed
    if (!multi.is_live) {
      return res.status(200).json({
        checked: 0, updatedLegs: 0, multiOutcome: 'pending',
        message: 'Bet not yet live — upload the bet slip first before checking results.'
      })
    }

    const today = new Date().toISOString().slice(0, 10)
    const betDate = multi.created_at?.slice(0, 10) || today

    const pendingLegs = legs.filter(l => l.outcome === 'pending' || !l.outcome)
    if (pendingLegs.length === 0) {
      return res.status(200).json({ checked: 0, updatedLegs: 0, multiOutcome: deriveOutcome(legs), message: 'No pending legs.' })
    }

    let updatedCount = 0
    const needsReview = []

    const nowMs = Date.now()
    // Stored event_time strings are naive "YYYY-MM-DDTHH:MM" meant as AEST.
    // Parse with an explicit +10:00 offset before comparing to now.
    const isFuture = (eventTime) => {
      if (!eventTime) return false
      const s = eventTime.substring(0, 16)
      const ms = Date.parse(s + ':00+10:00')
      return !isNaN(ms) && ms > nowMs
    }

    for (const leg of pendingLegs) {
      // Skip legs whose event hasn't happened yet — full timestamp comparison,
      // so a 7:40pm game isn't checked at 9am the same day.
      if (isFuture(leg.event_time)) {
        console.log(`  Leg [${leg.selection || leg.raw_pick}] → skipped (future: ${leg.event_time})`)
        continue
      }

      // Build a leg-like object compatible with checkSingleLeg
      const legForCheck = {
        event: leg.event || leg.raw_pick || '',
        description: leg.description || '',
        selection: leg.selection || leg.raw_pick || '',
        sport: leg.sport || '',
        event_time: leg.event_time || null,
      }

      const result = await checkSingleLeg(legForCheck, betDate, SUPABASE_URL, SUPABASE_KEY)
      console.log(`  Leg [${legForCheck.selection}] → ${result.outcome} (${result.reasoning || ''})`)

      if (result.outcome === 'void') {
        needsReview.push(leg.id)
        continue
      }

      if (result.outcome && result.outcome !== 'pending') {
        await sbFetch(
          `${SUPABASE_URL}/rest/v1/weekly_multi_legs?id=eq.${leg.id}`,
          'PATCH', { outcome: result.outcome }, SUPABASE_URL, SUPABASE_KEY
        )
        updatedCount++
      }

      await sleep(200)
    }

    // Re-fetch all legs to derive final outcome
    const allLegsRes = await sbFetch(
      `${SUPABASE_URL}/rest/v1/weekly_multi_legs?weekly_multi_id=eq.${multiId}&select=outcome`,
      'GET', null, SUPABASE_URL, SUPABASE_KEY
    )
    const allLegs = await allLegsRes.json()
    const multiOutcome = deriveOutcome(allLegs)

    return res.status(200).json({
      checked: pendingLegs.length,
      updatedLegs: updatedCount,
      multiOutcome,
      needsReview: needsReview.length > 0,
      message: needsReview.length > 0 ? `${needsReview.length} leg(s) may be void — check manually.` : null,
    })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

function deriveOutcome(legs) {
  const countable = legs.filter(l => l.outcome !== 'void' && l.outcome !== 'missed')
  if (countable.length === 0) return 'pending'
  if (countable.some(l => l.outcome === 'pending' || !l.outcome)) return 'pending'
  if (countable.some(l => l.outcome === 'lost')) return 'lost'
  return 'won'
}

// In-house resolver only. Claude is gated OFF — see CLAUDE.md.
// If the resolver can't resolve, the leg stays pending.
async function checkSingleLeg(leg, betDate, supabaseUrl, supabaseKey) {
  const selection = leg.selection || leg.description || ''

  // Stale-year guard: if extracted event_time has a year before the bet's year,
  // patch the year via pure string replacement (never Date arithmetic — see CLAUDE.md).
  let date = leg.event_time ? leg.event_time.split('T')[0] : betDate
  if (date && betDate) {
    const eventYear = parseInt(date.split('-')[0])
    const betYear = parseInt(betDate.split('-')[0])
    if (eventYear < betYear) {
      date = betDate.split('-')[0] + date.substring(4)
    }
  }

  if (!supabaseUrl || !supabaseKey) {
    return { outcome: 'pending', confidence: 'low', reasoning: 'Supabase creds missing — cannot resolve' }
  }

  try {
    const inHouse = await resolveLeg(leg, date || betDate, supabaseUrl, supabaseKey)
    if (inHouse.resolved && inHouse.outcome && inHouse.outcome !== 'needs_review') {
      console.log(`  Leg [${selection}] → in-house: ${inHouse.outcome} (${inHouse.reasoning || ''})`)
      return { outcome: inHouse.outcome, confidence: 'high', reasoning: inHouse.reasoning }
    }
    console.log(`  Leg [${selection}] → unresolved (${leg.sport}), leaving pending`)
    return { outcome: 'pending', confidence: 'low', reasoning: inHouse.reasoning || 'needs_review' }
  } catch (err) {
    console.log(`  Leg [${selection}] → resolver error: ${err.message}`)
    return { outcome: 'pending', confidence: 'low', reasoning: `Resolver error: ${err.message}` }
  }
}

function sbFetch(url, method, body, supabaseUrl, key) {
  return fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: method === 'PATCH' ? 'return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
