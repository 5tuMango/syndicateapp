// Diagnostic endpoint for API-Sports + in-house resolver.
// Usage:
//   GET  /api/test-api-sports                           → health check (key set? all sports reachable?)
//   GET  /api/test-api-sports?sport=AFL&date=2026-04-25 → game list for that sport/date
//   POST /api/test-api-sports                           → run bet legs through in-house resolver
// Admin-only gate via ADMIN_TEST_SECRET header or ?key=<secret>.

import {
  isSportSupported,
  listSupportedSports,
  fetchGames,
  formatGamesForContext,
} from './_lib/apiSports.js'
import { classifyMarket } from './_lib/classifyMarket.js'
import { resolveLeg } from './_lib/resolveLeg.js'

// Per-sport status probe URL — uses /status when available so we hit the cheapest
// endpoint that still confirms subscription + returns request quota info.
const STATUS_URLS = {
  AFL:        'https://v1.afl.api-sports.io/status',
  NBA:        'https://v2.nba.api-sports.io/status',
  NBL:        'https://v1.basketball.api-sports.io/status',
  Basketball: 'https://v1.basketball.api-sports.io/status',
  Soccer:     'https://v3.football.api-sports.io/status',
  NFL:        'https://v1.american-football.api-sports.io/status',
  NCAAF:      'https://v1.american-football.api-sports.io/status',
}

export default async function handler(req, res) {
  const adminSecret = process.env.ADMIN_TEST_SECRET
  const key = req.headers['x-admin-secret'] || req.query.key || ''
  if (adminSecret && key !== adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // ── POST mode: run bet legs through the in-house resolver ──────────────────
  if (req.method === 'POST') {
    const SUPABASE_URL = process.env.VITE_SUPABASE_URL
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ error: 'Supabase env vars not configured' })
    }

    const legs = Array.isArray(req.body) ? req.body : [req.body]
    const results = await Promise.all(legs.map(async leg => {
      const marketType = classifyMarket(leg)
      const betDate = leg.event_time ? leg.event_time.split('T')[0] : null
      let resolution = { resolved: false }
      try {
        resolution = await resolveLeg(leg, betDate, SUPABASE_URL, SUPABASE_KEY)
      } catch (err) {
        resolution = { resolved: false, error: err.message }
      }
      return {
        id: leg.id,
        sport: leg.sport,
        event: leg.event,
        description: leg.description,
        selection: leg.selection,
        recorded_outcome: leg.outcome,
        market_type: marketType,
        ...resolution,
        match: resolution.resolved && resolution.outcome === leg.outcome ? 'PASS'
             : resolution.resolved && resolution.outcome !== leg.outcome ? 'FAIL'
             : 'UNRESOLVED',
      }
    }))

    const resolved = results.filter(r => r.resolved).length
    const passed = results.filter(r => r.match === 'PASS').length
    const failed = results.filter(r => r.match === 'FAIL').length
    return res.status(200).json({ total: results.length, resolved, passed, failed, unresolved: results.length - resolved, results })
  }

  // ── GET mode: API-Sports health check / game list ──────────────────────────
  const apiKey = process.env.API_SPORTS_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'API_SPORTS_KEY not set on server' })
  }

  // ── Health-check mode: no sport param → probe each supported sport ─────────
  if (!req.query.sport) {
    // Dedupe: NBL + Basketball share a status URL, NFL + NCAAF share a status URL
    const uniqueProbes = new Map() // statusUrl → first sport label using it
    for (const sport of listSupportedSports()) {
      const url = STATUS_URLS[sport]
      if (url && !uniqueProbes.has(url)) uniqueProbes.set(url, sport)
    }

    const probes = await Promise.all(
      [...uniqueProbes.entries()].map(async ([url, sport]) => {
        const t0 = Date.now()
        try {
          const r = await fetch(url, { headers: { 'x-apisports-key': apiKey } })
          const elapsed = Date.now() - t0
          const body = await r.text()
          let parsed = null
          try { parsed = JSON.parse(body) } catch {}
          return {
            api: sport,
            url,
            ok: r.ok,
            status: r.status,
            elapsed_ms: elapsed,
            account: parsed?.response?.account ?? null,
            subscription: parsed?.response?.subscription ?? null,
            requests: parsed?.response?.requests ?? null,
            errors: parsed?.errors ?? null,
            bodyPreview: r.ok ? null : body.substring(0, 300),
          }
        } catch (err) {
          return { api: sport, url, ok: false, error: err.message }
        }
      })
    )

    return res.status(200).json({
      ok: true,
      mode: 'health-check',
      apiKeyPresent: true,
      apiKeyMasked: apiKey.slice(0, 4) + '…' + apiKey.slice(-4),
      supportedSports: listSupportedSports(),
      probes,
      hint: 'Add ?sport=AFL&date=YYYY-MM-DD to fetch a game list',
    })
  }

  // ── Game-list mode: ?sport=X&date=Y ────────────────────────────────────────
  const sport = req.query.sport
  const date = req.query.date || new Date().toISOString().slice(0, 10)

  if (!isSportSupported(sport)) {
    return res.status(400).json({
      error: `Unsupported sport "${sport}". Supported: ${listSupportedSports().join(', ')}`,
    })
  }

  const started = Date.now()
  const games = await fetchGames(sport, date, apiKey)
  const elapsed = Date.now() - started

  if (!games) {
    return res.status(502).json({
      ok: false,
      sport,
      date,
      elapsed_ms: elapsed,
      error: 'Failed to fetch games (network error or API rejected the key/subscription)',
    })
  }

  const counts = {
    total: games.length,
    final: games.filter((g) => g.status === 'final').length,
    in_progress: games.filter((g) => g.status === 'in_progress').length,
    upcoming: games.filter((g) => g.status === 'upcoming').length,
    unknown: games.filter((g) => g.status === 'unknown').length,
  }

  return res.status(200).json({
    ok: true,
    sport,
    date,
    elapsed_ms: elapsed,
    counts,
    claudeContextPreview: formatGamesForContext(games),
    games: games.map(({ raw, ...g }) => g), // strip raw to keep response small
  })
}
