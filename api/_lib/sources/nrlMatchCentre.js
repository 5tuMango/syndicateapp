// NRL.com match centre stats collector
// Endpoint: https://www.nrl.com{matchCentreUrl}data
// matchCentreUrl comes from the draw API fixture, e.g.:
//   /draw/nrl-premiership/2026/round-8/wests-tigers-v-raiders/
// No auth required.

export async function fetchMatchData(matchCentreUrl) {
  const url = `https://www.nrl.com${matchCentreUrl}data`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SyndicateBot/1.0)' },
  })
  if (!res.ok) throw new Error(`NRL match data HTTP ${res.status} for ${matchCentreUrl}`)
  return res.json()
}

// Normalises NRL match data into sport_player_stats rows.
// game_id must be provided (UUID from sport_games).
export function normalisePlayerStats(data, gameId, homeTeamName, awayTeamName) {
  // Build playerId → player info map from the roster
  const playerMap = new Map()
  for (const p of data.homeTeam?.players || []) {
    playerMap.set(p.playerId, { firstName: p.firstName, lastName: p.lastName })
  }
  for (const p of data.awayTeam?.players || []) {
    playerMap.set(p.playerId, { firstName: p.firstName, lastName: p.lastName })
  }

  const rows = []

  const process = (statsArray, teamName) => {
    for (const s of statsArray || []) {
      const info = playerMap.get(s.playerId)
      if (!info) continue
      const fullName = `${info.firstName} ${info.lastName}`.trim()
      if (!fullName) continue

      rows.push({
        game_id: gameId,
        player_name: fullName,
        player_name_normalised: fullName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(),
        team: teamName,
        // Map to shared columns where applicable
        tackles: s.tacklesMade ?? 0,
        kicks: s.kicks ?? 0,
        fantasy_points: s.fantasyPointsTotal ?? 0,
        // NRL-specific stats stored in raw so resolvers can access them
        raw: s,
      })
    }
  }

  process(data.stats?.players?.homeTeam, homeTeamName)
  process(data.stats?.players?.awayTeam, awayTeamName)
  return rows
}

// Extracts first try scorer from the timeline array.
// Returns { playerName, teamId, gameSeconds } or null.
export function extractFirstTryScorer(data) {
  const timeline = data.timeline || []
  const tryEvent = timeline.find(e => e.type === 'Try')
  if (!tryEvent) return null

  const playerMap = new Map()
  for (const p of [...(data.homeTeam?.players || []), ...(data.awayTeam?.players || [])]) {
    playerMap.set(p.playerId, `${p.firstName} ${p.lastName}`.trim())
  }

  return {
    playerName: playerMap.get(tryEvent.playerId) || null,
    teamId: tryEvent.teamId,
    gameSeconds: tryEvent.gameSeconds,
  }
}
