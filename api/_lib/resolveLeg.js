// resolveLeg — orchestrates in-house resolution for a single bet leg.
//
// Flow: classify market → find game in sport_games → call resolver
// Returns { resolved: true, outcome, reasoning } on success,
//         { resolved: false, reasoning? }           when we can't resolve (fall back to Claude).
//
// Currently supports: AFL match markets (h2h, handicap, total, margin)
// Not yet supported: player stats (phase 7), NRL (phase 9+), other sports

import { classifyMarket } from './classifyMarket.js'
import { resolve as resolveH2H } from './resolvers/h2h.js'
import { resolve as resolveHandicap } from './resolvers/handicap.js'
import { resolve as resolveTotal } from './resolvers/total.js'
import { resolve as resolveMargin } from './resolvers/margin.js'
import { resolve as resolvePlayerStat } from './resolvers/playerStat.js'
import { resolve as resolveGoalScorer } from './resolvers/goalScorer.js'

const MATCH_RESOLVERS = { h2h: resolveH2H, handicap: resolveHandicap, total: resolveTotal, margin: resolveMargin }
const PLAYER_RESOLVERS = { playerStat: resolvePlayerStat, goalScorer: resolveGoalScorer }

export async function resolveLeg(leg, betDate, supabaseUrl, supabaseKey) {
  if (leg.sport !== 'AFL') return { resolved: false }

  const marketType = classifyMarket(leg)
  if (!marketType) return { resolved: false }

  const game = await findGame(leg, betDate, supabaseUrl, supabaseKey)
  if (!game) return { resolved: false, reasoning: 'No matching AFL game in sport_games' }

  if (marketType in MATCH_RESOLVERS) {
    const result = MATCH_RESOLVERS[marketType](game, leg)
    return { ...result, resolved: true }
  }

  if (marketType in PLAYER_RESOLVERS) {
    const players = await fetchPlayerStats(game.id, supabaseUrl, supabaseKey)
    const result = PLAYER_RESOLVERS[marketType](game, leg, players)
    return { ...result, resolved: true }
  }

  return { resolved: false }
}

// ── Player stats lookup ───────────────────────────────────────────────────────

async function fetchPlayerStats(gameId, supabaseUrl, supabaseKey) {
  const url = `${supabaseUrl}/rest/v1/sport_player_stats?game_id=eq.${gameId}&select=*`
  const res = await fetch(url, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  })
  if (!res.ok) return []
  const rows = await res.json()
  return Array.isArray(rows) ? rows : []
}

// ── Game lookup ───────────────────────────────────────────────────────────────

async function findGame(leg, betDate, supabaseUrl, supabaseKey) {
  const date = leg.event_time ? leg.event_time.split('T')[0] : betDate
  if (!date) return null

  const url = `${supabaseUrl}/rest/v1/sport_games?sport=eq.AFL&game_date=eq.${date}&select=*`
  const res = await fetch(url, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  })
  if (!res.ok) return null

  const games = await res.json()
  if (!Array.isArray(games) || games.length === 0) return null
  if (games.length === 1) return games[0]

  // Multiple games on this date — match by team names from event string
  const teams = extractTeams(leg.event || '')
  if (!teams) return null

  return games.find(g => teamsMatch(g, teams[0], teams[1])) || null
}

function extractTeams(event) {
  const m = event.match(/^(.+?)\s+(?:vs?\.?|-)\s+(.+)$/i)
  if (!m) return null
  return [m[1].trim(), m[2].trim()]
}

// True if game's home+away match t1 and t2 in either order
function teamsMatch(game, t1, t2) {
  const home = game.home.toLowerCase()
  const away = game.away.toLowerCase()
  const a = t1.toLowerCase()
  const b = t2.toLowerCase()
  return (
    (home.includes(a) || a.includes(home)) && (away.includes(b) || b.includes(away))
  ) || (
    (home.includes(b) || b.includes(home)) && (away.includes(a) || a.includes(away))
  )
}
