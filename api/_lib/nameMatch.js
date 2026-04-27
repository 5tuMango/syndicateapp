// Player name matching — used by resolvers to find a player in sport_player_stats rows.
//
// Strategy (in order, stops at first definitive result):
//   1. Exact match on player_name_normalised
//   2. Last-name only (unique within the player list)
//   3. Initial + last-name  e.g. "C. Petracca" → first token is single char
//   4. Levenshtein distance ≤ 2 on full normalised name (OCR typo tolerance)
//   5. Ambiguous at any step → needs_review (never silently guess)
//
// Returns:
//   { result: 'match', player }          — confident single match
//   { result: 'no_match' }               — nothing found
//   { result: 'needs_review', candidates }  — multiple plausible matches

export function normalise(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

// players: array of sport_player_stats rows (must have player_name_normalised)
export function matchPlayer(query, players) {
  if (!query || !players || players.length === 0) return { result: 'no_match' }

  const q = normalise(query)

  // 1. Exact match
  const exact = players.filter(p => p.player_name_normalised === q)
  if (exact.length === 1) return { result: 'match', player: exact[0] }
  if (exact.length > 1) return { result: 'needs_review', candidates: exact }

  const qTokens = q.split(' ')
  const qLast = qTokens[qTokens.length - 1]

  // 2. Last-name only
  const byLast = players.filter(p => {
    const tokens = p.player_name_normalised.split(' ')
    return tokens[tokens.length - 1] === qLast
  })
  if (byLast.length === 1) return { result: 'match', player: byLast[0] }
  if (byLast.length > 1) {
    // Narrow further before giving up — fall through to initial check
    // but if that also fails, this set becomes the candidates
  }

  // 3. Initial + last-name  e.g. q = "c petracca" (2 tokens, first is 1 char)
  if (qTokens.length === 2 && qTokens[0].length === 1) {
    const initial = qTokens[0]
    const last = qTokens[1]
    const byInitial = players.filter(p => {
      const tokens = p.player_name_normalised.split(' ')
      return (
        tokens[tokens.length - 1] === last &&
        tokens[0].startsWith(initial)
      )
    })
    if (byInitial.length === 1) return { result: 'match', player: byInitial[0] }
    if (byInitial.length > 1) return { result: 'needs_review', candidates: byInitial }
  }

  // Return needs_review from last-name step if we had multiple there
  if (byLast.length > 1) return { result: 'needs_review', candidates: byLast }

  // 4. Levenshtein ≤ 2 on full normalised name
  const fuzzy = players
    .map(p => ({ player: p, dist: levenshtein(q, p.player_name_normalised) }))
    .filter(x => x.dist <= 2)
    .sort((a, b) => a.dist - b.dist)

  if (fuzzy.length === 0) return { result: 'no_match' }
  if (fuzzy.length === 1) return { result: 'match', player: fuzzy[0].player }

  // Multiple fuzzy matches at the same distance → needs_review
  const best = fuzzy[0].dist
  const tied = fuzzy.filter(x => x.dist === best)
  if (tied.length === 1) return { result: 'match', player: tied[0].player }
  return { result: 'needs_review', candidates: tied.map(x => x.player) }
}
