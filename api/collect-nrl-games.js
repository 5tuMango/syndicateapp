// Vercel Serverless Function — collects NRL game data from NRL.com into sport_games
// GET /api/collect-nrl-games  (cron auth required)
// POST /api/collect-nrl-games (manual trigger — requires x-admin-secret header)
//
// Cron: daily at 14:30 UTC (12:30am AEST) — picks up results from the day before
// Fetches rounds within a ±3-round window of the estimated current round and upserts
// into sport_games.

import { fetchNrlRound, normaliseFixture } from './_lib/sources/nrl.js'

// NRL 2026: Round 1 started ~6 Mar 2026 (UTC)
const SEASON = 2026
const SEASON_START_MS = Date.parse('2026-03-06T00:00:00Z')
const MAX_ROUND = 27

function estimateCurrentRound() {
  const weeksSinceStart = Math.floor((Date.now() - SEASON_START_MS) / (7 * 24 * 60 * 60 * 1000))
  return Math.max(1, Math.min(weeksSinceStart + 1, MAX_ROUND))
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
    // Check current round and the previous two — catches missed games on first run
    const roundsToCheck = [currentRound - 2, currentRound - 1, currentRound].filter(r => r >= 1)

    const rows = []
    const roundResults = []

    for (const round of roundsToCheck) {
      let fixtures
      try {
        fixtures = await fetchNrlRound(SEASON, round)
      } catch (err) {
        console.log(`collect-nrl-games: round ${round} fetch failed: ${err.message}`)
        roundResults.push({ round, status: 'fetch_failed', error: err.message })
        continue
      }

      const normalised = fixtures.map(normaliseFixture).filter(g => g.game_date)
      rows.push(...normalised)
      roundResults.push({ round, fixtures: normalised.length })
    }

    if (rows.length === 0) {
      return res.status(200).json({ upserted: 0, season: SEASON, rounds: roundResults })
    }

    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/sport_games?on_conflict=source,sport,game_date,home,away`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
      }
    )

    if (!upsertRes.ok) {
      const err = await upsertRes.text()
      throw new Error(`Supabase upsert failed: ${err}`)
    }

    console.log(`collect-nrl-games: upserted ${rows.length} games (season ${SEASON}, rounds ${roundsToCheck.join(',')})`)
    return res.status(200).json({
      season: SEASON,
      roundsChecked: roundsToCheck,
      upserted: rows.length,
      rounds: roundResults,
      games: rows.map(g => `${g.home} v ${g.away} (${g.game_date}) — ${g.status}`),
    })

  } catch (err) {
    console.error('collect-nrl-games error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
