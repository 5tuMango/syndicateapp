// Vercel Serverless Function — collects AFL game data from Squiggle into sport_games
// GET /api/collect-afl-games  (cron auth required)
// POST /api/collect-afl-games (manual trigger — requires ADMIN_TEST_SECRET header)
//
// Cron: every 2 hours Thu–Mon during AFL season (see vercel.json)
// Fetches games within a ±7-day window of today and upserts into sport_games.

import { fetchSquiggleGames } from './_lib/sources/squiggle.js'

const WINDOW_DAYS = 7

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Auth: cron uses CRON_SECRET header, manual POST uses ADMIN_TEST_SECRET
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
    const year = new Date().getFullYear()
    const allGames = await fetchSquiggleGames(year)

    // ?all=1 bypasses the date filter — use for one-off backfill runs
    const skipFilter = req.query.all === '1'
    const nowMs = Date.now()
    const windowMs = WINDOW_DAYS * 24 * 60 * 60 * 1000
    const relevant = skipFilter ? allGames.filter(g => g.game_date && g.home && g.away) : allGames.filter(g => {
      if (!g.game_date) return false
      const t = Date.parse(g.game_date)
      return !isNaN(t) && Math.abs(t - nowMs) <= windowMs
    })

    if (relevant.length === 0) {
      return res.status(200).json({ upserted: 0, message: 'No AFL games in window' })
    }

    // Upsert — on conflict (source, sport, game_date, home, away) update scores + status
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
        body: JSON.stringify(relevant),
      }
    )

    if (!upsertRes.ok) {
      const err = await upsertRes.text()
      throw new Error(`Supabase upsert failed: ${err}`)
    }

    console.log(`collect-afl-games: upserted ${relevant.length} games (year ${year})`)
    return res.status(200).json({ upserted: relevant.length, year, games: relevant.map(g => `${g.home} v ${g.away} (${g.game_date}) — ${g.status}`) })

  } catch (err) {
    console.error('collect-afl-games error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
