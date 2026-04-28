// Go-Again credit logic.
// Each winning bet of $250+ by an active-team member earns the punter
// another $50 stake. Credits roll forward indefinitely until consumed
// by stakes in a future active week.

const GO_AGAIN_TRIGGER = 250 // gross winnings (stake × odds) needed to earn a credit
const BASE_ALLOWANCE = 50    // dollars per active-team punter per active week
const CREDIT_VALUE = 50      // dollars added per credit

// Convert any ISO timestamp to the YYYY-MM-DD of the Monday of its AEST week.
// Treats AEST as a fixed UTC+10 offset (matches the rest of the app — see CLAUDE.md).
export function aestMondayKey(isoTs) {
  if (!isoTs) return null
  const d = new Date(isoTs)
  if (isNaN(d.getTime())) return null
  const aest = new Date(d.getTime() + 10 * 3600 * 1000)
  const dow = aest.getUTCDay() // 0=Sun, 1=Mon, ...
  const back = dow === 0 ? 6 : dow - 1
  aest.setUTCHours(0, 0, 0, 0)
  aest.setUTCDate(aest.getUTCDate() - back)
  return aest.toISOString().slice(0, 10)
}

// Today's Monday-AEST key.
export function currentAestMondayKey() {
  return aestMondayKey(new Date().toISOString())
}

// Build a map of week_start (YYYY-MM-DD) → active team_id, derived from the
// chronological ordering of weekly_multis. Each multi marks one active week;
// team rotation uses the same modulo logic as Dashboard.thisWeekendTeam.
export function buildWeekToTeamMap(weeklyMultis, teams) {
  const map = new Map()
  if (!Array.isArray(teams) || teams.length < 2) return map
  const sorted = [...(weeklyMultis || [])].sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || '')
  )
  sorted.forEach((m, i) => {
    const wk = aestMondayKey(m.created_at)
    if (!wk) return
    // Keep the rotation aligned with Dashboard.thisWeekendTeam:
    //   upcomingWeekNum = completedWeeks + 1; team = teams[upcomingWeekNum % 2]
    // For a multi that was the Nth created (1-based), its active week's team:
    const weekNum = i + 1
    map.set(wk, teams[weekNum % 2]?.id ?? null)
  })
  return map
}

// Return the team_id active for the calendar week containing the given timestamp.
// Falls back to the team active for the most recent week ≤ that timestamp's week.
export function activeTeamIdForWeek(weekStart, weekToTeam) {
  if (!weekStart || !weekToTeam || weekToTeam.size === 0) return null
  if (weekToTeam.has(weekStart)) return weekToTeam.get(weekStart)
  let bestKey = null
  for (const k of weekToTeam.keys()) {
    if (k <= weekStart && (bestKey === null || k > bestKey)) bestKey = k
  }
  return bestKey ? weekToTeam.get(bestKey) : null
}

// Find every persona-bet pair that should have a Go-Again credit.
// Returns array of { persona_id, source_bet_id, source_winnings } for bets that
// (a) won, (b) had gross winnings ≥ $250, (c) were placed during a week when
// the punter's team was active.
export function detectQualifyingBets(bets, personas, weekToTeam) {
  const out = []
  if (!Array.isArray(bets) || !Array.isArray(personas)) return out

  // Quick lookup: claimed_by user_id → persona; persona_id → persona
  const personaByUserId = {}
  const personaById = {}
  for (const p of personas) {
    if (p.claimed_by) personaByUserId[p.claimed_by] = p
    personaById[p.id] = p
  }

  for (const bet of bets) {
    if (bet.outcome !== 'won') continue
    const stake = parseFloat(bet.stake || 0)
    const odds = parseFloat(bet.odds || 0)
    if (!stake || !odds) continue
    const winnings = stake * odds
    if (winnings < GO_AGAIN_TRIGGER) continue

    const persona = (bet.persona_id && personaById[bet.persona_id]) || personaByUserId[bet.user_id]
    if (!persona || !persona.team_id) continue

    const wk = aestMondayKey(bet.created_at || bet.date)
    const activeTeamId = activeTeamIdForWeek(wk, weekToTeam)
    if (!activeTeamId) continue
    if (activeTeamId !== persona.team_id) continue // bet wasn't during their team's active week

    out.push({
      persona_id: persona.id,
      source_bet_id: bet.id,
      source_winnings: Math.round(winnings * 100) / 100,
    })
  }
  return out
}

// For a single persona this active week: how much have they staked?
export function stakeThisWeekForPersona(bets, persona, weekStart) {
  if (!persona || !weekStart) return 0
  return bets
    .filter((b) => {
      if (b.outcome === 'void') return false
      if (b.is_bonus_bet) return false // bonus bets don't draw from allowance
      const matchesPersona = (b.persona_id && b.persona_id === persona.id) ||
        (!b.persona_id && persona.claimed_by && b.user_id === persona.claimed_by)
      if (!matchesPersona) return false
      return aestMondayKey(b.created_at || b.date) === weekStart
    })
    .reduce((sum, b) => sum + parseFloat(b.stake || 0), 0)
}

// How many credits should be marked as consumed given a punter's current stake total?
// Each $50 over the base allowance consumes one credit.
export function creditsConsumedByStake(staked) {
  if (staked <= BASE_ALLOWANCE) return 0
  return Math.ceil((staked - BASE_ALLOWANCE) / CREDIT_VALUE)
}

export const constants = { GO_AGAIN_TRIGGER, BASE_ALLOWANCE, CREDIT_VALUE }
