// AFL quarter winner resolver
// Squiggle returns CUMULATIVE scores at end of each quarter, so per-quarter
// scores require subtraction of the previous quarter's total.
//
// resolve(game, leg) → { outcome, reasoning }

const QUARTER_MAP = {
  'q1': 1, 'quarter 1': 1, '1st quarter': 1, 'first quarter': 1,
  'q2': 2, 'quarter 2': 2, '2nd quarter': 2, 'second quarter': 2,
  'q3': 3, 'quarter 3': 3, '3rd quarter': 3, 'third quarter': 3,
  'q4': 4, 'quarter 4': 4, '4th quarter': 4, 'fourth quarter': 4,
}

function parseQuarter(combined) {
  for (const [key, q] of Object.entries(QUARTER_MAP)) {
    if (combined.includes(key)) return q
  }
  return null
}

function quarterScores(game, q) {
  // Squiggle cumulative totals: Q1 score is direct; later quarters need subtraction
  switch (q) {
    case 1: return { home: game.q1_home, away: game.q1_away }
    case 2: return { home: game.q2_home - game.q1_home, away: game.q2_away - game.q1_away }
    case 3: return { home: game.q3_home - game.q2_home, away: game.q3_away - game.q2_away }
    case 4: return { home: game.q4_home - game.q3_home, away: game.q4_away - game.q3_away }
    default: return null
  }
}

function parseTeam(sel, game) {
  const s = sel.toLowerCase()
  if (/\bhome\b/.test(s)) return 'home'
  if (/\baway\b/.test(s)) return 'away'
  if (/\bdraw\b|\btie\b/.test(s)) return 'draw'
  const home = game.home.toLowerCase()
  const away = game.away.toLowerCase()
  if (home.includes(s) || s.includes(home)) return 'home'
  if (away.includes(s) || s.includes(away)) return 'away'
  return null
}

export function resolve(game, leg) {
  if (!game || game.status !== 'final') {
    return { outcome: 'pending', reasoning: `Game not final (${game?.status || 'unknown'})` }
  }

  const combined = `${leg.description || ''} ${leg.selection || ''}`.toLowerCase()
  const q = parseQuarter(combined)
  if (!q) {
    return { outcome: 'needs_review', reasoning: `Cannot identify quarter from "${leg.description} / ${leg.selection}"` }
  }

  const scores = quarterScores(game, q)
  if (!scores || scores.home == null || scores.away == null) {
    return { outcome: 'needs_review', reasoning: `Q${q} scores not available for this game` }
  }

  // Determine actual Q winner
  let actual
  if (scores.home > scores.away) actual = 'home'
  else if (scores.away > scores.home) actual = 'away'
  else actual = 'draw'

  const predicted = parseTeam(leg.selection || '', game)
  if (!predicted) {
    return { outcome: 'needs_review', reasoning: `Cannot parse team selection "${leg.selection}"` }
  }

  const won = actual === predicted

  return {
    outcome: won ? 'won' : 'lost',
    reasoning: `Q${q}: ${game.home} ${scores.home}–${scores.away} ${game.away} (winner: ${actual}, needed: ${predicted})`,
  }
}
