export const SPORTS = [
  'AFL',
  'NRL',
  'Cricket',
  'Horse Racing',
  'Greyhounds',
  'Tennis',
  'Soccer',
  'NBA',
  'NFL',
  'Boxing',
  'MMA',
  'Rugby Union',
  'Golf',
  'Multi',
  'Other',
]

// For individual legs — same list minus 'Multi'
export const LEG_SPORTS = SPORTS.filter((s) => s !== 'Multi')

// Parse a stored event_time string ("YYYY-MM-DDTHH:MM" AEST) → UTC Date
// Handles both AEST (UTC+10) and AEDT (UTC+11) automatically
export function eventTimeToDate(timeStr) {
  if (!timeStr) return null
  const s = timeStr.substring(0, 16) // ensure "YYYY-MM-DDTHH:MM"
  // Start with AEST assumption
  const aestDate = new Date(s + ':00+10:00')
  if (isNaN(aestDate)) return null
  // Check if Sydney is in AEDT at this date
  const tzLabel = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    timeZoneName: 'short',
  }).format(aestDate)
  return tzLabel.includes('AEDT') ? new Date(s + ':00+11:00') : aestDate
}

// Format event_time for display: "Sat 11 Apr, 3:15 PM"
export function formatEventTime(timeStr) {
  if (!timeStr) return ''
  const d = eventTimeToDate(timeStr)
  if (!d || isNaN(d)) return ''
  return d.toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

// Gross return when a bet wins (what lands in your account)
export const calcWinnings = (bet) => {
  if (bet.outcome !== 'won') return 0
  // intend_to_rollover: winnings go straight back out as the rollover stake — don't count twice
  if (bet.intend_to_rollover) return 0
  const stake = parseFloat(bet.stake)
  const odds = parseFloat(bet.odds)
  // Bonus bets: stake not returned, so you only receive stake × (odds - 1)
  return bet.is_bonus_bet ? stake * (odds - 1) : stake * odds
}

export const calcProfitLoss = (bet) => {
  const stake = parseFloat(bet.stake)
  const odds = parseFloat(bet.odds)
  if (bet.outcome === 'won') return stake * (odds - 1)
  if (bet.outcome === 'lost') {
    // Bonus bets only: free stake, so losing = $0 impact
    // Rollover bets carry full P&L so the net across the chain is accurate
    return bet.is_bonus_bet ? 0 : -stake
  }
  // void and pending: $0
  return 0
}

// Whether a bet's stake counts as real capital risked
// Rollover stakes excluded (funded from prior winnings, not new money)
// Bonus stakes excluded (free bets from the bookmaker)
export const isRealStake = (bet) => !bet.is_bonus_bet && !bet.is_rollover

export const formatCurrency = (amount) => {
  const abs = Math.abs(amount).toFixed(2)
  if (amount > 0) return `+$${abs}`
  if (amount < 0) return `-$${abs}`
  return `$${abs}`
}

export const profitLossColor = (amount) => {
  if (amount > 0) return 'text-green-400'
  if (amount < 0) return 'text-red-400'
  return 'text-slate-400'
}

export const outcomeBadge = (outcome) => {
  switch (outcome) {
    case 'won':
      return 'bg-green-500/20 text-green-400 border-green-500/30'
    case 'lost':
      return 'bg-red-500/20 text-red-400 border-red-500/30'
    case 'void':
      return 'bg-slate-500/20 text-slate-400 border-slate-500/30'
    default:
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  }
}

// Returns the latest event_time across a bet and all its legs (as ms timestamp)
// Used to sort bets by when they are likely to be resolved
export function betLastEventTime(bet) {
  const times = []
  if (bet.event_time) times.push(new Date(bet.event_time).getTime())
  for (const leg of (bet.bet_legs || [])) {
    if (leg.event_time) times.push(new Date(leg.event_time).getTime())
  }
  return times.length > 0 ? Math.max(...times) : null
}

// Sort bets: pending first (latest event time at top), then resolved by date desc
export function sortBetsByActivity(bets) {
  return [...bets].sort((a, b) => {
    const aPending = a.outcome === 'pending'
    const bPending = b.outcome === 'pending'

    // Resolved bets go below pending
    if (aPending && !bPending) return -1
    if (!aPending && bPending) return 1

    const aTime = betLastEventTime(a)
    const bTime = betLastEventTime(b)

    if (aPending) {
      // Both pending: furthest event time at top (DESC)
      if (aTime && bTime) return bTime - aTime
      if (aTime) return -1  // a has time, b doesn't → a goes first
      if (bTime) return 1
      // Neither has event time: most recently created first
      return b.created_at.localeCompare(a.created_at)
    } else {
      // Both resolved: most recent date first
      return b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)
    }
  })
}

/**
 * Evaluate whether a bet return was earned based on the terms text and bet outcome.
 * Returns true (earned), false (not earned), or null (needs manual review / online check).
 */
export function evaluateBetReturn(betReturnText, outcome, legs = []) {
  if (!betReturnText || !outcome || outcome === 'pending') return null
  const text = betReturnText.toLowerCase()
  const lostLegs = legs.filter(l => l.outcome === 'lost').length

  // Racing placement: "runs 2nd or 3rd", "runs second or third" → needs online check
  if (/runs? (2nd|second|3rd|third)|place(?:s|d)?/.test(text)) return null

  // "if 1 leg fails" / "if one leg fails" / "1 leg fails"
  if (/\b1 leg fail|\bone leg fail/.test(text)) return lostLegs === 1

  // "if 2 legs fail"
  if (/\b2 legs? fail/.test(text)) return lostLegs === 2

  // "if any leg fails" / "if ANY leg" / "any legs of your ... fail"
  if (/any legs? (of your .+)?fail|if any leg|any leg.*fail/.test(text)) return outcome === 'lost'

  // Simple loss: "if it loses", "if this bet loses", "if your selection loses", "if your multi loses"
  if (/if (it|this bet|your (selection|multi|bet)) loses?/.test(text)) return outcome === 'lost'

  // Bet loses / multi loses (without "if" prefix)
  if (/\b(bet|multi|selection) loses?/.test(text)) return outcome === 'lost'

  // Unknown terms → needs manual review
  return null
}
