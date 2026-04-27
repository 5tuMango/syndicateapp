// Maps a bet leg to a resolver key based on description + selection text.
// Returns a string key or null if the market is unrecognised or not yet supported.
//
// Keys: 'h2h' | 'handicap' | 'total' | 'margin' | 'goalScorer' | 'tryScorer' | 'playerStat'

export function classifyMarket(leg) {
  const desc = (leg.description || '').toLowerCase()
  const sel = (leg.selection || '').toLowerCase()
  const combined = `${desc} ${sel}`

  if (/\bhead.to.head\b|\bh2h\b|\bmatch winner\b|\bto win\b/.test(combined)) return 'h2h'
  if (/\bhandicap\b|\bline bet\b/.test(combined)) return 'handicap'
  if (/\btotal points\b|\btotal runs\b|\bover\b|\bunder\b/.test(combined)) return 'total'
  if (/\bbig win\b|\blittle win\b|\bwinning margin\b|\bmargin\b/.test(combined)) return 'margin'

  // Player props — goal/try scorers checked before generic playerStat
  if (/\bgoal.?scorer\b|\banytime goal\b|\bfirst goal\b/.test(combined)) return 'goalScorer'
  if (/\btry.?scorer\b|\banytime try\b|\bfirst try\b/.test(combined)) return 'tryScorer'

  if (/\bdisposals?\b|\bkicks?\b|\bhandballs?\b|\bmarks?\b|\btackles?\b|\bhitouts?\b|\bclearances?\b|\binside 50\b|\bcontested\b|\bfantasy\b/.test(combined)) return 'playerStat'
  if (/\bruns?\b|\brun metres\b|\bline breaks?\b|\btry assists?\b|\boffloads?\b/.test(combined)) return 'playerStat'

  return null
}
