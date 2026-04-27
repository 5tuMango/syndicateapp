// AFL goal scorer resolver — anytime, first, and N+ goals markets
// resolve(game, leg, players) → { outcome, reasoning }
// players: sport_player_stats rows for this game (pre-fetched by resolveLeg)

import { matchPlayer } from '../nameMatch.js'

function parseLeg(leg) {
  const desc = (leg.description || '').toLowerCase()
  const sel = (leg.selection || '').toLowerCase()
  const combined = `${desc} ${sel}`

  let type = 'anytime' // default
  if (/first goal scorer|to kick first/i.test(combined)) type = 'first'
  else if (/anytime/i.test(combined)) type = 'anytime'

  // N+ goals: "2+ goals", "3 or more goals"
  const nMatch = combined.match(/(\d+)\s*\+\s*goals?/) || combined.match(/(\d+)\s*or\s*more\s*goals?/)
  const threshold = nMatch ? parseInt(nMatch[1]) : 1

  if (nMatch) type = 'threshold'

  const playerName = extractPlayerName(leg)
  if (!playerName) return null

  return { type, threshold, playerName }
}

function extractPlayerName(leg) {
  const sel = (leg.selection || '').trim()
  const stripped = sel.replace(/\s+\d+\+?\s*goals?.*$/i, '').trim()
  return stripped || null
}

export function resolve(game, leg, players) {
  if (!game || game.status !== 'final') {
    return { outcome: 'pending', reasoning: `Game not final (${game?.status || 'unknown'})` }
  }
  if (!players || players.length === 0) {
    return { outcome: 'needs_review', reasoning: 'No player stats available for this game' }
  }

  const parsed = parseLeg(leg)
  if (!parsed) {
    return { outcome: 'needs_review', reasoning: `Cannot parse goal scorer market from "${leg.selection}"` }
  }

  if (parsed.type === 'first') {
    // First goal scorer requires play-by-play data — not available from match centre totals
    return { outcome: 'needs_review', reasoning: 'First goal scorer requires play-by-play data — flag for manual review' }
  }

  const match = matchPlayer(parsed.playerName, players)
  if (match.result === 'no_match') {
    return { outcome: 'needs_review', reasoning: `Player "${parsed.playerName}" not found in game stats` }
  }
  if (match.result === 'needs_review') {
    return { outcome: 'needs_review', reasoning: `Ambiguous player name "${parsed.playerName}"` }
  }

  const player = match.player
  const goals = player.goals ?? 0
  const won = goals >= parsed.threshold

  return {
    outcome: won ? 'won' : 'lost',
    reasoning: `${player.player_name} kicked ${goals} goal${goals !== 1 ? 's' : ''} (needed ${parsed.threshold}+)`,
  }
}
