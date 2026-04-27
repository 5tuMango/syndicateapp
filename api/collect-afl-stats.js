// Vercel Serverless Function — collects AFL player stats from AFL.com.au match centre
// GET /api/collect-afl-stats  (cron auth required)
// POST /api/collect-afl-stats (manual trigger — requires x-admin-secret header)
//
// Cron: daily at 15:00 UTC (1am AEST) — after all games have finished
// Fetches player stats for completed matches in the current and previous round,
// links them to sport_games rows, and upserts into sport_player_stats.

import {
  getCurrentSeason,
  getRounds,
  fetchMatchesForRound,
  fetchPlayerStats,
  normalisePlayerStats,
  normaliseTeamName,
} from './_lib/sources/aflMatchCentre.js'

// Only fetch stats for matches that ended at least this many ms ago
const MIN_AGE_MS = 3 * 60 * 60 * 1000 // 3 hours

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (req.method === 'GET') {
    const auth = req.headers['authorization'] || ''
    if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  } else {
    const secret = req.headers['x-admin-secret'] || req.query.key || ''
    if (!process.env.ADMIN_TEST_SECRET || secret !== process.env.ADMIN_TEST_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured' })
  }

  try {
    const season = await getCurrentSeason()
    const rounds = await getRounds(season.id)

    // Find rounds that have games within the past 7 days
    const nowMs = Date.now()
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    const recentRounds = rounds.filter(r => {
      const end = r.utcEndTime ? Date.parse(r.utcEndTime) : 0
      return end > nowMs - sevenDaysMs && end < nowMs + sevenDaysMs
    })

    if (recentRounds.length === 0) {
      return res.status(200).json({ message: 'No recent AFL rounds found', season: season.name })
    }

    const summary = []

    for (const round of recentRounds) {
      const matches = await fetchMatchesForRound(season.id, round.roundNumber)

      // Only process matches that started at least MIN_AGE_MS ago
      const completed = matches.filter(m => {
        const start = m.utcStartTime ? Date.parse(m.utcStartTime) : 0
        return start > 0 && start + MIN_AGE_MS < nowMs
      })

      for (const match of completed) {
        const matchId = match.providerId
        const homeRaw = match.home?.team?.name || ''
        const awayRaw = match.away?.team?.name || ''
        const home = normaliseTeamName(homeRaw)
        const away = normaliseTeamName(awayRaw)
        const gameDate = match.utcStartTime ? match.utcStartTime.substring(0, 10) : null

        // Find matching game in sport_games
        const gameId = await findGameId(home, away, gameDate, SUPABASE_URL, SUPABASE_KEY)
        if (!gameId) {
          console.log(`  No sport_games match for ${home} v ${away} on ${gameDate}`)
          summary.push({ match: `${home} v ${away}`, status: 'no_game_found' })
          continue
        }

        // Fetch and upsert player stats
        let statsData
        try {
          statsData = await fetchPlayerStats(matchId)
        } catch (err) {
          console.log(`  Stats fetch failed for ${matchId}: ${err.message}`)
          summary.push({ match: `${home} v ${away}`, status: 'stats_fetch_failed' })
          continue
        }

        const rows = normalisePlayerStats(statsData, gameId, home, away)
        if (rows.length === 0) {
          summary.push({ match: `${home} v ${away}`, status: 'no_stats_yet' })
          continue
        }

        await upsertPlayerStats(rows, SUPABASE_URL, SUPABASE_KEY)
        console.log(`  Upserted ${rows.length} player stats for ${home} v ${away}`)
        summary.push({ match: `${home} v ${away}`, players: rows.length, status: 'ok' })
      }
    }

    return res.status(200).json({ season: season.name, rounds: recentRounds.map(r => r.roundNumber), summary })

  } catch (err) {
    console.error('collect-afl-stats error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findGameId(home, away, gameDate, supabaseUrl, supabaseKey) {
  if (!gameDate) return null
  const url = `${supabaseUrl}/rest/v1/sport_games?sport=eq.AFL&game_date=eq.${gameDate}&select=id,home,away`
  const res = await fetch(url, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  })
  if (!res.ok) return null
  const games = await res.json()
  if (!Array.isArray(games)) return null

  const match = games.find(g => {
    const h = g.home.toLowerCase()
    const a = g.away.toLowerCase()
    const qh = home.toLowerCase()
    const qa = away.toLowerCase()
    return (h.includes(qh) || qh.includes(h)) && (a.includes(qa) || qa.includes(a))
  })
  return match?.id || null
}

async function upsertPlayerStats(rows, supabaseUrl, supabaseKey) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/sport_player_stats?on_conflict=game_id,player_name_normalised`,
    {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    }
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Supabase upsert failed: ${err}`)
  }
}
