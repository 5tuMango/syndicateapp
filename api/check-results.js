// Vercel Serverless Function — checks pending bet results via Claude + API-Sports
// POST /api/check-results  { betId: 'uuid' }       → check a single bet
// GET  /api/check-results  (with cron auth header)  → check all pending bets

function evaluateBetReturn(betReturnText, outcome, legs = []) {
  if (!betReturnText || !outcome || outcome === 'pending') return null
  const text = betReturnText.toLowerCase()
  const lostLegs = legs.filter(l => l.outcome === 'lost').length
  if (/\b1 leg fail|\bone leg fail/.test(text)) return lostLegs === 1
  if (/\b2 legs? fail/.test(text)) return lostLegs === 2
  if (/any legs? (of your .+)?fail|if any leg/.test(text)) return outcome === 'lost'
  if (/if (it|this bet|your (selection|multi|bet)) loses?/.test(text)) return outcome === 'lost'
  if (/runs? (2nd|second|3rd|third)|place(?:s|d)?/.test(text)) return null
  return null
}

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'
const MODEL_SEARCH = 'claude-sonnet-4-6' // Sonnet for web search — Haiku doesn't reliably use tools

// ── API-Sports config per sport ───────────────────────────────────────────────
// These sports get confirmed scores fetched before Claude is called.
// Horse Racing, Tennis, Soccer etc. fall through to Claude web search only.
const API_SPORTS_ENDPOINTS = {
  AFL:  'https://v1.afl.api-sports.io/games',
  NRL:  'https://v1.rugby.api-sports.io/games',
  NBA:  'https://v2.nba.api-sports.io/games',
}

// Status codes that mean the game is finished across the different APIs
const FINISHED_STATUSES = new Set(['FT', 'AOT', 'AET', 'PEN', 'FN', 'After Over Time', 'Finished'])

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

    for (const bet of bets) {
      try {
        const pendingLegs = bet.bet_type === 'multi'
          ? [...(bet.bet_legs || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).filter((l) => l.outcome === 'pending')
          : []

        if (bet.bet_type === 'multi' && pendingLegs.length > 0) {
          const today = new Date().toISOString().slice(0, 10)
          // Check each pending leg individually with a delay between calls
          for (const leg of pendingLegs) {
            // Skip legs whose event hasn't happened yet
            const legDate = leg.event_time ? leg.event_time.split('T')[0] : null
            if (legDate && legDate > today) {
              console.log(`  Leg [${leg.selection || leg.description}] → skipped (future event: ${legDate})`)
              continue
            }
            const result = await checkSingleLeg(ANTHROPIC_KEY, leg, bet.date)
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
              const earned = evaluateBetReturn(bet.bet_return_text, check.outcome, bet.bet_legs || [])
              if (earned !== null) betUpdate.bet_return_earned = earned
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

// ── API-Sports: fetch confirmed scores for a sport + date ─────────────────────
async function fetchApiSportsGames(sport, dateStr, apiKey) {
  const url = API_SPORTS_ENDPOINTS[sport]
  if (!url || !apiKey) return null

  try {
    const res = await fetch(`${url}?date=${dateStr}`, {
      headers: { 'x-apisports-key': apiKey },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data.response) || data.response.length === 0) return null

    const lines = []
    for (const game of data.response) {
      try {
        const home = game.teams?.home?.name
        const away = game.teams?.away?.name
        if (!home || !away) continue

        const statusRaw = game.status?.long || game.status?.short || ''
        const finished = FINISHED_STATUSES.has(game.status?.short) ||
          statusRaw.toLowerCase().includes('finish') ||
          statusRaw.toLowerCase().includes('complete')

        // Score format differs slightly per API
        let homeScore, awayScore
        if (sport === 'AFL') {
          homeScore = game.scores?.home?.total
          awayScore = game.scores?.away?.total
          // AFL also has goals/behinds — include if available
          const hg = game.scores?.home?.goals
          const hb = game.scores?.home?.behinds
          const ag = game.scores?.away?.goals
          const ab = game.scores?.away?.behinds
          if (finished && homeScore != null && awayScore != null) {
            const scoreStr = (hg != null)
              ? `${home} ${hg}.${hb}.${homeScore} def/lost to ${away} ${ag}.${ab}.${awayScore}`
              : `${home} ${homeScore} - ${awayScore} ${away}`
            lines.push(`[FINAL] ${scoreStr}`)
          } else if (homeScore != null) {
            lines.push(`[IN PROGRESS] ${home} ${homeScore} - ${awayScore} ${away}`)
          }
        } else {
          // NRL (rugby) and NBA
          homeScore = game.scores?.home?.total ?? game.scores?.home
          awayScore = game.scores?.away?.total ?? game.scores?.away
          if (finished && homeScore != null && awayScore != null) {
            lines.push(`[FINAL] ${home} ${homeScore} - ${awayScore} ${away}`)
          } else if (homeScore != null) {
            lines.push(`[IN PROGRESS] ${home} ${homeScore} - ${awayScore} ${away}`)
          } else {
            lines.push(`[UPCOMING] ${home} vs ${away}`)
          }
        }
      } catch {
        // skip malformed game entry
      }
    }

    return lines.length ? lines.join('\n') : null
  } catch {
    return null
  }
}

// ── Check a single leg with a focused search ──────────────────────────────────
async function checkSingleLeg(apiKey, leg, betDate) {
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

  const system = `You are checking the result of a single Australian sports bet leg. Search the web and return ONLY valid JSON — no markdown, no explanation.

JSON format: { "outcome": "won" | "lost" | "void" | "pending", "confidence": "high" | "medium" | "low", "reasoning": "brief" }

Rules:
- Search using the exact event name, player name, and date (year: ${year})
- Player goals (AFL): search "[player] goals [teams] ${year}" on AFL.com.au or Fox Sports
- Big Win Little Win / margin: find final score margin and check if it's in the stated range
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

  for (let i = 0; i < 5; i++) {
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
  // Collect unique sport+date combos to minimise API calls
  const sportDateMap = new Map() // key: "SPORT:YYYY-MM-DD" → { sport, date }
  if (isMulti) {
    for (const leg of legs) {
      const sport = leg.sport
      const date = leg.event_time ? leg.event_time.split('T')[0] : bet.date
      if (sport && API_SPORTS_ENDPOINTS[sport]) {
        sportDateMap.set(`${sport}:${date}`, { sport, date })
      }
    }
  } else {
    const sport = bet.sport
    const date = bet.event_time ? bet.event_time.split('T')[0] : bet.date
    if (sport && API_SPORTS_ENDPOINTS[sport]) {
      sportDateMap.set(`${sport}:${date}`, { sport, date })
    }
  }

  // Fetch scores (parallel where possible)
  const scoreResults = await Promise.all(
    [...sportDateMap.entries()].map(async ([key, { sport, date }]) => {
      const scores = await fetchApiSportsGames(sport, date, apiSportsKey)
      return [key, scores]
    })
  )
  const scoresMap = new Map(scoreResults)

  // Build the confirmed scores context block for Claude
  const confirmedScores = [...scoresMap.entries()]
    .filter(([, v]) => v)
    .map(([k, v]) => {
      const [sport, date] = k.split(':')
      return `${sport} games on ${date}:\n${v}`
    })
    .join('\n\n')

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
  "needs_review": false
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

  const userMessage = `Return JSON only. Check this bet:\n\n${betDesc}`
  const messages = [{ role: 'user', content: userMessage }]

  // ── Step 3: Agentic loop with web search fallback ──────────────────────────
  for (let i = 0; i < 5; i++) {
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
        max_tokens: 2048,
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
