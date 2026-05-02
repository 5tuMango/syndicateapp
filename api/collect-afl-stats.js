// Vercel Serverless Function — collects AFL player stats from AFL.com.au match centre
// GET /api/collect-afl-stats  (cron auth required)
// POST /api/collect-afl-stats (manual trigger — requires x-admin-secret header)
//
// Cron: daily at 15:00 UTC (1am AEST) — after all games have finished
// Fetches player stats for completed matches in the current and previous round,
// links them to sport_games rows, and upserts into sport_player_stats.
//
// MIS token is auto-fetched via POST /WMCTok on each run — no AFL_MIS_TOKEN env var needed.

import {
  fetchMatchesForRound,
  fetchPlayerStats,
  normalisePlayerStats,
  normaliseTeamName,
} from './_lib/sources/aflMatchCentre.js'

// 2026 AFL season — update compSeasonId at the start of each new season
const COMP_SEASON_ID = 85
// Round 1 of 2026 season started ~14 Mar 2026 (UTC)
const SEASON_START_MS = Date.parse('2026-03-14T00:00:00Z')

// Stats are only collected once sport_games.status = 'final' (set by collect-afl-games).
// This avoids hammering the stats API mid-game and ensures resolver has complete data.

function estimateCurrentRound() {
  const weeksSinceStart = Math.floor((Date.now() - SEASON_START_MS) / (7 * 24 * 60 * 60 * 1000))
  return Math.max(1, Math.min(weeksSinceStart + 1, 28))
}

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
    const currentRound = estimateCurrentRound()
    // ?from=N&to=M overrides round range for backfill runs
    const fromRound = req.query.from ? parseInt(req.query.from) : currentRound - 2
    const toRound = req.query.to ? parseInt(req.query.to) : currentRound
    const roundsToCheck = []
    for (let r = Math.max(1, fromRound); r <= Math.min(toRound, 28); r++) roundsToCheck.push(r)

    const summary = []

    for (const roundNumber of roundsToCheck) {
      let matches
      try {
        matches = await fetchMatchesForRound(COMP_SEASON_ID, roundNumber)
      } catch (err) {
        console.log(`  Round ${roundNumber} fetch failed: ${err.message}`)
        continue
      }

      for (const match of matches) {
        const matchId = match.providerId
        const homeRaw = match.home?.team?.name || ''
        const awayRaw = match.away?.team?.name || ''
        const home = normaliseTeamName(homeRaw)
        const away = normaliseTeamName(awayRaw)
        const gameDate = match.utcStartTime ? match.utcStartTime.substring(0, 10) : null

        const game = await findGame(home, away, gameDate, SUPABASE_URL, SUPABASE_KEY)
        if (!game) {
          // Game not in DB yet (collect-afl-games hasn't run) — skip silently
          continue
        }
        // Only collect stats once the game is marked final by collect-afl-games
        if (game.status !== 'final') {
          console.log(`  Skipping ${home} v ${away} (status: ${game.status || 'unknown'})`)
          summary.push({ match: `${home} v ${away}`, round: roundNumber, status: 'not_final' })
          continue
        }
        const gameId = game.id

        let statsData
        try {
          // fetchPlayerStats auto-fetches a fresh MIS token via /WMCTok — no env var needed
          statsData = await fetchPlayerStats(matchId)
        } catch (err) {
          console.log(`  Stats fetch failed for ${matchId}: ${err.message}`)
          summary.push({ match: `${home} v ${away}`, round: roundNumber, status: 'stats_fetch_failed', error: err.message })
          continue
        }

        const rows = normalisePlayerStats(statsData, gameId, home, away)
        if (rows.length === 0) {
          summary.push({ match: `${home} v ${away}`, round: roundNumber, status: 'no_stats_yet' })
          continue
        }

        await upsertPlayerStats(rows, SUPABASE_URL, SUPABASE_KEY)
        console.log(`  Upserted ${rows.length} player stats for ${home} v ${away} (round ${roundNumber})`)
        summary.push({ match: `${home} v ${away}`, round: roundNumber, players: rows.length, status: 'ok' })
      }
    }

    return res.status(200).json({ compSeasonId: COMP_SEASON_ID, roundsChecked: roundsToCheck, summary })

  } catch (err) {
    console.error('collect-afl-stats error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns the matching sport_games row (including status) or null if not found.
async function findGame(home, away, gameDate, supabaseUrl, supabaseKey) {
  if (!gameDate) return null
  const url = `${supabaseUrl}/rest/v1/sport_games?sport=eq.AFL&game_date=eq.${gameDate}&select=id,home,away,status`
  const res = await fetch(url, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  })
  if (!res.ok) return null
  const games = await res.json()
  if (!Array.isArray(games)) return null

  return games.find(g => {
    const h = g.home.toLowerCase()
    const a = g.away.toLowerCase()
    const qh = home.toLowerCase()
    const qa = away.toLowerCase()
    return (h.includes(qh) || qh.includes(h)) && (a.includes(qa) || qa.includes(a))
  }) || null
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
