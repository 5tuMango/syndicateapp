// Vercel Serverless Function — checks pending bet results via Claude + API-Sports
// POST /api/check-results  { betId: 'uuid', userId? }  → check a single bet
// GET  /api/check-results  (with cron auth header)     → check all pending bets

import { logUsage } from './_lib/logUsage.js'
import {
  isSportSupported,
  fetchGames,
  formatGamesForContext,
  extractTeams,
  findGame,
} from './_lib/apiSports.js'
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

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'
// Haiku 4.5 for web search as well — ~3× cheaper than Sonnet on input and handles
// result lookup reliably in practice. Revert to 'claude-sonnet-4-6' if tool use regresses.
const MODEL_SEARCH = 'claude-haiku-4-5-20251001'
const MAX_SEARCH_ITERATIONS = 3 // capped from 5 to prevent runaway token bloat

// API-Sports support is provided by ./_lib/apiSports.js
// NRL is NOT supported (API-Sports Rugby API is rugby union only).

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
  const API_SPORTS_KEY = process.env.API_SPORTS_KEY

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY or VITE_SUPABASE_URL not configured.' })
  }
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' })
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
    // Cron (no betId): fetch ONE pending bet at a time to stay within 30s timeout
    // Only check bets where the date is today or in the past — future bets can't be resolved yet
    const today = new Date().toISOString().slice(0, 10)
    let fetchUrl = `${SUPABASE_URL}/rest/v1/bets?outcome=eq.pending&date=lte.${today}&select=id,date,sport,event,bet_type,odds,stake,event_time,user_id,notes,bet_return_text,bet_return_value,bet_legs(*)&order=date.asc&limit=2`
    if (betId) fetchUrl = `${SUPABASE_URL}/rest/v1/bets?id=eq.${betId}&select=id,date,sport,event,bet_type,odds,stake,event_time,user_id,notes,bet_return_text,bet_return_value,bet_legs(*)`

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
            const result = await checkSingleLeg(ANTHROPIC_KEY, API_SPORTS_KEY, leg, bet.date, SUPABASE_URL, SUPABASE_KEY)
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

          if (finalOutcome !== 'pending') {
            const betUpdate = { outcome: finalOutcome, updated_at: new Date().toISOString() }
            if (bet.bet_return_text && bet.bet_return_value > 0) {
              const earned = evaluateBetReturn(bet.bet_return_text, finalOutcome, allLegs)
              if (earned !== null) betUpdate.bet_return_earned = earned
            }
            await sbFetch(`${SUPABASE_URL}/rest/v1/bets?id=eq.${bet.id}`, 'PATCH', betUpdate, SUPABASE_URL, SUPABASE_KEY)
          }
          results.push({ betId: bet.id, outcome: finalOutcome })

        } else {
          // Single bet or multi with no pending legs
          const check = await checkBetResult(ANTHROPIC_KEY, API_SPORTS_KEY, bet)
          if (bet.bet_type === 'multi' && bet.bet_legs?.some((l) => l.outcome === 'lost')) {
            check.outcome = 'lost'
          }
          if (check.outcome !== 'pending') {
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

// ── Check a single leg with a focused search ──────────────────────────────────
// Now takes apiSportsKey too — if the sport is supported, we fetch confirmed
// scores and inject them into Claude's context as ground truth. Cuts web-search
// iterations dramatically on H2H/handicap legs.
async function checkSingleLeg(apiKey, apiSportsKey, leg, betDate, supabaseUrl, supabaseKey) {
  let date = leg.event_time ? leg.event_time.split('T')[0] : betDate
  // Fix stale years — if event_time year is before the bet was placed, use the bet date year
  if (date && betDate) {
    const eventYear = parseInt(date.split('-')[0])
    const betYear = parseInt(betDate.split('-')[0])
    if (eventYear < betYear) {
      date = betDate.split('-')[0] + date.substring(4) // replace year with bet year
    }
  }
  const event = leg.event || ''
  const description = leg.description || ''
  const selection = leg.selection || ''
  const sport = leg.sport || ''
  const year = date ? date.split('-')[0] : new Date().getFullYear()

  // ── In-house resolver (AFL match markets) ────────────────────────────────────
  if (supabaseUrl && supabaseKey) {
    const inHouse = await resolveLeg(leg, betDate, supabaseUrl, supabaseKey)
    if (inHouse.resolved && inHouse.outcome && inHouse.outcome !== 'needs_review') {
      console.log(`  Leg [${selection}] → in-house: ${inHouse.outcome} (${inHouse.reasoning || ''})`)
      return { outcome: inHouse.outcome, confidence: 'high', reasoning: inHouse.reasoning }
    }
  }

  // ── Fetch confirmed score from API-Sports (if sport supported) ──────────────
  // If the game is upcoming/in-progress per API-Sports, short-circuit with pending.
  // If finished, inject the score into Claude's context so it doesn't web-search for it.
  let confirmedScoreLine = null
  if (apiSportsKey && isSportSupported(sport)) {
    const games = await fetchGames(sport, date, apiSportsKey)
    if (Array.isArray(games) && games.length > 0) {
      const teams = extractTeams(event)
      const game = findGame(games, teams)
      if (game) {
        if (game.status === 'upcoming' || game.status === 'in_progress') {
          console.log(`  Leg [${selection}] → API-Sports: game not finished (${game.status}) — skipping Claude`)
          return { outcome: 'pending', confidence: 'high', reasoning: `API-Sports: ${game.status}` }
        }
        if (game.status === 'final') {
          confirmedScoreLine = `[FINAL] ${game.home} ${game.homeScore} - ${game.awayScore} ${game.away}`
        }
      }
    }
  }

  const confirmedScoreSection = confirmedScoreLine
    ? `\n\nCONFIRMED SCORE (from API-Sports — treat as ground truth):\n${confirmedScoreLine}`
    : ''

  const system = `You are checking the result of a single Australian sports bet leg. Search the web only if needed and return ONLY valid JSON — no markdown, no explanation.${confirmedScoreSection}

JSON format: { "outcome": "won" | "lost" | "void" | "pending", "confidence": "high" | "medium" | "low", "reasoning": "brief" }

Rules:
- If a CONFIRMED SCORE is provided above, use it as ground truth for the final result. Only web-search to resolve player props (goals, tries, disposals, etc.) that aren't in the score.
- Search using the exact event name, player name, and date (year: ${year})
- Player goals (AFL): search "[player] goals [teams] ${year}" on AFL.com.au or Fox Sports
- Big Win Little Win / margin: use the confirmed score's margin if available, else search
- Handicap/line: apply the handicap to the confirmed final score
- Only use "pending" if the event has NOT happened yet
- If the game was played, find the result and commit to won or lost
- Return ONLY the JSON object`

  const userMessage = `Sport: ${sport}
Event: ${event} (${date})
Market: ${description}
Selection: ${selection}

Search for this result and return JSON.`

  const messages = [{ role: 'user', content: userMessage }]

  for (let i = 0; i < MAX_SEARCH_ITERATIONS; i++) {
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_SEARCH,
        max_tokens: 512,
        system,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(err?.error?.message || `Anthropic API ${response.status}`)
    }

    const data = await response.json()
    logUsage({ endpoint: 'check-results', model: data.model, usage: data.usage })

    if (data.stop_reason === 'end_turn') {
      const textBlock = data.content.find((b) => b.type === 'text')
      if (!textBlock) return { outcome: 'pending', confidence: 'low' }
      console.log('  Raw AI response:', textBlock.text.substring(0, 300))
      return parseClaudeResult(textBlock.text, false)
    }

    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content })
      const toolResults = data.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: '' }))
      if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults })
    } else {
      break
    }
  }

  return { outcome: 'pending', confidence: 'low', reasoning: 'Could not determine result' }
}

// ── Core: ask Claude to determine the result ──────────────────────────────────
async function checkBetResult(apiKey, apiSportsKey, bet) {
  const isMulti = bet.bet_type === 'multi'
  // Only check pending legs — already resolved legs don't need checking
  const legs = isMulti
    ? [...(bet.bet_legs || [])]
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .filter((l) => l.outcome === 'pending')
    : []

  // ── Step 1: Fetch confirmed scores from API-Sports where available ──────────
  // Build unique sport+date combos so we only call API-Sports once per (sport,date).
  const sportDateMap = new Map() // key: "SPORT:YYYY-MM-DD" → { sport, date }
  if (isMulti) {
    for (const leg of legs) {
      const date = leg.event_time ? leg.event_time.split('T')[0] : bet.date
      if (leg.sport && isSportSupported(leg.sport)) {
        sportDateMap.set(`${leg.sport}:${date}`, { sport: leg.sport, date })
      }
    }
  } else {
    const date = bet.event_time ? bet.event_time.split('T')[0] : bet.date
    if (bet.sport && isSportSupported(bet.sport)) {
      sportDateMap.set(`${bet.sport}:${date}`, { sport: bet.sport, date })
    }
  }

  // Fetch in parallel
  const gameResults = await Promise.all(
    [...sportDateMap.entries()].map(async ([key, { sport, date }]) => {
      const games = await fetchGames(sport, date, apiSportsKey)
      return [key, games]
    })
  )
  const gamesMap = new Map(gameResults) // key → NormalisedGame[]

  // Build the confirmed scores context block for Claude
  const confirmedScores = [...gamesMap.entries()]
    .filter(([, games]) => Array.isArray(games) && games.length > 0)
    .map(([k, games]) => {
      const [sport, date] = k.split(':')
      const block = formatGamesForContext(games)
      return block ? `${sport} games on ${date}:\n${block}` : null
    })
    .filter(Boolean)
    .join('\n\n')

  // ── Short-circuit: if API-Sports confirms every relevant game is still
  // upcoming or in-progress, skip Claude entirely. Requires POSITIVE identification.
  const checkableLegs = isMulti
    ? legs
    : [{ sport: bet.sport, event: bet.event, event_time: bet.event_time }]
  const allCovered = checkableLegs.length > 0 && checkableLegs.every(
    (l) => l.sport && isSportSupported(l.sport)
  )
  if (allCovered && gamesMap.size > 0) {
    const allUnfinished = checkableLegs.every((l) => {
      const date = l.event_time ? l.event_time.split('T')[0] : bet.date
      const games = gamesMap.get(`${l.sport}:${date}`)
      if (!games || games.length === 0) return false
      const game = findGame(games, extractTeams(l.event))
      if (!game) return false
      return game.status === 'upcoming' || game.status === 'in_progress'
    })
    if (allUnfinished) {
      console.log(`Short-circuit: API-Sports shows all games upcoming/in-progress — skipping Claude`)
      return {
        outcome: 'pending',
        confidence: 'high',
        reasoning: 'API-Sports: games not finished yet',
      }
    }
  }

  // ── Step 2: Build bet description ──────────────────────────────────────────
  let betDesc
  if (isMulti && legs.length > 0) {
    const legLines = legs
      .map((l, i) => {
        let line = `  Leg ${i + 1} [${l.sport || 'Unknown'}]: ${l.event}`
        if (l.description) line += ` — ${l.description}`
        if (l.selection) line += ` · ${l.selection}`
        if (l.event_time) line += ` (${l.event_time} AEST)`
        if (l.odds != null) line += ` @ ${parseFloat(l.odds).toFixed(2)}`
        if (l.leg_group != null) line += ` (SGM group ${l.leg_group}, combined @ ${parseFloat(l.group_odds).toFixed(2)})`
        return line
      })
      .join('\n')
    betDesc = `Multi-leg bet placed on ${bet.date} (Australian Sportsbet)\n${legLines}\nCombined odds: ${parseFloat(bet.odds).toFixed(2)}, Stake: $${parseFloat(bet.stake).toFixed(2)}`
  } else {
    betDesc = `Single bet placed on ${bet.date} (Australian Sportsbet)\nSport: ${bet.sport}\nEvent: ${bet.event}`
    if (bet.event_time) betDesc += `\nEvent time: ${bet.event_time} AEST`
    betDesc += `\nOdds: ${parseFloat(bet.odds).toFixed(2)}, Stake: $${parseFloat(bet.stake).toFixed(2)}`
    if (bet.notes) betDesc += `\nNotes: ${bet.notes}`
  }

  // Bet return text — if present and needs an online check (e.g. racing placement), ask Claude to evaluate it
  const betReturnText = bet.bet_return_text || ''
  const needsBetReturnCheck = betReturnText && /runs? (2nd|second|3rd|third)|place(?:s|d)?/i.test(betReturnText)
  const betReturnSection = needsBetReturnCheck
    ? `\n\nBET RETURN TERMS: "${betReturnText}"\nAlso determine if this bet return condition was met based on the result (e.g. did the selection finish 2nd or 3rd?). Include "bet_return_earned": true or false in your response.`
    : ''

  const jsonShape = isMulti
    ? `{
  "outcome": "won" | "lost" | "void" | "pending",
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation",
  "needs_review": false,
  "legs": [
    { "leg_index": 0, "selection": "exact selection text", "outcome": "won" | "lost" | "void" | "pending", "result": "what you found e.g. Essendon lost by 60pts / Pickett had 1 goal" }
  ]
}`
    : `{
  "outcome": "won" | "lost" | "void" | "pending",
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation",
  "needs_review": false${needsBetReturnCheck ? ',\n  "bet_return_earned": true | false' : ''}
}`

  const confirmedScoresSection = confirmedScores
    ? `\n\nCONFIRMED SCORES (from API-Sports — treat as ground truth for match outcomes):\n${confirmedScores}`
    : ''

  const system = `You are a sports betting result checker. Search for the result and respond with ONLY a JSON object — no prose, no explanation, no markdown. Your entire response must be valid JSON.${confirmedScoresSection}

Rules:
- Search for the event result
- "won" or "lost" only if confirmed. "pending" if event hasn't concluded yet. "void" if cancelled.
- For multi bets with void legs set needs_review=true

Respond with ONLY this JSON, nothing else:
${jsonShape}`

  const userMessage = `Return JSON only. Check this bet:\n\n${betDesc}${betReturnSection}`
  const messages = [{ role: 'user', content: userMessage }]

  // ── Step 3: Agentic loop with web search fallback ──────────────────────────
  for (let i = 0; i < MAX_SEARCH_ITERATIONS; i++) {
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(err?.error?.message || `Anthropic API ${response.status}`)
    }

    const data = await response.json()
    logUsage({ endpoint: 'check-results', model: data.model, usage: data.usage })

    if (data.stop_reason === 'end_turn') {
      const textBlock = data.content.find((b) => b.type === 'text')
      if (!textBlock) return { outcome: 'pending', confidence: 'low', reasoning: 'No text response from AI' }
      return parseClaudeResult(textBlock.text, isMulti)
    }

    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content })
      const toolResults = data.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: '' }))
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults })
      }
    } else {
      break
    }
  }

  return { outcome: 'pending', confidence: 'low', reasoning: 'Could not determine result after multiple attempts' }
}

// ── Parse Claude's JSON response ────────────────────────────────────────────
function parseClaudeResult(text, isMulti) {
  try {
    // Strip markdown fences and find the JSON object
    const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
    // Try to find JSON - grab the last { } block in case there's prose before it
    const matches = [...cleaned.matchAll(/\{[\s\S]*?\}/g)]
    const match = matches.length ? matches[matches.length - 1] : cleaned.match(/\{[\s\S]*\}/)
    if (!match) {
      // Last resort: try to infer outcome from plain text
      const lower = text.toLowerCase()
      if (lower.includes('"won"') || lower.includes('outcome: won')) return { outcome: 'won', confidence: 'medium', reasoning: text.substring(0, 200) }
      if (lower.includes('"lost"') || lower.includes('outcome: lost')) return { outcome: 'lost', confidence: 'medium', reasoning: text.substring(0, 200) }
      return { outcome: 'pending', confidence: 'low', reasoning: 'Could not parse AI response: ' + text.substring(0, 100) }
    }
    const parsed = JSON.parse(match[0])
    const valid = ['won', 'lost', 'void', 'pending']
    if (!valid.includes(parsed.outcome)) parsed.outcome = 'pending'
    if (isMulti && parsed.legs?.some((l) => l.outcome === 'void')) {
      parsed.needs_review = true
      parsed.outcome = 'pending'
      parsed.reasoning = (parsed.reasoning || '') + ' — void leg detected, please review manually in Edit Bet'
    }
    return parsed
  } catch {
    return { outcome: 'pending', confidence: 'low', reasoning: 'JSON parse error from AI' }
  }
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
