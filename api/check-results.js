// Vercel Serverless Function — checks pending bet results via the in-house resolver.
// Claude API is intentionally NOT called here (cost gate). Unresolved legs stay pending.
// POST /api/check-results  { betId: 'uuid', userId? }  → check a single bet
// GET  /api/check-results  (with cron auth header)     → check pending bets in 3-9h window

import { resolveLeg } from './_lib/resolveLeg.js'

function evaluateBetReturn(betReturnText, outcome, legs = []) {
  if (!betReturnText || !outcome || outcome === 'pending') return null
  const text = betReturnText.toLowerCase()
  const lostLegs = legs.filter(l => l.outcome === 'lost').length
  if (/runs? (2nd|second|3rd|third)|place(?:s|d)?/.test(text)) return null
  if (/\b1 leg fail|\bone leg fail/.test(text)) return lostLegs === 1
  if (/\b2 legs? fail/.test(text)) return lostLegs === 2
  if (/any legs? (of your .+)?fail|if any leg|any leg.*fail/.test(text)) return outcome === 'lost'
  if (/if (it|this bet|your (selection|multi|bet)) loses?/.test(text)) return outcome === 'lost'
  if (/\b(bet|multi|selection) loses?/.test(text)) return outcome === 'lost'
  return null
}

// In-house resolver only. Claude is gated OFF — see CLAUDE.md.

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY or VITE_SUPABASE_URL not configured.' })
  }

  // For GET requests (cron), require the CRON_SECRET header
  if (req.method === 'GET') {
    const authHeader = req.headers['authorization'] || ''
    const expected = `Bearer ${process.env.CRON_SECRET}`
    if (!process.env.CRON_SECRET || authHeader !== expected) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const betId = req.method === 'POST' ? req.body?.betId : null

  try {
    // Manual check (betId): fetch that specific bet regardless of outcome
    // Cron (no betId): fetch bets with EITHER a pending parent OR pending legs
    //   (resolved multis can still have pending legs that need resolving for player-stat tracking)
    // Only check bets where the date is today or in the past — future bets can't be resolved yet
    const today = new Date().toISOString().slice(0, 10)
    const select = 'id,date,sport,event,bet_type,odds,stake,event_time,user_id,notes,bet_return_text,bet_return_value,cashed_out,bet_legs(*)'
    let fetchUrl
    if (betId) {
      fetchUrl = `${SUPABASE_URL}/rest/v1/bets?id=eq.${betId}&select=${select}`
    } else {
      // Find bet_ids that have pending legs (parent may already be won/lost)
      const pendingLegRes = await sbFetch(
        `${SUPABASE_URL}/rest/v1/bet_legs?outcome=eq.pending&select=bet_id`,
        'GET', null, SUPABASE_URL, SUPABASE_KEY
      )
      const pendingLegRows = await pendingLegRes.json()
      const pendingBetIds = Array.isArray(pendingLegRows)
        ? [...new Set(pendingLegRows.map(r => r.bet_id).filter(Boolean))]
        : []
      const filter = pendingBetIds.length > 0
        ? `or=(outcome.eq.pending,id.in.(${pendingBetIds.join(',')}))`
        : `outcome=eq.pending`
      fetchUrl = `${SUPABASE_URL}/rest/v1/bets?${filter}&date=lte.${today}&select=${select}&order=date.asc&limit=6`
    }

    const betsRes = await sbFetch(fetchUrl, 'GET', null, SUPABASE_URL, SUPABASE_KEY)
    const bets = await betsRes.json()

    if (!Array.isArray(bets) || bets.length === 0) {
      return res.status(200).json({ checked: 0, results: [], message: 'No pending bets found.' })
    }

    const results = []
    const nowMs = Date.now()
    const isCron = req.method === 'GET'
    // Stored event_time strings are naive "YYYY-MM-DDTHH:MM" meant as AEST.
    // Parse with an explicit +10:00 offset before comparing to now.
    const isFuture = (eventTime) => {
      if (!eventTime) return false
      const s = eventTime.substring(0, 16)
      const ms = Date.parse(s + ':00+10:00')
      return !isNaN(ms) && ms > nowMs
    }
    // Cron only: stop retrying after 9h past kickoff — flag for manual review instead.
    // First check window starts at kickoff + 3h.
    const isOutsideWindow = (eventTime) => {
      if (!isCron || !eventTime) return false
      const s = eventTime.substring(0, 16)
      const ms = Date.parse(s + ':00+10:00')
      if (isNaN(ms)) return false
      const elapsed = nowMs - ms
      return elapsed < 3 * 60 * 60 * 1000 || elapsed > 9 * 60 * 60 * 1000
    }

    for (const bet of bets) {
      try {
        // Skip any single bet whose event_time is still in the future — nothing to check yet.
        // For multi bets, the per-leg skip below handles partial-future cases.
        if (bet.bet_type !== 'multi' && isFuture(bet.event_time)) {
          console.log(`Bet [${bet.event}] → skipped (future event: ${bet.event_time})`)
          results.push({ betId: bet.id, outcome: 'pending', skipped: 'future event' })
          continue
        }
        if (bet.bet_type !== 'multi' && isOutsideWindow(bet.event_time)) {
          console.log(`Bet [${bet.event}] → skipped by cron (outside 3-9h window: ${bet.event_time})`)
          results.push({ betId: bet.id, outcome: 'pending', skipped: 'outside window — check manually' })
          continue
        }

        const pendingLegs = bet.bet_type === 'multi'
          ? [...(bet.bet_legs || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).filter((l) => l.outcome === 'pending')
          : []

        if (bet.bet_type === 'multi' && pendingLegs.length > 0) {
          const today = new Date().toISOString().slice(0, 10)
          // Check each pending leg individually with a delay between calls
          for (const leg of pendingLegs) {
            // Skip legs whose event hasn't happened yet — compare full timestamps,
            // not just dates, so a 7:40pm game isn't checked at 9am the same day.
            if (isFuture(leg.event_time)) {
              console.log(`  Leg [${leg.selection || leg.description}] → skipped (future event: ${leg.event_time})`)
              continue
            }
            if (isOutsideWindow(leg.event_time)) {
              console.log(`  Leg [${leg.selection || leg.description}] → skipped by cron (outside 3-9h window)`)
              continue
            }
            const result = await checkSingleLeg(leg, bet.date, SUPABASE_URL, SUPABASE_KEY, isCron)
            console.log(`  Leg [${leg.selection || leg.description}] → ${result.outcome} (${result.reasoning || ''})`)
            if (result.outcome === 'void') {
              results.push({ betId: bet.id, outcome: 'pending', needs_review: true, reasoning: `Void leg: ${leg.selection || leg.description}` })
              continue
            }
            if (result.outcome && result.outcome !== 'pending') {
              await sbFetch(
                `${SUPABASE_URL}/rest/v1/bet_legs?id=eq.${leg.id}`,
                'PATCH',
                { outcome: result.outcome },
                SUPABASE_URL,
                SUPABASE_KEY
              )
            }
            await sleep(200) // brief pause between leg checks
          }

          // Re-fetch all legs to derive parent outcome
          const allLegs = await sbFetch(
            `${SUPABASE_URL}/rest/v1/bet_legs?bet_id=eq.${bet.id}&select=outcome`,
            'GET', null, SUPABASE_URL, SUPABASE_KEY
          ).then((r) => r.json())

          const anyLost = allLegs.some((l) => l.outcome === 'lost')
          const anyPending = allLegs.some((l) => l.outcome === 'pending')
          const finalOutcome = anyLost ? 'lost' : anyPending ? 'pending' : 'won'

          // Cashed-out bets are settled — keep legs updating but don't flip the
          // parent outcome (it stays at 'won' regardless of leg results).
          if (finalOutcome !== 'pending' && !bet.cashed_out) {
            const betUpdate = { outcome: finalOutcome, updated_at: new Date().toISOString() }
            if (bet.bet_return_text && bet.bet_return_value > 0) {
              const earned = evaluateBetReturn(bet.bet_return_text, finalOutcome, allLegs)
              if (earned !== null) betUpdate.bet_return_earned = earned
            }
            await sbFetch(`${SUPABASE_URL}/rest/v1/bets?id=eq.${bet.id}`, 'PATCH', betUpdate, SUPABASE_URL, SUPABASE_KEY)
          }
          results.push({ betId: bet.id, outcome: bet.cashed_out ? 'won' : finalOutcome, cashed_out: !!bet.cashed_out })

        } else {
          // Single bet or multi with no pending legs
          const check = await checkBetResult(bet, SUPABASE_URL, SUPABASE_KEY)
          if (bet.bet_type === 'multi' && bet.bet_legs?.some((l) => l.outcome === 'lost')) {
            check.outcome = 'lost'
          }
          if (check.outcome !== 'pending' && !bet.cashed_out) {
            const betUpdate = { outcome: check.outcome, updated_at: new Date().toISOString() }
            if (bet.bet_return_text && bet.bet_return_value > 0) {
              // Try simple rule evaluation first; fall back to AI's determination for racing placements
              const earned = evaluateBetReturn(bet.bet_return_text, check.outcome, bet.bet_legs || [])
              if (earned !== null) {
                betUpdate.bet_return_earned = earned
              } else if (check.bet_return_earned != null) {
                betUpdate.bet_return_earned = check.bet_return_earned
              }
            }
            await sbFetch(`${SUPABASE_URL}/rest/v1/bets?id=eq.${bet.id}`, 'PATCH', betUpdate, SUPABASE_URL, SUPABASE_KEY)
          }
          results.push({ betId: bet.id, outcome: check.outcome, confidence: check.confidence, reasoning: check.reasoning })
        }

      } catch (err) {
        results.push({ betId: bet.id, outcome: 'pending', error: err.message })
      }

      if (bets.length > 1) await sleep(5000) // 5s between bets to respect rate limit
    }

    return res.status(200).json({ checked: bets.length, results })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

// ── Check a single leg via the in-house resolver. Claude is gated OFF. ───────
// If the resolver can't resolve, the leg stays pending — we never call Claude.
async function checkSingleLeg(leg, betDate, supabaseUrl, supabaseKey, _isCron = false) {
  const selection = leg.selection || leg.description || ''
  const sport = leg.sport || ''

  if (!supabaseUrl || !supabaseKey) {
    return { outcome: 'pending', confidence: 'low', reasoning: 'Supabase creds missing — cannot resolve' }
  }

  try {
    const inHouse = await resolveLeg(leg, betDate, supabaseUrl, supabaseKey)
    if (inHouse.resolved && inHouse.outcome && inHouse.outcome !== 'needs_review') {
      console.log(`  Leg [${selection}] → in-house: ${inHouse.outcome} (${inHouse.reasoning || ''})`)
      return { outcome: inHouse.outcome, confidence: 'high', reasoning: inHouse.reasoning }
    }
    console.log(`  Leg [${selection}] → unresolved (${sport}), leaving pending`)
    return { outcome: 'pending', confidence: 'low', reasoning: inHouse.reasoning || 'needs_review' }
  } catch (err) {
    console.log(`  Leg [${selection}] → resolver error: ${err.message}`)
    return { outcome: 'pending', confidence: 'low', reasoning: `Resolver error: ${err.message}` }
  }
}

// ── Core: resolve a bet via the in-house resolver. Claude path is gated OFF. ──
// For single bets we shape the bet as a leg and pass it to resolveLeg. For multis
// with no pending legs we derive the outcome from existing leg outcomes.
// If resolveLeg can't resolve, the bet stays pending — we never call Claude.
async function checkBetResult(bet, supabaseUrl, supabaseKey) {
  const isMulti = bet.bet_type === 'multi'

  // Multi with no pending legs → outcome already determined by leg outcomes
  if (isMulti) {
    const legs = bet.bet_legs || []
    const anyLost = legs.some((l) => l.outcome === 'lost')
    const anyPending = legs.some((l) => l.outcome === 'pending')
    const outcome = anyLost ? 'lost' : anyPending ? 'pending' : 'won'
    return { outcome, confidence: 'high', reasoning: 'Derived from leg outcomes' }
  }

  // Single bet → treat as a leg and run through the in-house resolver
  const legShape = {
    sport: bet.sport,
    event: bet.event,
    description: bet.notes || '',
    selection: bet.event,
    event_time: bet.event_time,
  }

  if (!supabaseUrl || !supabaseKey) {
    return { outcome: 'pending', confidence: 'low', reasoning: 'Supabase creds missing — cannot resolve' }
  }

  try {
    const inHouse = await resolveLeg(legShape, bet.date, supabaseUrl, supabaseKey)
    if (inHouse.resolved && inHouse.outcome && inHouse.outcome !== 'needs_review') {
      return { outcome: inHouse.outcome, confidence: 'high', reasoning: inHouse.reasoning }
    }
  } catch (err) {
    console.log(`  Bet [${bet.event}] → resolver error: ${err.message}`)
  }

  // Unresolved → leave pending. Claude is intentionally NOT invoked (cost gate).
  return { outcome: 'pending', confidence: 'low', reasoning: 'Unresolved by in-house — needs manual review' }
}

// ── Supabase REST helper ────────────────────────────────────────────────────
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
  return new Promise((resolve) => setTimeout(resolve, ms))
}
