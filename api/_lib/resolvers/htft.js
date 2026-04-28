// Half-time / full-time double resolver (AFL + NRL)
// Bet selection is typically "Home/Home", "Away/Home", "Draw/Away", etc.
// First token = HT leader, second token = FT winner.
//
// resolve(game, leg) → { outcome, reasoning }

function leader(homeScore, awayScore) {
  if (homeScore == null || awayScore == null) return null
  if (homeScore > awayScore) return 'home'
  if (awayScore > homeScore) return 'away'
  return 'draw'
}

// Parse "Home/Home", "Away/Draw", team-name variants, etc.
function parseSelection(leg, game) {
  const sel = (leg.selection || '').trim()

  // Try canonical "X/Y" format first
  const slash = sel.match(/^(.+?)\s*\/\s*(.+)$/)
  if (!slash) return null

  const [, rawHt, rawFt] = slash
  const ht = tokenise(rawHt, game)
  const ft = tokenise(rawFt, game)
  if (!ht || !ft) return null
  return { ht, ft }
}

function tokenise(raw, game) {
  const s = raw.trim().toLowerCase()
  if (/^home$/i.test(s)) return 'home'
  if (/^away$/i.test(s)) return 'away'
  if (/^draw$|^tie$/i.test(s)) return 'draw'

  // Team name variants — match to home or away
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

  if (game.ht_home == null || game.ht_away == null) {
    return { outcome: 'needs_review', reasoning: 'Half-time scores not available for this game' }
  }

  const parsed = parseSelection(leg, game)
  if (!parsed) {
    return { outcome: 'needs_review', reasoning: `Cannot parse HT/FT selection "${leg.selection}"` }
  }

  const actualHt = leader(game.ht_home, game.ht_away)
  const actualFt = leader(game.home_score, game.away_score)

  if (!actualHt || !actualFt) {
    return { outcome: 'needs_review', reasoning: 'Could not determine HT or FT leader from scores' }
  }

  const htOk = actualHt === parsed.ht
  const ftOk = actualFt === parsed.ft
  const won = htOk && ftOk

  const htDesc = `HT: ${game.home} ${game.ht_home}–${game.ht_away} ${game.away} (${actualHt})`
  const ftDesc = `FT: ${game.home} ${game.home_score}–${game.away_score} ${game.away} (${actualFt})`

  return {
    outcome: won ? 'won' : 'lost',
    reasoning: `Needed ${parsed.ht}/${parsed.ft}. ${htDesc}. ${ftDesc}.`,
  }
}
