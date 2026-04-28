// Total points resolver — over/under a line
// Reads direction and line from selection or description
// e.g. "Over 165.5", "Under 140", "Total Over 170"

function parseLine(leg) {
  const text = `${leg.selection || ''} ${leg.description || ''}`
  const m = text.match(/(over|under)\s*\(?\s*(\d+\.?\d*)/i)
  if (!m) return null
  return {
    direction: m[1].toLowerCase(),
    line: parseFloat(m[2]),
  }
}

export function resolve(game, leg) {
  if (!game || game.home_score == null || game.away_score == null) {
    return { outcome: 'pending', reasoning: 'Score not available' }
  }
  if (game.status !== 'final') {
    return { outcome: 'pending', reasoning: `Game not final (${game.status})` }
  }

  const parsed = parseLine(leg)
  if (!parsed) {
    return { outcome: 'needs_review', reasoning: `Cannot parse total line from "${leg.selection}"` }
  }

  const total = game.home_score + game.away_score
  if (total === parsed.line) return { outcome: 'void', reasoning: `Total ${total} exactly on the line` }

  const won = parsed.direction === 'over' ? total > parsed.line : total < parsed.line
  return {
    outcome: won ? 'won' : 'lost',
    reasoning: `Total ${total} (${game.home} ${game.home_score} + ${game.away} ${game.away_score}), line ${parsed.line}`,
  }
}
