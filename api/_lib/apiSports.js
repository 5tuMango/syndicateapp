// Unified API-Sports client.
//
// API-Sports is actually a family of separate APIs — one subdomain per sport,
// different versions (AFL is v1, NBA is v2, Football is v3), and slightly different
// response shapes. This module hides that and exposes a single normalised interface.
//
// Sport label conventions (must match what extract-bet writes into bet.sport / leg.sport):
//   AFL          — Australian Football League
//   NBA          — National Basketball Association (uses NBA-specific v2 API)
//   NBL          — Australian National Basketball League (uses generic Basketball v1)
//   Basketball   — any other basketball league (EuroLeague, WNBA, etc.)
//   Soccer       — any football/soccer league (A-League, EPL, UCL, etc.)
//   NFL          — National Football League
//   NCAAF        — College football
//
// NRL is NOT here — API-Sports' Rugby API is rugby union only.
// MMA, F1, MLB, NHL also deliberately omitted (Wave 2+).

const ENDPOINTS = {
  AFL:        { url: 'https://v1.afl.api-sports.io/games',                shape: 'afl' },
  NBA:        { url: 'https://v2.nba.api-sports.io/games',                shape: 'nba' },
  NBL:        { url: 'https://v1.basketball.api-sports.io/games',         shape: 'basketball', league: 198 },
  Basketball: { url: 'https://v1.basketball.api-sports.io/games',         shape: 'basketball' },
  Soccer:     { url: 'https://v3.football.api-sports.io/fixtures',        shape: 'soccer' },
  NFL:        { url: 'https://v1.american-football.api-sports.io/games',  shape: 'american', league: 1 },
  NCAAF:      { url: 'https://v1.american-football.api-sports.io/games',  shape: 'american', league: 2 },
}

// Status codes that mean "game is over" across the various APIs.
// Each shape's `parseStatus` checks this set + falls back to text inspection.
const FINISHED_STATUSES = new Set([
  'FT', 'AOT', 'AET', 'PEN', 'FN',           // soccer / generic
  'After Over Time', 'Finished',             // long form
  'Match Finished',                          // some shapes
  'AOT',                                     // after over time
])

export function isSportSupported(sport) {
  return Boolean(ENDPOINTS[sport])
}

export function listSupportedSports() {
  return Object.keys(ENDPOINTS)
}

// ── Public: fetch normalised games for a given sport + date ──────────────────
// Returns: Array<NormalisedGame> | null
//   NormalisedGame = {
//     home, away, homeScore, awayScore,
//     status: 'final' | 'in_progress' | 'upcoming' | 'unknown',
//     statusRaw, gameTime, raw
//   }
export async function fetchGames(sport, dateStr, apiKey) {
  const config = ENDPOINTS[sport]
  if (!config || !apiKey) return null

  // Soccer/Football v3 needs a season param when filtering by league but not
  // when filtering by date alone. We fetch all fixtures on the date and let
  // the team matcher filter — simpler and avoids guessing season for AU calendar.
  let url = `${config.url}?date=${dateStr}`
  if (config.league && config.shape !== 'soccer') {
    // American football wants league + season. Use the year from the date.
    const year = dateStr.slice(0, 4)
    url += `&league=${config.league}&season=${year}`
  }
  if (config.shape === 'basketball' && config.league) {
    url += `&league=${config.league}&season=${dateStr.slice(0, 4)}`
  }

  try {
    const res = await fetch(url, { headers: { 'x-apisports-key': apiKey } })
    if (!res.ok) return null
    const data = await res.json()
    const raw = Array.isArray(data.response) ? data.response : []
    return raw.map((g) => normalise(g, config.shape)).filter(Boolean)
  } catch {
    return null
  }
}

// ── Public: format a list of games into a text block for Claude context ──────
// Used when we want Claude to see confirmed scores rather than web-search for them.
export function formatGamesForContext(games) {
  if (!Array.isArray(games) || games.length === 0) return null
  return games
    .map((g) => {
      if (g.status === 'final' && g.homeScore != null && g.awayScore != null) {
        return `[FINAL] ${g.home} ${g.homeScore} - ${g.awayScore} ${g.away}`
      }
      if (g.status === 'in_progress') {
        return `[IN PROGRESS] ${g.home} ${g.homeScore ?? '?'} - ${g.awayScore ?? '?'} ${g.away}`
      }
      return `[UPCOMING] ${g.home} vs ${g.away}`
    })
    .join('\n')
}

// ── Public: split an event string like "Richmond v Melbourne" into team names ──
export function extractTeams(eventStr) {
  if (!eventStr) return []
  return eventStr
    .split(/\s+v(?:s)?\.?\s+/i)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ── Public: find the game in a list that matches a leg's event string ────────
// Loose match — case-insensitive substring on either team name. Returns null if
// no team can be confidently matched (avoids resolving the wrong game).
export function findGame(games, teamNames) {
  if (!Array.isArray(games) || !teamNames?.length) return null
  const wantedLower = teamNames.map((t) => t.toLowerCase())
  for (const g of games) {
    const home = (g.home || '').toLowerCase()
    const away = (g.away || '').toLowerCase()
    const hit = wantedLower.some((t) =>
      home.includes(t) || t.includes(home) ||
      away.includes(t) || t.includes(away)
    )
    if (hit) return g
  }
  return null
}

// ── Internal: per-shape normalisation ────────────────────────────────────────
function normalise(game, shape) {
  try {
    const home = game.teams?.home?.name
    const away = game.teams?.away?.name
    if (!home || !away) return null

    const statusShort = game.status?.short || game.fixture?.status?.short || ''
    const statusLong = game.status?.long || game.fixture?.status?.long || ''
    const statusRaw = statusLong || statusShort || ''

    const finished =
      FINISHED_STATUSES.has(statusShort) ||
      FINISHED_STATUSES.has(statusLong) ||
      statusRaw.toLowerCase().includes('finish') ||
      statusRaw.toLowerCase().includes('complete') ||
      statusRaw.toLowerCase().includes('after over time')

    let homeScore, awayScore

    switch (shape) {
      case 'afl':
        homeScore = game.scores?.home?.total
        awayScore = game.scores?.away?.total
        break
      case 'nba':
        // NBA v2: scores.home.points or scores.home.linescore[].sum
        homeScore = game.scores?.home?.points ?? game.scores?.home?.total ?? null
        awayScore = game.scores?.away?.points ?? game.scores?.away?.total ?? null
        break
      case 'basketball':
        homeScore = game.scores?.home?.total ?? game.scores?.home ?? null
        awayScore = game.scores?.away?.total ?? game.scores?.away ?? null
        break
      case 'soccer':
        // v3 fixtures: goals.home / goals.away
        homeScore = game.goals?.home ?? null
        awayScore = game.goals?.away ?? null
        break
      case 'american':
        // American football v1: scores.home.total
        homeScore = game.scores?.home?.total ?? null
        awayScore = game.scores?.away?.total ?? null
        break
      default:
        homeScore = null
        awayScore = null
    }

    let status
    if (finished && homeScore != null && awayScore != null) status = 'final'
    else if (homeScore != null || awayScore != null) status = 'in_progress'
    else if (statusRaw) status = 'upcoming'
    else status = 'unknown'

    const gameTime =
      game.date ||
      game.fixture?.date ||
      game.game?.date?.start ||
      null

    return { home, away, homeScore, awayScore, status, statusRaw, gameTime, raw: game }
  } catch {
    return null
  }
}
