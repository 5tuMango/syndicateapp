// Diagnostic endpoint for the API-Sports integration.
// Usage:   GET /api/test-api-sports?sport=AFL&date=2026-04-24
// Returns the raw + formatted game list for that sport/date, plus status breakdown.
// Admin-only gate via ADMIN_TEST_SECRET (set this env var and pass ?key=<secret>).

const API_SPORTS_ENDPOINTS = {
  AFL: 'https://v1.afl.api-sports.io/games',
  NRL: 'https://v1.rugby.api-sports.io/games',
  NBA: 'https://v2.nba.api-sports.io/games',
}

const FINISHED_STATUSES = new Set([
  'FT', 'AOT', 'AET', 'PEN', 'FN', 'After Over Time', 'Finished',
])

export default async function handler(req, res) {
  const apiKey = process.env.API_SPORTS_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'API_SPORTS_KEY not set on server' })
  }

  // Light gate: require ?key=<ADMIN_TEST_SECRET> if the env var is set.
  // If no secret is configured, endpoint is open (fine for a diag endpoint in dev).
  const adminSecret = process.env.ADMIN_TEST_SECRET
  if (adminSecret && req.query.key !== adminSecret) {
    return res.status(401).json({ error: 'Unauthorized — pass ?key=<ADMIN_TEST_SECRET>' })
  }

  const sport = req.query.sport || 'AFL'
  const date = req.query.date || new Date().toISOString().slice(0, 10)

  const url = API_SPORTS_ENDPOINTS[sport]
  if (!url) {
    return res.status(400).json({
      error: `Unsupported sport "${sport}". Supported: ${Object.keys(API_SPORTS_ENDPOINTS).join(', ')}`,
    })
  }

  try {
    const started = Date.now()
    const r = await fetch(`${url}?date=${date}`, {
      headers: { 'x-apisports-key': apiKey },
    })
    const elapsed = Date.now() - started

    if (!r.ok) {
      const body = await r.text()
      return res.status(r.status).json({
        ok: false,
        sport,
        date,
        url: `${url}?date=${date}`,
        statusCode: r.status,
        elapsed_ms: elapsed,
        body: body.substring(0, 2000),
      })
    }

    const data = await r.json()
    const games = Array.isArray(data.response) ? data.response : []

    // Format the same way check-results.js does so you can verify parsing matches.
    const formatted = []
    for (const game of games) {
      try {
        const home = game.teams?.home?.name
        const away = game.teams?.away?.name
        if (!home || !away) continue

        const statusRaw = game.status?.long || game.status?.short || ''
        const finished =
          FINISHED_STATUSES.has(game.status?.short) ||
          statusRaw.toLowerCase().includes('finish') ||
          statusRaw.toLowerCase().includes('complete')

        let homeScore, awayScore
        if (sport === 'AFL') {
          homeScore = game.scores?.home?.total
          awayScore = game.scores?.away?.total
        } else {
          homeScore = game.scores?.home?.total ?? game.scores?.home
          awayScore = game.scores?.away?.total ?? game.scores?.away
        }

        let tag
        if (finished && homeScore != null && awayScore != null) tag = '[FINAL]'
        else if (homeScore != null) tag = '[IN PROGRESS]'
        else tag = '[UPCOMING]'

        formatted.push({
          tag,
          home,
          away,
          homeScore,
          awayScore,
          statusRaw,
          game_time: game.date || game.game?.date?.start || null,
        })
      } catch (err) {
        formatted.push({ error: err.message, raw: game })
      }
    }

    // Summary counts
    const counts = {
      total: formatted.length,
      final: formatted.filter((g) => g.tag === '[FINAL]').length,
      in_progress: formatted.filter((g) => g.tag === '[IN PROGRESS]').length,
      upcoming: formatted.filter((g) => g.tag === '[UPCOMING]').length,
    }

    // Text block matching what check-results.js injects into Claude's prompt
    const claudeContext = formatted
      .map((g) => {
        if (g.tag === '[FINAL]' || g.tag === '[IN PROGRESS]') {
          return `${g.tag} ${g.home} ${g.homeScore} - ${g.awayScore} ${g.away}`
        }
        return `${g.tag} ${g.home} vs ${g.away}`
      })
      .join('\n')

    return res.status(200).json({
      ok: true,
      sport,
      date,
      url: `${url}?date=${date}`,
      elapsed_ms: elapsed,
      counts,
      claudeContextPreview: claudeContext,
      games: formatted,
      rawResponseShape: {
        errors: data.errors || null,
        results: data.results ?? null,
        paging: data.paging ?? null,
        responseLength: games.length,
      },
    })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message })
  }
}
