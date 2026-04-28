// Margin resolver — covers three AFL margin market formats:
//   Big Win / Little Win  e.g. "Collingwood Big Win" (40+) / "Collingwood Little Win" (1-39)
//   Bucket range          e.g. "Collingwood 1-39", "Richmond by 10-19"
//   Open-ended            e.g. "Collingwood 40+"

function teamMatch(name, teamName) {
  const n = name.toLowerCase().trim()
  const t = teamName.toLowerCase().trim()
  return n.includes(t) || t.includes(n)
}

function parseMargin(leg) {
  const sel = (leg.selection || '').trim()

  // Big Win / Little Win
  const bwlw = sel.match(/^(.+?)\s+(big\s*win|little\s*win)/i)
  if (bwlw) {
    return {
      team: bwlw[1].trim(),
      type: /big/i.test(bwlw[2]) ? 'big_win' : 'little_win',
    }
  }

  // Range bucket: "TeamName 1-39" / "TeamName by 10-19" / "TeamName 1 to 39"
  // Handles hyphen, en-dash, and "to"
  const bucket = sel.match(/^(.+?)\s+(?:by\s+)?(\d+)\s*(?:[-\u2013]|to)\s*(\d+)/i)
  if (bucket) {
    return {
      team: bucket[1].trim(),
      type: 'bucket',
      low: parseInt(bucket[2]),
      high: parseInt(bucket[3]),
    }
  }

  // Open-ended: "TeamName 40+"
  const plus = sel.match(/^(.+?)\s+(?:by\s+)?(\d+)\+/i)
  if (plus) {
    return {
      team: plus[1].trim(),
      type: 'bucket',
      low: parseInt(plus[2]),
      high: Infinity,
    }
  }

  return null
}

export function resolve(game, leg) {
  if (!game || game.home_score == null || game.away_score == null) {
    return { outcome: 'pending', reasoning: 'Score not available' }
  }
  if (game.status !== 'final') {
    return { outcome: 'pending', reasoning: `Game not final (${game.status})` }
  }

  const parsed = parseMargin(leg)
  if (!parsed) {
    return { outcome: 'needs_review', reasoning: `Cannot parse margin from "${leg.selection}"` }
  }

  const rawMargin = game.home_score - game.away_score
  if (rawMargin === 0) return { outcome: 'void', reasoning: 'Draw' }

  const winMargin = Math.abs(rawMargin)
  const scoreStr = `${game.home} ${game.home_score} - ${game.away_score} ${game.away} (margin ${winMargin})`

  const pickedHome = teamMatch(parsed.team, game.home)
  const pickedAway = teamMatch(parsed.team, game.away)

  if (!pickedHome && !pickedAway) {
    return { outcome: 'needs_review', reasoning: `Cannot match "${parsed.team}" to ${game.home} or ${game.away}` }
  }

  const pickedWon = pickedHome ? rawMargin > 0 : rawMargin < 0

  if (parsed.type === 'big_win') {
    return {
      outcome: pickedWon && winMargin >= 40 ? 'won' : 'lost',
      reasoning: scoreStr,
    }
  }

  if (parsed.type === 'little_win') {
    return {
      outcome: pickedWon && winMargin <= 39 ? 'won' : 'lost',
      reasoning: scoreStr,
    }
  }

  if (parsed.type === 'bucket') {
    const inRange = pickedWon && winMargin >= parsed.low && winMargin <= parsed.high
    return { outcome: inRange ? 'won' : 'lost', reasoning: scoreStr }
  }

  return { outcome: 'needs_review', reasoning: 'Unknown margin type' }
}
