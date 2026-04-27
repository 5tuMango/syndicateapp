// AFL.com.au match centre collector
// Endpoints discovered via DevTools on afl.com.au match centre pages.
//
// Match listing: https://aflapi.afl.com.au/afl/v2/matches?pageSize=300&competitionId=1&compSeasonId={id}&roundNumber={n}
// Player stats:  https://api.afl.com.au/cfs/afl/playerStats/match/{matchProviderId}
// Comp seasons:  https://aflapi.afl.com.au/afl/v2/compseasons?pageSize=5
// Rounds:        https://aflapi.afl.com.au/afl/v2/rounds?pageSize=30&competitionId=1&compSeasonId={id}

const MATCHES_BASE = 'https://aflapi.afl.com.au/afl/v2'
const STATS_BASE = 'https://api.afl.com.au/cfs/afl'
const COMPETITION_ID = 1  // AFL Men's

// AFL.com.au team names → Squiggle canonical names (as stored in sport_games)
const TEAM_NORMALISE = {
  'Adelaide Crows': 'Adelaide',
  'Brisbane Lions': 'Brisbane Lions',
  'Carlton': 'Carlton',
  'Collingwood': 'Collingwood',
  'Essendon': 'Essendon',
  'Fremantle': 'Fremantle',
  'Geelong Cats': 'Geelong',
  'Gold Coast SUNS': 'Gold Coast',
  'GWS GIANTS': 'Greater Western Sydney',
  'Hawthorn': 'Hawthorn',
  'Melbourne': 'Melbourne',
  'North Melbourne': 'North Melbourne',
  'Port Adelaide': 'Port Adelaide',
  'Richmond': 'Richmond',
  'St Kilda': 'St Kilda',
  'Sydney Swans': 'Sydney',
  'West Coast Eagles': 'West Coast',
  'Western Bulldogs': 'Western Bulldogs',
}

export function normaliseTeamName(name) {
  return TEAM_NORMALISE[name] || name
}

// Returns matches for a specific round
export async function fetchMatchesForRound(compSeasonId, roundNumber) {
  const url = `${MATCHES_BASE}/matches?pageSize=300&competitionId=${COMPETITION_ID}&compSeasonId=${compSeasonId}&roundNumber=${roundNumber}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`AFL matches HTTP ${res.status}`)
  const data = await res.json()
  return data.matches || []
}

// Returns raw player stats response for a match
export async function fetchPlayerStats(matchProviderId) {
  const url = `${STATS_BASE}/playerStats/match/${matchProviderId}`
  const res = await fetch(url, {
    headers: {
      'Origin': 'https://www.afl.com.au',
      'Referer': 'https://www.afl.com.au/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`AFL player stats HTTP ${res.status} for ${matchProviderId}: ${body.substring(0, 200)}`)
  }
  return res.json()
}

// Normalises AFL.com.au player stats into sport_player_stats rows.
// game_id must be provided (UUID from sport_games).
export function normalisePlayerStats(data, gameId, homeTeamName, awayTeamName) {
  const rows = []

  const process = (players, teamName) => {
    for (const entry of players || []) {
      const pName = entry.playerStats?.player?.playerName
      if (!pName) continue
      const fullName = `${pName.givenName || ''} ${pName.surname || ''}`.trim()
      if (!fullName) continue

      const s = entry.playerStats?.stats || {}
      rows.push({
        game_id: gameId,
        player_name: fullName,
        player_name_normalised: fullName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(),
        team: teamName,
        goals: round(s.goals),
        behinds: round(s.behinds),
        disposals: round(s.disposals),
        kicks: round(s.kicks),
        handballs: round(s.handballs),
        marks: round(s.marks),
        tackles: round(s.tackles),
        hitouts: round(s.hitouts),
        clearances: round(s.clearances?.totalClearances),
        contested_possessions: round(s.contestedPossessions),
        inside_50s: round(s.inside50s),
        goal_assists: round(s.goalAssists),
        fantasy_points: round(s.dreamTeamPoints),
        raw: entry.playerStats,
      })
    }
  }

  process(data.homeTeamPlayerStats, homeTeamName)
  process(data.awayTeamPlayerStats, awayTeamName)
  return rows
}

function round(val) {
  return val != null ? Math.round(val) : 0
}
