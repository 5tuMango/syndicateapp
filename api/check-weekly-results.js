// Vercel Serverless Function — checks pending weekly multi leg results via Claude web search
// POST /api/check-weekly-results  { multiId: 'uuid' }

import { logUsage } from './_lib/logUsage.js'

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL_SEARCH = 'claude-sonnet-4-6'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured.' })
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' })

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

    for (const leg of pendingLegs) {
      // Skip legs whose event hasn't happened yet
      const legDate = leg.event_time ? leg.event_time.split('T')[0] : null
      if (legDate && legDate > today) {
        console.log(`  Leg [${leg.selection || leg.raw_pick}] → skipped (future: ${legDate})`)
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

      const result = await checkSingleLeg(ANTHROPIC_KEY, legForCheck, betDate)
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

async function checkSingleLeg(apiKey, leg, betDate) {
  let date = leg.event_time ? leg.event_time.split('T')[0] : betDate
  if (date && betDate) {
    const eventYear = parseInt(date.split('-')[0])
    const betYear = parseInt(betDate.split('-')[0])
    if (eventYear < betYear) {
      date = betDate.split('-')[0] + date.substring(4)
    }
  }
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

  const userMessage = `Sport: ${leg.sport}
Event: ${leg.event} (${date})
Market: ${leg.description}
Selection: ${leg.selection}

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
    logUsage({ endpoint: 'check-weekly-results', model: data.model, usage: data.usage })

    if (data.stop_reason === 'end_turn') {
      const textBlock = data.content.find(b => b.type === 'text')
      if (!textBlock) return { outcome: 'pending', confidence: 'low' }
      return parseResult(textBlock.text)
    }

    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content })
      const toolResults = data.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '' }))
      if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults })
    } else {
      break
    }
  }

  return { outcome: 'pending', confidence: 'low', reasoning: 'Could not determine result' }
}

function parseResult(text) {
  try {
    const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
    const matches = [...cleaned.matchAll(/\{[\s\S]*?\}/g)]
    const match = matches.length ? matches[matches.length - 1] : cleaned.match(/\{[\s\S]*\}/)
    if (!match) return { outcome: 'pending', confidence: 'low', reasoning: text.substring(0, 100) }
    const parsed = JSON.parse(match[0])
    const valid = ['won', 'lost', 'void', 'pending']
    if (!valid.includes(parsed.outcome)) parsed.outcome = 'pending'
    return parsed
  } catch {
    return { outcome: 'pending', confidence: 'low', reasoning: 'JSON parse error' }
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
