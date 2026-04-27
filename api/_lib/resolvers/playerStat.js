// Player stat resolver — X+ disposals / tackles / kicks / etc.
// Looks up the player in sport_player_stats for the game and checks the threshold.
//
// resolve(game, leg, players) → { outcome, reasoning }
// players: sport_player_stats rows for this game (pre-fetched by resolveLeg)

import { matchPlayer } from '../nameMatch.js'

// Maps market keywords to stat column names
const STAT_MAP = {
  disposal: 'disposals', disposals: 'disposals',
  kick: 'kicks', kicks: 'kicks',
  handball: 'handballs', handballs: 'handballs',
  mark: 'marks', marks: 'marks',
  tackle: 'tackles', tackles: 'tackles',
  hitout: 'hitouts', hitouts: 'hitouts',
  clearance: 'clearances', clearances: 'clearances',
  'inside 50': 'inside_50s', 'inside50': 'inside_50s',
  'goal assist': 'goal_assists', 'goal assists': 'goal_assists',
  'contested possession': 'contested_possessions',
  fantasy: 'fantasy_points', 'dream team': 'fantasy_points',
}

function parseLeg(leg) {
  const combined = `${leg.description || ''} ${leg.selection || ''}`.toLowerCase()

  // Find the stat type
  let statCol = null
  for (const [keyword, col] of Object.entries(STAT_MAP)) {
    if (combined.includes(keyword)) { statCol = col; break }
  }
  if (!statCol) return null

  // Find the threshold — "25+ disposals", "20 or more kicks", "2+ goals"
  const threshMatch = combined.match(/(\d+)\s*\+/) || combined.match(/(\d+)\s*or\s*more/)
  if (!threshMatch) return null
  const threshold = parseInt(threshMatch[1])

  // Find the player name — usually the selection or the part before the stat
  // e.g. "Clayton Oliver 25+ Disposals" or selection = "Clayton Oliver"
  const playerName = extractPlayerName(leg)
  if (!playerName) return null

  return { statCol, threshold, playerName }
}

function extractPlayerName(leg) {
  // Selection often contains just the player name, or "Player Name X+ Stat"
  const sel = (leg.selection || '').trim()
  // Strip trailing "X+ StatName" pattern to get player name
  const stripped = sel.replace(/\s+\d+\+?\s+\w+.*$/i, '').trim()
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
    return { outcome: 'needs_review', reasoning: `Cannot parse stat market from "${leg.description} / ${leg.selection}"` }
  }

  const match = matchPlayer(parsed.playerName, players)
  if (match.result === 'no_match') {
    return { outcome: 'needs_review', reasoning: `Player "${parsed.playerName}" not found in game stats` }
  }
  if (match.result === 'needs_review') {
    return { outcome: 'needs_review', reasoning: `Ambiguous player name "${parsed.playerName}"` }
  }

  const player = match.player
  const actual = player[parsed.statCol] ?? 0
  const won = actual >= parsed.threshold

  return {
    outcome: won ? 'won' : 'lost',
    reasoning: `${player.player_name} had ${actual} ${parsed.statCol} (needed ${parsed.threshold}+)`,
  }
}
