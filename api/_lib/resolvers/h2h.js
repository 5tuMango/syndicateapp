// Head-to-head resolver — team X to win outright
// resolve(game, leg) → { outcome, reasoning }

function teamMatch(selection, teamName) {
  const s = selection.toLowerCase().trim()
  const t = teamName.toLowerCase().trim()
  return s.includes(t) || t.includes(s)
}

export function resolve(game, leg) {
  if (!game || game.home_score == null || game.away_score == null) {
    return { outcome: 'pending', reasoning: 'Score not available' }
  }
  if (game.status !== 'final') {
    return { outcome: 'pending', reasoning: `Game not final (${game.status})` }
  }

  const sel = leg.selection || leg.description || ''
  const pickedHome = teamMatch(sel, game.home)
  const pickedAway = teamMatch(sel, game.away)

  if (pickedHome && pickedAway) {
    return { outcome: 'needs_review', reasoning: `"${sel}" matches both teams` }
  }
  if (!pickedHome && !pickedAway) {
    return { outcome: 'needs_review', reasoning: `Cannot match "${sel}" to ${game.home} or ${game.away}` }
  }

  const margin = game.home_score - game.away_score
  if (margin === 0) return { outcome: 'void', reasoning: 'Draw' }

  const won = pickedHome ? margin > 0 : margin < 0
  return {
    outcome: won ? 'won' : 'lost',
    reasoning: `${game.home} ${game.home_score} - ${game.away_score} ${game.away}`,
  }
}
