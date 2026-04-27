// Squiggle AFL game collector — https://api.squiggle.com.au
// Free public API built for hobbyists. Polite User-Agent required.
// Docs: https://api.squiggle.com.au

const BASE = 'https://api.squiggle.com.au/'
const UA = 'Syndicate hobby bet tracker - contact via github'

// Fetch games for a given year, optionally filtered to a specific round.
// Returns an array of normalised game objects ready for sport_games upsert.
export async function fetchSquiggleGames(year, round = null) {
  let url = `${BASE}?q=games;year=${year}`
  if (round != null) url += `;round=${round}`

  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`Squiggle HTTP ${res.status} for ${url}`)

  const data = await res.json()
  return (data.games || []).map(normaliseGame)
}

function normaliseGame(g) {
  const status =
    g.complete === 100 ? 'final'
    : g.complete > 0   ? 'in_progress'
    :                    'upcoming'

  // Squiggle dates are local Australian time "YYYY-MM-DD HH:MM:SS"
  const gameDate = g.date ? g.date.substring(0, 10) : null
  // Treat as AEST (UTC+10) — consistent with how event_time is stored elsewhere
  const kickoffAt = g.date ? g.date.substring(0, 16).replace(' ', 'T') + ':00+10:00' : null

  // Quarter scores: Squiggle returns cumulative total points per team at end of each quarter.
  // Field names are hq1..hq4 (home) and aq1..aq4 (away). Null if not yet played.
  return {
    source: 'squiggle',
    sport: 'AFL',
    game_date: gameDate,
    kickoff_at: kickoffAt,
    home: g.hteam,
    away: g.ateam,
    home_score: g.hscore ?? null,
    away_score: g.ascore ?? null,
    ht_home: g.hq2 ?? null,   // half-time = end of Q2
    ht_away: g.aq2 ?? null,
    q1_home: g.hq1 ?? null, q1_away: g.aq1 ?? null,
    q2_home: g.hq2 ?? null, q2_away: g.aq2 ?? null,
    q3_home: g.hq3 ?? null, q3_away: g.aq3 ?? null,
    q4_home: g.hq4 ?? null, q4_away: g.aq4 ?? null,
    status,
    raw: g,
  }
}
