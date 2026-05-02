// Maps a bet leg to a resolver key based on description + selection text.
// Returns a string key or null if the market is unrecognised or not yet supported.
//
// Keys: 'h2h' | 'handicap' | 'total' | 'margin' | 'goalScorer' | 'tryScorer' | 'playerStat'

export function classifyMarket(leg) {
  const desc = (leg.description || '').toLowerCase()
  const sel = (leg.selection || '').toLowerCase()
  const combined = `${desc} ${sel}`

  if (/\bhead.to.head\b|\bh2h\b|\bmatch winner\b|\bto win\b/.test(combined)) return 'h2h'
  // "handicap", "line bet", "pick your own line", bare "line" description, or selection has (+/-N.N)
  if (/\bhandicap\b|\bline bet\b|\bpick.{0,15}line\b/.test(combined) || /\([+-]\d+\.?\d*\)/.test(combined)) return 'handicap'
  if (/\bbig win\b|\blittle win\b|\bwinning margin\b|\bmargin\b/.test(combined)) return 'margin'
  if (/\bhalf.?time.{0,10}full.?time\b|\bht\/ft\b|\bhtft\b/.test(combined)) return 'htft'
  if (/\bquarter\b|\bq[1-4]\b|\b[1-4](st|nd|rd|th) quarter\b/.test(combined)) return 'quarterWinner'

  // Player props — checked before total so "over/under" in player stat markets
  // (e.g. "Joel Freijah Under (20.5)") don't get misclassified as game totals.
  if (/\bgoal.?scorer\b|\banytime goal\b|\bfirst goal\b|\bplayer goals?\b|\b\d\+?\s*goals?\b/.test(combined)) return 'goalScorer'
  if (/\btry.?scorer\b|\banytime try\b|\bfirst try\b|\bplayer tr(y|ies)\b|\b\d\+?\s*tr(y|ies)\b/.test(combined)) return 'tryScorer'

  if (/\bdisposals?\b|\bkicks?\b|\bhandballs?\b|\bmarks?\b|\btackles?\b|\bhitouts?\b|\bclearances?\b|\binside 50\b|\bcontested\b|\bfantasy\b/.test(combined)) return 'playerStat'
  if (/\bruns?\b|\brun metres\b|\bline breaks?\b|\btry assists?\b|\boffloads?\b/.test(combined)) return 'playerStat'

  // Game totals — "over/under" only reaches here if no player stat keyword matched above
  if (/\btotal points\b|\btotal runs\b|\bover\b|\bunder\b/.test(combined)) return 'total'

  return null
}
