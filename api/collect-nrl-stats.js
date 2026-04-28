// Vercel Serverless Function — collects NRL player stats from NRL.com match centre
// GET /api/collect-nrl-stats  (cron auth required)
// POST /api/collect-nrl-stats (manual trigger — requires x-admin-secret header)
//
// Cron: daily at 15:30 UTC (1:30am AEST) — after all games have finished
// Fetches player stats for completed matches in the current and previous two rounds,
// links them to sport_games rows, and upserts into sport_player_stats.

import { fetchNrlRound, normaliseTeamName } from './_lib/sources/nrl.js'
import { fetchMatchData, normalisePlayerStats, extractFirstTryScorer } from './_lib/sources/nrlMatchCentre.js'

const SEASON = 2026
const SEASON_START_MS = Date.parse('2026-03-06T00:00:00Z')
const MAX_ROUND = 27

// Only fetch stats for matches that ended at least this many ms ago
const MIN_AGE_MS = 3 * 60 * 60 * 1000 // 3 hours

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
    const roundsToCheck = [currentRound - 2, currentRound - 1, currentRound].filter(r => r >= 1)

    const nowMs = Date.now()
    const summary = []
    let roundFetchFailures = 0

    for (const roundNumber of roundsToCheck) {
      let fixtures
      try {
        fixtures = await fetchNrlRound(SEASON, roundNumber)
      } catch (err) {
        console.log(`  Round ${roundNumber} fetch failed: ${err.message}`)
        roundFetchFailures++
        continue
      }

      // Only process matches that started at least MIN_AGE_MS ago
      const completed = fixtures.filter(f => {
        const kickoff = f.clock?.kickOffTimeLong ? Date.parse(f.clock.kickOffTimeLong) : 0
        return kickoff > 0 && kickoff + MIN_AGE_MS < nowMs && f.matchState === 'FullTime'
      })

      for (const fixture of completed) {
        const matchCentreUrl = fixture.matchCentreUrl
        if (!matchCentreUrl) {
          summary.push({ round: roundNumber, match: 'unknown', status: 'no_match_centre_url' })
          continue
        }

        const homeRaw = fixture.homeTeam?.nickName || ''
        const awayRaw = fixture.awayTeam?.nickName || ''
        const home = normaliseTeamName(homeRaw)
        const away = normaliseTeamName(awayRaw)
        const gameDate = fixture.clock?.kickOffTimeLong?.substring(0, 10) || null

        const gameId = await findGameId(home, away, gameDate, SUPABASE_URL, SUPABASE_KEY)
        if (!gameId) {
          console.log(`  No sport_games match for ${home} v ${away} on ${gameDate}`)
          summary.push({ match: `${home} v ${away}`, round: roundNumber, status: 'no_game_found' })
          continue
        }

        let matchData
        try {
          matchData = await fetchMatchData(matchCentreUrl)
        } catch (err) {
          console.log(`  Match data fetch failed for ${matchCentreUrl}: ${err.message}`)
          summary.push({ match: `${home} v ${away}`, round: roundNumber, status: 'fetch_failed', error: err.message })
          continue
        }

        const rows = normalisePlayerStats(matchData, gameId, home, away)
        if (rows.length === 0) {
          summary.push({ match: `${home} v ${away}`, round: roundNumber, status: 'no_stats_yet' })
          continue
        }

        await upsertPlayerStats(rows, SUPABASE_URL, SUPABASE_KEY)

        // Store first try scorer in sport_games so the resolver can use it
        const firstTry = extractFirstTryScorer(matchData)
        if (firstTry?.playerName) {
          await updateFirstTryScorer(gameId, firstTry.playerName, SUPABASE_URL, SUPABASE_KEY)
        }

        console.log(`  Upserted ${rows.length} player stats for ${home} v ${away} (round ${roundNumber})`)
        summary.push({ match: `${home} v ${away}`, round: roundNumber, players: rows.length, firstTryScorer: firstTry?.playerName || null, status: 'ok' })
      }
    }

    // If every round fetch failed, the NRL API may have changed shape
    if (roundFetchFailures === roundsToCheck.length) {
      console.error('All NRL round fetches failed — NRL.com API may have changed')
      await writeAlert('nrl_api_changed', 'NRL.com stats API is unreachable or has changed shape — all round fetches failed. Check the NRL match centre URL pattern in nrlMatchCentre.js.', SUPABASE_URL, SUPABASE_KEY)
      return res.status(500).json({
        error: 'NRL.com API unreachable or changed shape — all round fetches failed',
        season: SEASON,
        roundsChecked: roundsToCheck,
        summary,
      })
    }

    return res.status(200).json({ season: SEASON, roundsChecked: roundsToCheck, summary })

  } catch (err) {
    console.error('collect-nrl-stats error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function writeAlert(type, message, supabaseUrl, supabaseKey) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/system_alerts`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ type, message }),
    })
  } catch (err) {
    console.error('Failed to write system alert:', err.message)
  }
}

async function findGameId(home, away, gameDate, supabaseUrl, supabaseKey) {
  if (!gameDate) return null
  const url = `${supabaseUrl}/rest/v1/sport_games?sport=eq.NRL&game_date=eq.${gameDate}&select=id,home,away`
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

async function updateFirstTryScorer(gameId, playerName, supabaseUrl, supabaseKey) {
  await fetch(`${supabaseUrl}/rest/v1/sport_games?id=eq.${gameId}`, {
    method: 'PATCH',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ first_try_scorer: playerName }),
  })
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
