import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import BetCard from '../components/BetCard'
import WeeklyMultiCard from '../components/WeeklyMultiCard'
import FilterBar from '../components/FilterBar'
import ActiveTeamStrip from '../components/ActiveTeamStrip'
import { calcProfitLoss, calcWinnings, formatCurrency, profitLossColor, sortBetsByActivity, betLastEventTime, isRealStake } from '../lib/utils'
import { usePersonas } from '../hooks/usePersonas'
import {
  buildWeekToTeamMap,
  detectQualifyingBets,
  stakeThisWeekForPersona,
  creditsConsumedByStake,
  currentAestMondayKey,
  aestMondayKey,
} from '../lib/goAgain'

function calcWeeklyStats(multis) {
  const results = multis.map((m) => {
    const legs = m.weekly_multi_legs || []
    const nonVoid = legs.filter((l) => l.outcome !== 'void')
    const validLegs = legs.filter((l) => l.odds != null && parseFloat(l.odds) > 0)
    const combo = validLegs.reduce((acc, l) => acc * parseFloat(l.odds), 1)
    const stake = parseFloat(m.stake || 0)
    let outcome
    if (nonVoid.length === 0 || nonVoid.some((l) => l.outcome === 'pending')) outcome = 'pending'
    else if (nonVoid.some((l) => l.outcome === 'lost')) outcome = 'lost'
    else outcome = 'won'
    const winnings = outcome === 'won' ? stake * combo : 0
    const pl = outcome === 'won' ? winnings - stake : outcome === 'lost' ? -stake : 0
    return { outcome, winnings, pl, combo, stake }
  })
  const resolved = results.filter((r) => r.outcome === 'won' || r.outcome === 'lost')
  const won = results.filter((r) => r.outcome === 'won').length
  const winnings = results.reduce((sum, r) => sum + r.winnings, 0)
  const pl = results.reduce((sum, r) => sum + r.pl, 0)
  const staked = results.reduce((sum, r) => sum + r.stake, 0)
  const sumStakeOdds = results.reduce((sum, r) => sum + r.stake * r.combo, 0)
  const avgOdds = staked > 0 ? sumStakeOdds / staked : 0
  return {
    total: multis.length,
    won,
    winnings,
    pl,
    staked,
    winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0,
    avgOdds,
  }
}

export default function Dashboard() {
  const { byUserId: personaMap, byPersonaId, list: personaList } = usePersonas()
  const [bets, setBets] = useState([])
  const [members, setMembers] = useState([])
  const [weeklyMultis, setWeeklyMultis] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({})
  const [unattributedFunds, setUnattributedFunds] = useState(0)
  const [teams, setTeams] = useState([])
  const [goAgainCredits, setGoAgainCredits] = useState([])
  const [dashTab, setDashTab] = useState('active') // 'active' | 'archive'
  const reconciledKeyRef = useRef(null) // prevents repeated reconciliation against the same data snapshot

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const [betsRes, membersRes, weeklyRes, kittyRes, teamsRes, creditsRes] = await Promise.all([
      supabase
        .from('bets')
        .select('*, profiles(id, username, full_name), bet_legs(*)')
        .order('date', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('profiles').select('id, username, full_name').order('full_name'),
      supabase.from('weekly_multis').select('*, weekly_multi_legs(*, profiles(id, full_name, username))'),
      supabase.from('kitty_settings').select('unattributed_funds').eq('id', 1).maybeSingle(),
      supabase.from('teams').select('*').order('created_at'),
      supabase.from('go_again_credits').select('*').order('earned_at'),
    ])
    setBets(betsRes.data || [])
    setMembers(membersRes.data || [])
    setWeeklyMultis(weeklyRes.data || [])
    setUnattributedFunds(parseFloat(kittyRes.data?.unattributed_funds || 0))
    setTeams(teamsRes.data || [])
    setGoAgainCredits(creditsRes.data || [])
    setLoading(false)
  }

  const filteredBets = useMemo(() => {
    return bets.filter((bet) => {
      if (filters.sport && bet.sport !== filters.sport) return false
      if (filters.bet_type && bet.bet_type !== filters.bet_type) return false
      if (filters.outcome && bet.outcome !== filters.outcome) return false
      if (filters.member && bet.user_id !== filters.member) return false
      if (filters.date_from && bet.date < filters.date_from) return false
      if (filters.date_to && bet.date > filters.date_to) return false
      return true
    })
  }, [bets, filters])

  const individStats = useMemo(() => {
    const resolved = filteredBets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void')
    const won = filteredBets.filter((b) => b.outcome === 'won').length
    const pl = filteredBets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const staked = filteredBets.filter((b) => b.outcome !== 'void' && isRealStake(b)).reduce((sum, b) => sum + parseFloat(b.stake), 0)
    const winnings = filteredBets.filter((b) => b.outcome === 'won').reduce((sum, b) => sum + calcWinnings(b), 0)
    const nonVoid = filteredBets.filter((b) => b.outcome !== 'void')
    const sumStakeOdds = nonVoid.reduce((sum, b) => sum + parseFloat(b.stake) * parseFloat(b.odds), 0)
    const avgOdds = staked > 0 ? sumStakeOdds / staked : 0
    return {
      total: filteredBets.length,
      winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0,
      pl, staked, winnings, avgOdds,
    }
  }, [filteredBets])

  const weeklyStats = useMemo(() => calcWeeklyStats(weeklyMultis), [weeklyMultis])

  const thisWeekendTeam = useMemo(() => {
    if (teams.length < 2) return null
    const completedWeeks = weeklyMultis.filter((m) => {
      const nonVoid = (m.weekly_multi_legs || []).filter((l) => l.outcome !== 'void')
      return nonVoid.length > 0 && nonVoid.every((l) => l.outcome === 'won' || l.outcome === 'lost')
    }).length
    const upcomingWeekNum = completedWeeks + 1
    return { team: teams[upcomingWeekNum % 2], weekNum: upcomingWeekNum }
  }, [teams, weeklyMultis])

  // ── Go-Again credit detection + usage marking ────────────────────────────
  // Runs once per fetched data snapshot. Inserts credits for any newly-qualifying
  // winning bet (≥ $250 winnings during the punter's active week) and marks
  // existing credits used when the persona's current-week stake total exceeds
  // their base $50 allowance (each $50 over = 1 credit consumed, FIFO).
  useEffect(() => {
    if (loading) return
    if (!teams.length || !personaList.length) return
    const snapshotKey = `${bets.length}|${weeklyMultis.length}|${goAgainCredits.length}|${personaList.length}`
    if (reconciledKeyRef.current === snapshotKey) return
    reconciledKeyRef.current = snapshotKey

    const weekToTeam = buildWeekToTeamMap(weeklyMultis, teams)
    let needsRefetch = false

    ;(async () => {
      // 1. Insert credits for qualifying bets that don't already have one.
      const existingBetIds = new Set(goAgainCredits.map((c) => c.source_bet_id))
      const qualifying = detectQualifyingBets(bets, personaList, weekToTeam)
        .filter((q) => !existingBetIds.has(q.source_bet_id))

      if (qualifying.length > 0) {
        const { error } = await supabase
          .from('go_again_credits')
          .upsert(qualifying, { onConflict: 'source_bet_id', ignoreDuplicates: true })
        if (!error) needsRefetch = true
        else console.warn('go_again_credits insert failed:', error.message)
      }

      // 2. Mark credits as used based on current-week stake totals.
      const currentWeek = currentAestMondayKey()
      const updates = []
      // We need a fresh view of credits if we just inserted; use union of state + new.
      const allCredits = [
        ...goAgainCredits,
        ...qualifying.map((q) => ({ ...q, used_at: null, used_in_week_start: null })),
      ]
      const byPersona = new Map()
      for (const c of allCredits) {
        if (!byPersona.has(c.persona_id)) byPersona.set(c.persona_id, [])
        byPersona.get(c.persona_id).push(c)
      }

      for (const [personaId, credits] of byPersona.entries()) {
        const persona = personaList.find((p) => p.id === personaId)
        if (!persona) continue
        const staked = stakeThisWeekForPersona(bets, persona, currentWeek)
        const shouldBeConsumed = creditsConsumedByStake(staked)
        const sortedCredits = [...credits].sort((a, b) =>
          (a.earned_at || '').localeCompare(b.earned_at || '')
        )
        const currentlyUsedIds = new Set(sortedCredits.filter((c) => c.used_at).map((c) => c.id))
        const unused = sortedCredits.filter((c) => !c.used_at)
        const toConsume = Math.max(0, shouldBeConsumed - currentlyUsedIds.size)

        for (let i = 0; i < toConsume && i < unused.length; i++) {
          const c = unused[i]
          if (!c.id) continue // not yet persisted (just-inserted credit, will reconcile next pass)
          updates.push({
            id: c.id,
            used_at: new Date().toISOString(),
            used_in_week_start: currentWeek,
          })
        }
      }

      if (updates.length > 0) {
        await Promise.all(updates.map((u) =>
          supabase
            .from('go_again_credits')
            .update({ used_at: u.used_at, used_in_week_start: u.used_in_week_start })
            .eq('id', u.id)
        ))
        needsRefetch = true
      }

      if (needsRefetch) {
        const { data } = await supabase.from('go_again_credits').select('*').order('earned_at')
        setGoAgainCredits(data || [])
        // Allow another reconciliation pass on the new credits set
        reconciledKeyRef.current = null
      }
    })()
  }, [loading, bets, weeklyMultis, teams, personaList, goAgainCredits])

  // Per-persona allocation (mirrors Leaderboard.rotationStats.memberAllocations).
  // expected = teamActiveWeeks × $50 + Go-Again credits earned × $50
  // actual   = total real-stake non-void stakes ever placed by this persona
  // remaining = max(0, expected − actual) — captures BOTH unused Go-Again
  // credits AND missed base allocations (e.g. an active-week the punter
  // didn't bet their $50). Single source of truth for "what's outstanding".
  const memberAllocations = useMemo(() => {
    if (teams.length < 2) return new Map()
    const ALLOCATION_PER_WEEKEND = 50

    const sortedMultis = [...weeklyMultis].sort((a, b) =>
      (a.created_at || '').localeCompare(b.created_at || '')
    )
    const totalMultis = sortedMultis.length
    const teamActiveWeeks = {}
    for (const t of teams) teamActiveWeeks[t.id] = 0
    for (let i = 1; i <= totalMultis; i++) {
      const teamId = teams[i % 2]?.id
      if (teamId) teamActiveWeeks[teamId]++
    }
    // Tick the upcoming team up if today's Monday-AEST week has no multi yet
    const currentWeek = currentAestMondayKey()
    const lastMultiWeek = sortedMultis.length > 0
      ? aestMondayKey(sortedMultis[sortedMultis.length - 1].created_at)
      : null
    if (lastMultiWeek !== currentWeek) {
      const nextWeekNum = totalMultis + 1
      const nextActiveTeamId = teams[nextWeekNum % 2]?.id
      if (nextActiveTeamId) teamActiveWeeks[nextActiveTeamId]++
    }

    const map = new Map()
    for (const persona of personaList) {
      const teamWeeks = teamActiveWeeks[persona.team_id] || 0
      const creditCount = goAgainCredits.filter((c) => c.persona_id === persona.id).length
      const expected = (teamWeeks + creditCount) * ALLOCATION_PER_WEEKEND
      const actual = bets
        .filter((b) => {
          if (b.outcome === 'void' || !isRealStake(b)) return false
          if (b.persona_id) return b.persona_id === persona.id
          return persona.claimed_by && b.user_id === persona.claimed_by
        })
        .reduce((sum, b) => sum + parseFloat(b.stake || 0), 0)
      const remaining = Math.max(0, expected - actual)
      map.set(persona.id, { expected, actual, remaining })
    }
    return map
  }, [teams, weeklyMultis, personaList, bets, goAgainCredits])

  // Members of the team punting this week — chip shows their unused-credit
  // count as the +$X hint (still a useful "extra stake" cue on top of their
  // base $50 allowance for the week).
  const activeTeamMembers = useMemo(() => {
    if (!thisWeekendTeam?.team) return []
    const teamId = thisWeekendTeam.team.id
    const onTeam = personaList.filter((p) => p.team_id === teamId)
    return onTeam.map((persona) => {
      const personaCredits = goAgainCredits.filter((c) => c.persona_id === persona.id)
      const unusedCredits = personaCredits.filter((c) => !c.used_at).length
      return { persona, unusedCredits }
    })
  }, [thisWeekendTeam, personaList, goAgainCredits])

  // Off-team punters with outstanding allocation $ — covers both unused
  // Go-Again credits AND missed base allocations from prior active weeks.
  // Uses the same expected − actual formula as Leaderboard so the two pages
  // never disagree.
  const outstandingOtherTeamMembers = useMemo(() => {
    if (!thisWeekendTeam?.team) return []
    const activeTeamId = thisWeekendTeam.team.id
    const offTeam = personaList.filter((p) => p.team_id && p.team_id !== activeTeamId)
    return offTeam
      .map((persona) => {
        const alloc = memberAllocations.get(persona.id)
        return { persona, remaining: alloc?.remaining || 0 }
      })
      .filter((m) => m.remaining > 0)
  }, [thisWeekendTeam, personaList, memberAllocations])

  // Confirmed earned bet returns (terms evaluated to true)
  const availableBetReturns = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 21)
    return bets.filter((b) =>
      b.bet_return_earned === true &&
      b.bet_return_value > 0 &&
      !b.bet_return_claimed &&
      new Date(b.date) >= cutoff
    ).sort((a, b) => b.date.localeCompare(a.date))
  }, [bets])

  // Bet returns that need manual review (terms unknown — e.g. racing placement)
  const pendingBetReturnReview = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 21)
    return bets.filter((b) =>
      b.bet_return_earned == null &&
      b.bet_return_value > 0 &&
      !b.bet_return_claimed &&
      b.outcome !== 'pending' &&
      new Date(b.date) >= cutoff
    ).sort((a, b) => b.date.localeCompare(a.date))
  }, [bets])

  async function markBetReturnUsed(betId) {
    await supabase.from('bets').update({ bet_return_claimed: true }).eq('id', betId)
    setBets((prev) => prev.map((b) => b.id === betId ? { ...b, bet_return_claimed: true } : b))
  }

  async function confirmBetReturn(betId, earned) {
    await supabase.from('bets').update({ bet_return_earned: earned }).eq('id', betId)
    setBets((prev) => prev.map((b) => b.id === betId ? { ...b, bet_return_earned: earned } : b))
  }

  const combined = useMemo(() => ({
    winnings: individStats.winnings + weeklyStats.winnings,
    total: individStats.total + weeklyStats.total,
    staked: individStats.staked + weeklyStats.staked,
    pl: individStats.pl + weeklyStats.pl,
    winRate: (() => {
      const totalResolved = filteredBets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void').length
        + weeklyMultis.filter((m) => { const nv = (m.weekly_multi_legs||[]).filter(l=>l.outcome!=='void'); return nv.length > 0 && nv.every(l=>l.outcome==='won'||l.outcome==='lost') }).length
      const totalWon = filteredBets.filter((b) => b.outcome === 'won').length + weeklyStats.won
      return totalResolved ? Math.round((totalWon / totalResolved) * 100) : 0
    })(),
    avgOdds: (individStats.staked + weeklyStats.staked) > 0
      ? (individStats.avgOdds * individStats.staked + weeklyStats.avgOdds * weeklyStats.staked) / (individStats.staked + weeklyStats.staked)
      : 0,
  }), [individStats, weeklyStats, filteredBets, weeklyMultis])

  // Kitty: total contributions + settled P&L − pending stakes (committed, can't retrieve)
  const kitty = useMemo(() => {
    const contributions = personaList.reduce((s, p) => s + parseFloat(p.amount_paid || 0), 0)
    const penalties = personaList.reduce((s, p) => s + parseFloat(p.penalties_paid || 0), 0)
    const totalTarget = personaList.reduce((s, p) => s + parseFloat(p.contribution_target || 400), 0)
    const settledPL = bets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const pendingStakes = bets
      .filter(b => b.outcome === 'pending' && !b.is_bonus_bet)
      .reduce((sum, b) => sum + parseFloat(b.stake), 0)
    const pendingWeeklyStakes = weeklyMultis
      .filter(m => {
        const legs = m.weekly_multi_legs || []
        const nonVoid = legs.filter(l => l.outcome !== 'void')
        return nonVoid.length === 0 || nonVoid.some(l => l.outcome === 'pending')
      })
      .reduce((sum, m) => sum + parseFloat(m.stake || 0), 0)
    const totalPaidIn = contributions + penalties + unattributedFunds
    const balance = totalPaidIn + settledPL + weeklyStats.pl - pendingStakes - pendingWeeklyStakes
    const numPunters = personaList.length || 8
    // Still owed by all punters — this money will come in, so projected kitty is higher
    const stillOwedTotal = personaList.reduce((s, p) => s + Math.max(0, parseFloat(p.contribution_target || 400) - parseFloat(p.amount_paid || 0)), 0)
    const projectedKitty = balance + stillOwedTotal
    const payoutPerPunter = projectedKitty / numPunters
    return { contributions, penalties, unattributed: unattributedFunds, totalPaidIn, totalTarget, toPay: Math.max(0, totalTarget - contributions - unattributedFunds), balance, pendingStakes: pendingStakes + pendingWeeklyStakes, payoutPerPunter, projectedKitty }
  }, [personaList, bets, weeklyMultis, weeklyStats, unattributedFunds])

  const handleDelete = (id) => setBets((prev) => prev.filter((b) => b.id !== id))

  const handleUpdate = async (betId) => {
    const { data } = await supabase
      .from('bets')
      .select('*, profiles(id, username, full_name), bet_legs(*)')
      .eq('id', betId)
      .single()
    if (data) setBets((prev) => prev.map((b) => (b.id === betId ? data : b)))
  }

  const handleWeeklyUpdate = async () => {
    const { data } = await supabase.from('weekly_multis').select('*, weekly_multi_legs(*, profiles(id, full_name, username))')
    if (data) setWeeklyMultis(data)
  }

  // Categorise bets + weekly multis into dashboard sections
  const feedSections = useMemo(() => {
    const tenDaysAgo = new Date()
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10)
    const tenDaysAgoStr = tenDaysAgo.toISOString().slice(0, 10)

    // Pin the most recent live weekly multi that still has at least one pending leg.
    // It stays pinned at the very top until every leg has a final outcome.
    const pinnedWeekly = [...weeklyMultis]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .find(m => {
        if (!m.is_live) return false
        const legs = m.weekly_multi_legs || []
        return legs.some(l => !l.outcome || l.outcome === 'pending')
      }) || null

    const pinnedId = pinnedWeekly?.id || null

    const allItems = [
      ...filteredBets.map(b => {
        const legs = b.bet_legs || []
        const hasLostLeg = legs.some(l => l.outcome === 'lost')
        return { type: 'bet', key: b.id, data: b, outcome: b.outcome, lastTime: betLastEventTime(b), date: b.date, created_at: b.created_at, hasLostLeg }
      }),
      // Exclude the pinned weekly from normal sections — it renders separately at the top
      ...weeklyMultis.filter(m => m.id !== pinnedId).map(m => {
        const legs = m.weekly_multi_legs || []
        const nonVoid = legs.filter(l => l.outcome !== 'void' && l.outcome !== 'missed')
        const outcome = nonVoid.length === 0 ? 'pending'
          : nonVoid.every(l => l.outcome === 'won') ? 'won'
          : nonVoid.some(l => l.outcome === 'lost') ? 'lost'
          : 'pending'
        const hasLostLeg = legs.some(l => l.outcome === 'lost')
        const pendingLegTimes = legs
          .filter(l => l.outcome === 'pending' && l.event_time)
          .map(l => new Date(l.event_time).getTime())
          .filter(t => !isNaN(t))
        const lastTime = pendingLegTimes.length > 0 ? Math.max(...pendingLegTimes) : null
        return { type: 'weekly', key: m.id, data: m, outcome, lastTime, date: m.created_at?.slice(0, 10), created_at: m.created_at, hasLostLeg }
      }),
    ]

    const byDate = (a, b) => (b.date || '').localeCompare(a.date || '') || b.created_at.localeCompare(a.created_at)
    const byEventTime = (a, b) => {
      if (a.lastTime && b.lastTime) return a.lastTime - b.lastTime
      if (a.lastTime) return -1
      if (b.lastTime) return 1
      return b.created_at.localeCompare(a.created_at)
    }

    // Section 1: pending, no lost legs — still alive, sorted by soonest event first
    const alivePending = allItems.filter(i => i.outcome === 'pending' && !i.hasLostLeg).sort(byEventTime)
    // Section 2: pending, has a lost leg — effectively dead but legs still pending
    const deadPending = allItems.filter(i => i.outcome === 'pending' && i.hasLostLeg).sort(byDate)
    // Section 3: lost within 10 days
    const recentLoss = allItems.filter(i => i.outcome === 'lost' && (i.date || '') >= tenDaysAgoStr).sort(byDate)
    // Section 4: wins — held all year
    const wins = allItems.filter(i => i.outcome === 'won').sort(byDate)
    // Archive: lost 10+ days ago
    const archive = allItems.filter(i => i.outcome === 'lost' && (i.date || '') < tenDaysAgoStr).sort(byDate)

    return { pinnedWeekly, alivePending, deadPending, recentLoss, wins, archive }
  }, [filteredBets, weeklyMultis])

  // Mini-leaderboard for the kitty card right rail — top 8 by winnings.
  const kittyMiniLeaderboard = useMemo(() => {
    return personaList
      .map((p) => {
        const winnings = bets
          .filter((b) => {
            if (b.outcome !== 'won') return false
            if (b.persona_id) return b.persona_id === p.id
            return p.claimed_by && b.user_id === p.claimed_by
          })
          .reduce((sum, b) => sum + calcWinnings(b), 0)
        return { id: p.id, emoji: p.emoji, nickname: p.nickname, winnings }
      })
      .sort((a, b) => b.winnings - a.winnings)
      .slice(0, 8)
  }, [personaList, bets])

  return (
    <div className="space-y-5">
      {thisWeekendTeam && (
        <ActiveTeamStrip
          team={thisWeekendTeam.team}
          weekNum={thisWeekendTeam.weekNum}
          members={activeTeamMembers}
          outstandingOthers={outstandingOtherTeamMembers}
        />
      )}

      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-slate-400 text-sm mt-0.5">All bets across the syndicate</p>
      </div>

      {/* Kitty — club fund overview */}
      {personaList.length > 0 && (
        <div className="bg-slate-800 rounded-xl border border-emerald-700/40 p-4 flex gap-3">
          <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-emerald-400 font-bold text-sm uppercase tracking-wide">💰 The Kitty</span>
          </div>
          {/* Row 1: Balance + Per Punter */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Balance</p>
              <p className={`text-2xl font-bold ${kitty.balance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                ${kitty.balance.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Per Punter</p>
              <p className={`text-2xl font-bold ${kitty.payoutPerPunter >= 0 ? 'text-emerald-300' : 'text-red-400'}`}>
                ${kitty.payoutPerPunter.toFixed(2)}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">incl. ${kitty.toPay.toFixed(0)} still owed</p>
            </div>
          </div>
          {/* Row 2: Contributions + Penalties + Unattributed + To Pay */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border-t border-slate-700 pt-3">
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Paid In</p>
              <p className="text-base font-bold text-white">${kitty.contributions.toFixed(0)}</p>
              <p className="text-xs text-slate-500 mt-0.5">of ${kitty.totalTarget.toFixed(0)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Penalties</p>
              <p className={`text-base font-bold ${kitty.penalties > 0 ? 'text-purple-400' : 'text-slate-600'}`}>${kitty.penalties.toFixed(0)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Other</p>
              <p className={`text-base font-bold ${kitty.unattributed > 0 ? 'text-slate-300' : 'text-slate-600'}`}>${kitty.unattributed.toFixed(0)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Still Owed</p>
              <p className="text-base font-bold text-amber-400">${kitty.toPay.toFixed(0)}</p>
            </div>
          </div>
          {/* Progress bar */}
          <div className="mt-3 h-2 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${Math.min((kitty.contributions / kitty.totalTarget) * 100, 100)}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-1.5">
            {personaList.filter(p => parseFloat(p.amount_paid || 0) >= parseFloat(p.contribution_target || 400)).length}/{personaList.length} members fully paid
            {kitty.pendingStakes > 0 && <span className="text-yellow-500"> · ${kitty.pendingStakes.toFixed(2)} in pending bets</span>}
          </p>
          </div>
          {/* Mini leaderboard rail — top 8 by winnings */}
          {kittyMiniLeaderboard.length > 0 && (
            <div className="shrink-0 flex flex-col border-l border-slate-700/60 pl-2.5 -my-1">
              <p className="text-[9px] text-slate-500 uppercase tracking-wider mb-1.5 text-center">Stand</p>
              <div className="flex flex-col gap-2">
                {kittyMiniLeaderboard.map((p, i) => (
                  <div
                    key={p.id}
                    title={`${p.nickname} — $${p.winnings.toFixed(0)}`}
                    className="flex items-center gap-1 text-xs leading-none"
                  >
                    <span className={`w-3 text-right tabular-nums ${
                      i === 0 ? 'text-yellow-400 font-bold'
                      : i === 1 ? 'text-slate-300 font-bold'
                      : i === 2 ? 'text-amber-600 font-bold'
                      : 'text-slate-500'
                    }`}>{i + 1}</span>
                    <span className="text-base leading-none">{p.emoji}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stats strip — combined totals */}
      <div className="space-y-2">
        <div className="flex gap-3 overflow-x-auto pb-1">
          <div className="bg-green-500/15 rounded-lg border border-green-500/40 p-4 shrink-0 min-w-[140px]">
            <p className="text-green-400/70 text-xs uppercase tracking-wide">Total Winnings</p>
            <p className="text-2xl font-bold mt-1 text-green-400">${combined.winnings.toFixed(2)}</p>
          </div>
          {[
            { label: 'Total Bets', value: combined.total, color: 'text-white' },
            { label: 'Win Rate', value: `${combined.winRate}%`, color: 'text-white' },
            { label: 'Staked', value: `$${combined.staked.toFixed(2)}`, color: 'text-white' },
            { label: 'P&L', value: formatCurrency(combined.pl), color: profitLossColor(combined.pl) },
            { label: 'Avg Odds', value: combined.avgOdds > 0 ? combined.avgOdds.toFixed(2) : '—', color: 'text-purple-400' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-slate-800 rounded-lg border border-slate-700 p-4 shrink-0 min-w-[110px]">
              <p className="text-slate-400 text-xs uppercase tracking-wide">{label}</p>
              <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Breakdown: Individual vs Weekly */}
        <div className="bg-slate-800/50 rounded-lg border border-slate-700/50 px-4 py-3 space-y-2">
          {[
            { label: 'Indiv', s: individStats },
            { label: 'Weekly', s: weeklyStats },
          ].map(({ label, s }) => (
            <div key={label} className="flex items-center gap-3 text-xs flex-wrap">
              <span className="text-slate-500 font-semibold w-12 shrink-0">{label}</span>
              <span className="text-green-400 font-semibold">${s.winnings.toFixed(2)}</span>
              <span className="text-slate-400">{s.total} bets</span>
              <span className="text-slate-400">{s.winRate}% win</span>
              <span className={profitLossColor(s.pl)}>{formatCurrency(s.pl)} P&L</span>
              <span className="text-slate-600">·</span>
              <span className="text-purple-400">Avg Odds {s.avgOdds > 0 ? s.avgOdds.toFixed(2) : '—'}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Bet returns needing review (racing placements / unknown terms) */}
      {pendingBetReturnReview.length > 0 && (
        <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl px-4 py-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-amber-400">⚠ Bet Returns — Needs Review</span>
            <span className="text-xs text-slate-500">Terms require manual check (e.g. placed 2nd/3rd)</span>
          </div>
          <div className="space-y-1.5">
            {pendingBetReturnReview.map((b) => {
              const persona = (b.persona_id && byPersonaId[b.persona_id]) || personaMap[b.user_id]
              const name = persona ? `${persona.emoji} ${persona.nickname}` : '?'
              return (
                <div key={b.id} className="flex items-center gap-3 text-sm flex-wrap">
                  <span className="text-slate-300 font-medium">{name}</span>
                  <span className="text-amber-400 font-semibold">${parseFloat(b.bet_return_value).toFixed(2)}</span>
                  {b.bet_return_text && <span className="text-slate-500 text-xs truncate flex-1">{b.bet_return_text}</span>}
                  <span className="text-slate-500 text-xs shrink-0 capitalize">{b.outcome}</span>
                  <button onClick={() => confirmBetReturn(b.id, true)} className="text-xs px-2 py-0.5 rounded border border-green-600 text-green-400 hover:bg-green-500/10 transition-colors shrink-0">✓ Earned</button>
                  <button onClick={() => confirmBetReturn(b.id, false)} className="text-xs px-2 py-0.5 rounded border border-red-700 text-red-400 hover:bg-red-500/10 transition-colors shrink-0">✗ Not earned</button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Confirmed available bet returns */}
      {availableBetReturns.length > 0 && (
        <div className="bg-emerald-900/20 border border-emerald-700/40 rounded-xl px-4 py-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-emerald-400">🎁 Bet Returns Available</span>
            <span className="text-xs text-slate-500">Unused by Tuesday? Anyone can use it.</span>
          </div>
          <div className="space-y-1.5">
            {availableBetReturns.map((b) => {
              const betDate = new Date(b.date + 'T00:00:00')
              const dayOfWeek = betDate.getDay()
              const daysToTuesday = (2 - dayOfWeek + 7) % 7 || 7
              const tuesday = new Date(betDate)
              tuesday.setDate(betDate.getDate() + daysToTuesday)
              const isExpired = new Date() > tuesday
              const persona = (b.persona_id && byPersonaId[b.persona_id]) || personaMap[b.user_id]
              const name = persona ? `${persona.emoji} ${persona.nickname}` : '?'
              return (
                <div key={b.id} className="flex items-center gap-3 text-sm flex-wrap">
                  <span className="text-slate-300 font-medium">{name}</span>
                  <span className="text-emerald-400 font-semibold">${parseFloat(b.bet_return_value).toFixed(2)}</span>
                  {b.bet_return_text && <span className="text-slate-500 text-xs truncate flex-1">{b.bet_return_text}</span>}
                  <span className={`text-xs shrink-0 ${isExpired ? 'text-red-400' : 'text-slate-500'}`}>
                    {isExpired ? '⚠ Tue passed' : `until ${tuesday.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`}
                  </span>
                  <button
                    onClick={() => markBetReturnUsed(b.id)}
                    className="text-xs px-2 py-0.5 rounded border border-slate-600 text-slate-400 hover:text-white hover:border-slate-400 transition-colors shrink-0"
                  >
                    Mark used
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <FilterBar filters={filters} onChange={setFilters} members={members} />

      {/* Active / Archive tab toggle */}
      <div className="flex gap-2">
        {[
          { key: 'active', label: 'Active', count: (feedSections.pinnedWeekly ? 1 : 0) + feedSections.alivePending.length + feedSections.deadPending.length + feedSections.recentLoss.length + feedSections.wins.length },
          { key: 'archive', label: 'Archive', count: feedSections.archive.length },
        ].map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setDashTab(key)}
            className={`px-4 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
              dashTab === key
                ? 'bg-slate-700 border-slate-500 text-white'
                : 'border-slate-700 text-slate-400 hover:text-white hover:border-slate-500'
            }`}
          >
            {label} {count > 0 && <span className="text-xs opacity-60">({count})</span>}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center text-slate-400 py-16">Loading bets...</div>
      ) : dashTab === 'archive' ? (
        /* ── Archive tab ── */
        feedSections.archive.length === 0 ? (
          <div className="text-center text-slate-400 py-16">No archived bets yet.</div>
        ) : (
          <div className="space-y-3">
            {feedSections.archive.map(item =>
              item.type === 'bet'
                ? <BetCard key={item.key} bet={item.data} onDelete={handleDelete} onUpdate={handleUpdate} />
                : <WeeklyMultiCard key={item.key} multi={item.data} onUpdate={handleWeeklyUpdate} />
            )}
          </div>
        )
      ) : (
        /* ── Active tab ── */
        !feedSections.pinnedWeekly && feedSections.alivePending.length + feedSections.deadPending.length + feedSections.recentLoss.length + feedSections.wins.length === 0 ? (
          <div className="text-center text-slate-400 py-16">
            {Object.values(filters).some(Boolean) ? 'No bets match the current filters.' : 'No bets yet. Be the first to add one!'}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Pinned weekly multi — stays at the top until every leg is resolved */}
            {feedSections.pinnedWeekly && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-purple-400 uppercase tracking-wide">📌 This Week's Multi</h2>
                <WeeklyMultiCard multi={feedSections.pinnedWeekly} onUpdate={handleWeeklyUpdate} defaultExpanded={true} />
              </div>
            )}

            {/* Section 1: Still alive pending */}
            {feedSections.alivePending.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">🟡 Pending</h2>
                {feedSections.alivePending.map(item =>
                  item.type === 'bet'
                    ? <BetCard key={item.key} bet={item.data} onDelete={handleDelete} onUpdate={handleUpdate} />
                    : <WeeklyMultiCard key={item.key} multi={item.data} onUpdate={handleWeeklyUpdate} />
                )}
              </div>
            )}

            {/* Section 2: Pending but already lost by a leg */}
            {feedSections.deadPending.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-red-400/70 uppercase tracking-wide">💀 Lost — Legs Still Pending</h2>
                {feedSections.deadPending.map(item =>
                  item.type === 'bet'
                    ? <BetCard key={item.key} bet={item.data} onDelete={handleDelete} onUpdate={handleUpdate} />
                    : <WeeklyMultiCard key={item.key} multi={item.data} onUpdate={handleWeeklyUpdate} />
                )}
              </div>
            )}

            {/* Section 3: Recent losses (within 10 days) */}
            {feedSections.recentLoss.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">❌ Recent Losses</h2>
                {feedSections.recentLoss.map(item =>
                  item.type === 'bet'
                    ? <BetCard key={item.key} bet={item.data} onDelete={handleDelete} onUpdate={handleUpdate} />
                    : <WeeklyMultiCard key={item.key} multi={item.data} onUpdate={handleWeeklyUpdate} />
                )}
              </div>
            )}

            {/* Section 4: Wins — held all year */}
            {feedSections.wins.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-green-400/70 uppercase tracking-wide">✅ Winning Bets</h2>
                {feedSections.wins.map(item =>
                  item.type === 'bet'
                    ? <BetCard key={item.key} bet={item.data} onDelete={handleDelete} onUpdate={handleUpdate} />
                    : <WeeklyMultiCard key={item.key} multi={item.data} onUpdate={handleWeeklyUpdate} />
                )}
              </div>
            )}
          </div>
        )
      )}
    </div>
  )
}
