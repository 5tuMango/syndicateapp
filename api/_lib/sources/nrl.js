// NRL.com draw API collector
// Endpoint discovered via direct browser navigation (not XHR — server renders the page
// but exposes raw JSON at the /draw/data path).
//
// Draw data: https://www.nrl.com/draw/data?competition=111&season=YYYY&round=N
// No auth required. Returns fixtures array with scores for completed games.

const DRAW_BASE = 'https://www.nrl.com/draw/data'
const COMPETITION_ID = 111  // NRL Premiership

// NRL.com nickNames → canonical names for sport_games
// Most NRL.com names are already short/canonical, but a few differ.
const TEAM_NORMALISE = {
  'Broncos': 'Brisbane Broncos',
  'Raiders': 'Canberra Raiders',
  'Bulldogs': 'Canterbury Bulldogs',
  'Titans': 'Gold Coast Titans',
  'Sea Eagles': 'Manly Sea Eagles',
  'Storm': 'Melbourne Storm',
  'Knights': 'Newcastle Knights',
  'Warriors': 'New Zealand Warriors',
  'Panthers': 'Penrith Panthers',
  'Dragons': 'St George Illawarra Dragons',
  'Rabbitohs': 'South Sydney Rabbitohs',
  'Sharks': 'Cronulla Sharks',
  'Cowboys': 'North Queensland Cowboys',
  'Eels': 'Parramatta Eels',
  'Roosters': 'Sydney Roosters',
  'Wests Tigers': 'Wests Tigers',
  'Dolphins': 'Dolphins',
}

export function normaliseTeamName(name) {
  return TEAM_NORMALISE[name] || name
}

// Returns all fixtures for a given season + round from NRL.com
export async function fetchNrlRound(season, round) {
  const url = `${DRAW_BASE}?competition=${COMPETITION_ID}&season=${season}&round=${round}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SyndicateBot/1.0)',
    },
  })
  if (!res.ok) throw new Error(`NRL draw HTTP ${res.status} for round ${round}`)
  const data = await res.json()
  return data.fixtures || []
}

// Returns all fixtures for a season by fetching rounds 1..maxRound in sequence.
// Stops early if a round returns no fixtures (season ended).
export async function fetchNrlSeason(season, maxRound = 27) {
  const all = []
  for (let r = 1; r <= maxRound; r++) {
    let fixtures
    try {
      fixtures = await fetchNrlRound(season, r)
    } catch {
      break
    }
    if (!fixtures || fixtures.length === 0) break
    all.push(...fixtures)
  }
  return all
}

// Maps a single NRL.com fixture to a sport_games row.
export function normaliseFixture(fixture) {
  const homeRaw = fixture.homeTeam?.nickName || ''
  const awayRaw = fixture.awayTeam?.nickName || ''
  const home = normaliseTeamName(homeRaw)
  const away = normaliseTeamName(awayRaw)

  const kickoff = fixture.clock?.kickOffTimeLong || null
  const gameDate = kickoff ? kickoff.substring(0, 10) : null

  const matchState = fixture.matchState || ''
  const matchMode = fixture.matchMode || ''

  let status = 'upcoming'
  if (matchState === 'FullTime' || matchMode === 'Post') status = 'final'
  else if (matchMode === 'Live') status = 'in_progress'

  const homeScore = fixture.homeTeam?.score ?? null
  const awayScore = fixture.awayTeam?.score ?? null
  const htHome = fixture.homeTeam?.scoring?.halfTimeScore ?? null
  const htAway = fixture.awayTeam?.scoring?.halfTimeScore ?? null

  return {
    source: 'nrl.com',
    sport: 'NRL',
    game_date: gameDate,
    home,
    away,
    home_score: status !== 'upcoming' ? homeScore : null,
    away_score: status !== 'upcoming' ? awayScore : null,
    ht_home: status !== 'upcoming' ? htHome : null,
    ht_away: status !== 'upcoming' ? htAway : null,
    status,
    raw: fixture,
  }
}
