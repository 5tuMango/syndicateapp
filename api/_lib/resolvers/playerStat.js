// Player stat resolver — X+ disposals / tackles / kicks / etc. and Over/Under markets.
// Looks up the player in sport_player_stats for the game and checks the threshold.
//
// resolve(game, leg, players) → { outcome, reasoning }
// players: sport_player_stats rows for this game (pre-fetched by resolveLeg)

import { matchPlayer } from '../nameMatch.js'

// Maps market keywords to stat field names.
// AFL stats are stored as top-level columns; NRL stats are in the raw jsonb field.
// The resolver checks player[field] first, then player.raw?.[field] as fallback.
const STAT_MAP = {
  // AFL
  disposal: 'disposals', disposals: 'disposals',
  handball: 'handballs', handballs: 'handballs',
  mark: 'marks', marks: 'marks',
  hitout: 'hitouts', hitouts: 'hitouts',
  clearance: 'clearances', clearances: 'clearances',
  'inside 50': 'inside_50s', 'inside50': 'inside_50s',
  'goal assist': 'goal_assists', 'goal assists': 'goal_assists',
  'contested possession': 'contested_possessions',
  // Shared (column exists for both)
  kick: 'kicks', kicks: 'kicks',
  tackle: 'tackles', tackles: 'tackles',
  fantasy: 'fantasy_points', 'dream team': 'fantasy_points',
  // NRL (stored in raw field)
  'run metre': 'allRunMetres', 'run metres': 'allRunMetres', 'running metre': 'allRunMetres',
  'line break': 'lineBreaks', 'line breaks': 'lineBreaks',
  'try assist': 'tryAssists', 'try assists': 'tryAssists',
  offload: 'offloads', offloads: 'offloads',
  'missed tackle': 'missedTackles', 'missed tackles': 'missedTackles',
  'kick metre': 'kickMetres', 'kick metres': 'kickMetres',
}

function parseLeg(leg) {
  const combined = `${leg.description || ''} ${leg.selection || ''}`.toLowerCase()

  // Find the stat type
  let statCol = null
  for (const [keyword, col] of Object.entries(STAT_MAP)) {
    if (combined.includes(keyword)) { statCol = col; break }
  }
  if (!statCol) return null

  // Over/Under market: "Over (26.5)", "Under (20.5)"
  const ouMatch = combined.match(/\b(over|under)\s*\(?\s*(\d+(?:\.\d+)?)\s*\)?/)
  if (ouMatch) {
    const direction = ouMatch[1] === 'over' ? 'over' : 'under'
    const threshold = parseFloat(ouMatch[2])
    const playerName = extractPlayerName(leg)
    if (!playerName) return null
    return { statCol, threshold, direction, playerName }
  }

  // X+ / "X or more" market — always over
  const threshMatch = combined.match(/(\d+(?:\.\d+)?)\s*\+/) || combined.match(/(\d+(?:\.\d+)?)\s*or\s*more/)
  if (!threshMatch) return null
  const threshold = parseFloat(threshMatch[1])

  const playerName = extractPlayerName(leg)
  if (!playerName) return null

  return { statCol, threshold, direction: 'over', playerName }
}

function extractPlayerName(leg) {
  const sel = (leg.selection || '').trim()
  // Strip "Over (X)" or "Under (X)" suffix first
  const stripped = sel.replace(/\s+(over|under)\s*\(?\s*[\d.]+\s*\)?.*$/i, '').trim()
  if (stripped && stripped !== sel) return stripped
  // Strip trailing "X+ StatName" pattern
  return sel.replace(/\s+\d+\+?\s+\w+.*$/i, '').trim() || null
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
  // Check top-level column first (AFL), then raw jsonb field (NRL)
  const actual = player[parsed.statCol] ?? player.raw?.[parsed.statCol] ?? 0
  const won = parsed.direction === 'under' ? actual < parsed.threshold : actual >= parsed.threshold

  return {
    outcome: won ? 'won' : 'lost',
    reasoning: `${player.player_name} had ${actual} ${parsed.statCol} (${parsed.direction} ${parsed.threshold})`,
  }
}
