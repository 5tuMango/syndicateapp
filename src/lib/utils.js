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

export const calcProfitLoss = (bet) => {
  if (bet.outcome === 'won') return parseFloat(bet.stake) * (parseFloat(bet.odds) - 1)
  if (bet.outcome === 'lost') return -parseFloat(bet.stake)
  // void and pending both return 0 — stake is returned on void, not yet known on pending
  return 0
}

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
