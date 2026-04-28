// Handicap resolver — team X +/- N points
// Selection format: "Collingwood -5.5" or "Richmond +12.5"

function teamMatch(name, teamName) {
  const n = name.toLowerCase().trim()
  const t = teamName.toLowerCase().trim()
  return n.includes(t) || t.includes(n)
}

function parseHandicap(text) {
  // "TeamName +/-N.N" or "TeamName (+/-N.N)" — handicap value at the end, optionally in parens
  const m = text.match(/^(.+?)\s*\(?\s*([+-]\s*\d+\.?\d*)\s*\)?\s*(?:pts?\.?)?$/i)
  if (!m) return null
  return {
    team: m[1].trim(),
    handicap: parseFloat(m[2].replace(/\s/g, '')),
  }
}

export function resolve(game, leg) {
  if (!game || game.home_score == null || game.away_score == null) {
    return { outcome: 'pending', reasoning: 'Score not available' }
  }
  if (game.status !== 'final') {
    return { outcome: 'pending', reasoning: `Game not final (${game.status})` }
  }

  const parsed = parseHandicap(leg.selection || '')
  if (!parsed) {
    return { outcome: 'needs_review', reasoning: `Cannot parse handicap from "${leg.selection}"` }
  }

  const pickedHome = teamMatch(parsed.team, game.home)
  const pickedAway = teamMatch(parsed.team, game.away)

  if (!pickedHome && !pickedAway) {
    return { outcome: 'needs_review', reasoning: `Cannot match "${parsed.team}" to ${game.home} or ${game.away}` }
  }

  const selectedScore = pickedHome ? game.home_score : game.away_score
  const opponentScore = pickedHome ? game.away_score : game.home_score
  const adjustedMargin = selectedScore + parsed.handicap - opponentScore

  if (adjustedMargin === 0) return { outcome: 'void', reasoning: 'Push — handicap ties the scores' }

  return {
    outcome: adjustedMargin > 0 ? 'won' : 'lost',
    reasoning: `${game.home} ${game.home_score} - ${game.away_score} ${game.away}, adjusted margin ${adjustedMargin > 0 ? '+' : ''}${adjustedMargin.toFixed(1)}`,
  }
}
