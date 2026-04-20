import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import BetCard from '../components/BetCard'
import WeeklyMultiCard from '../components/WeeklyMultiCard'
import FilterBar from '../components/FilterBar'
import { calcProfitLoss, calcWinnings, formatCurrency, profitLossColor, sortBetsByActivity, betLastEventTime, isRealStake } from '../lib/utils'
import { usePersonas } from '../hooks/usePersonas'

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
  const [dashTab, setDashTab] = useState('active') // 'active' | 'archive'

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const [betsRes, membersRes, weeklyRes, kittyRes, teamsRes] = await Promise.all([
      supabase
        .from('bets')
        .select('*, profiles(id, username, full_name), bet_legs(*)')
        .order('date', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('profiles').select('id, username, full_name').order('full_name'),
      supabase.from('weekly_multis').select('*, weekly_multi_legs(*, profiles(id, full_name, username))'),
      supabase.from('kitty_settings').select('unattributed_funds').eq('id', 1).maybeSingle(),
      supabase.from('teams').select('*').order('created_at'),
    ])
    setBets(betsRes.data || [])
    setMembers(membersRes.data || [])
    setWeeklyMultis(weeklyRes.data || [])
    setUnattributedFunds(parseFloat(kittyRes.data?.unattributed_funds || 0))
    setTeams(teamsRes.data || [])
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

    const allItems = [
      ...filteredBets.map(b => {
        const legs = b.bet_legs || []
        const hasLostLeg = legs.some(l => l.outcome === 'lost')
        return { type: 'bet', key: b.id, data: b, outcome: b.outcome, lastTime: betLastEventTime(b), date: b.date, created_at: b.created_at, hasLostLeg }
      }),
      ...weeklyMultis.map(m => {
        const legs = m.weekly_multi_legs || []
        const nonVoid = legs.filter(l => l.outcome !== 'void')
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

    return { alivePending, deadPending, recentLoss, wins, archive }
  }, [filteredBets, weeklyMultis])

  return (
    <div className="space-y-5">
      {thisWeekendTeam && (
        <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-2.5">
          <span className="text-green-400 text-sm">🏉</span>
          <span className="text-slate-400 text-sm">Team betting this week:</span>
          <span className="text-green-400 font-semibold text-sm">{thisWeekendTeam.team?.name}</span>
          <span className="text-slate-600 text-xs ml-auto">Week {thisWeekendTeam.weekNum}</span>
        </div>
      )}

      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-slate-400 text-sm mt-0.5">All bets across the syndicate</p>
      </div>

      {/* Kitty — club fund overview */}
      {personaList.length > 0 && (
        <div className="bg-slate-800 rounded-xl border border-emerald-700/40 p-4">
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
          { key: 'active', label: 'Active', count: feedSections.alivePending.length + feedSections.deadPending.length + feedSections.recentLoss.length + feedSections.wins.length },
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
        feedSections.alivePending.length + feedSections.deadPending.length + feedSections.recentLoss.length + feedSections.wins.length === 0 ? (
          <div className="text-center text-slate-400 py-16">
            {Object.values(filters).some(Boolean) ? 'No bets match the current filters.' : 'No bets yet. Be the first to add one!'}
          </div>
        ) : (
          <div className="space-y-5">
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
