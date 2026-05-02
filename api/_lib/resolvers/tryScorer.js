// NRL try scorer resolver — anytime and N+ tries markets
// First try scorer requires timeline data not stored in sport_player_stats,
// so it falls through to needs_review.
//
// resolve(game, leg, players) → { outcome, reasoning }
// players: sport_player_stats rows (raw field contains NRL per-player stats)

import { matchPlayer } from '../nameMatch.js'

function parseLeg(leg) {
  const desc = (leg.description || '').toLowerCase()
  const sel = (leg.selection || '').toLowerCase()
  const combined = `${desc} ${sel}`

  let type = 'anytime'
  if (/first try scorer|to score first/i.test(combined)) type = 'first'
  else if (/anytime/i.test(combined)) type = 'anytime'

  // N+ tries: "2+ tries", "2+ try", "2 or more tries"
  const nMatch = combined.match(/(\d+)\s*\+\s*tr(?:y|ies)/) || combined.match(/(\d+)\s*or\s*more\s*tr(?:y|ies)/)
  const threshold = nMatch ? parseInt(nMatch[1]) : 1
  if (nMatch) type = 'threshold'

  const playerName = extractPlayerName(leg)
  if (!playerName) return null

  return { type, threshold, playerName }
}

function extractPlayerName(leg) {
  const sel = (leg.selection || '').trim()
  // Strip "1+ Try", "2+ Tries", "1 Try" etc — tries? matches "tries"/"trie" but not "try"
  const stripped = sel.replace(/\s+\d+\+?\s*tr(?:y|ies).*$/i, '').trim()
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
    return { outcome: 'needs_review', reasoning: `Cannot parse try scorer market from "${leg.selection}"` }
  }

  if (parsed.type === 'first') {
    if (!game.first_try_scorer) {
      return { outcome: 'needs_review', reasoning: 'First try scorer not yet recorded for this game' }
    }
    const fts = game.first_try_scorer.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    const sel = parsed.playerName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    const won = fts === sel || fts.includes(sel) || sel.includes(fts)
    return {
      outcome: won ? 'won' : 'lost',
      reasoning: `First try scorer was ${game.first_try_scorer} (selected: ${parsed.playerName})`,
    }
  }

  const match = matchPlayer(parsed.playerName, players)
  if (match.result === 'no_match') {
    return { outcome: 'needs_review', reasoning: `Player "${parsed.playerName}" not found in game stats` }
  }
  if (match.result === 'needs_review') {
    return { outcome: 'needs_review', reasoning: `Ambiguous player name "${parsed.playerName}"` }
  }

  const player = match.player
  // tries is stored in raw for NRL
  const tries = player.raw?.tries ?? player.tries ?? 0
  const won = tries >= parsed.threshold

  return {
    outcome: won ? 'won' : 'lost',
    reasoning: `${player.player_name} scored ${tries} tr${tries !== 1 ? 'ies' : 'y'} (needed ${parsed.threshold}+)`,
  }
}
