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
  const withStake = results.filter((r) => r.stake > 0)
  const boldness = withStake.length > 0 ? sumStakeOdds / withStake.length : 0
  const riskProfile = staked > 0 ? sumStakeOdds / staked : 0
  return {
    total: multis.length,
    won,
    winnings,
    pl,
    staked,
    winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0,
    boldness,
    riskProfile,
  }
}

export default function Dashboard() {
  const { byUserId: personaMap, byPersonaId, list: personaList } = usePersonas()
  const [bets, setBets] = useState([])
  const [members, setMembers] = useState([])
  const [weeklyMultis, setWeeklyMultis] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({})

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const [betsRes, membersRes, weeklyRes] = await Promise.all([
      supabase
        .from('bets')
        .select('*, profiles(id, username, full_name), bet_legs(*)')
        .order('date', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('profiles').select('id, username, full_name').order('full_name'),
      supabase.from('weekly_multis').select('*, weekly_multi_legs(*, profiles(id, full_name, username))'),
    ])
    setBets(betsRes.data || [])
    setMembers(membersRes.data || [])
    setWeeklyMultis(weeklyRes.data || [])
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
    const boldness = nonVoid.length > 0 ? sumStakeOdds / nonVoid.length : 0
    const riskProfile = staked > 0 ? sumStakeOdds / staked : 0
    return {
      total: filteredBets.length,
      winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0,
      pl, staked, winnings, boldness, riskProfile,
    }
  }, [filteredBets])

  const weeklyStats = useMemo(() => calcWeeklyStats(weeklyMultis), [weeklyMultis])

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
    boldness: (individStats.boldness + weeklyStats.boldness) / (individStats.total > 0 && weeklyStats.total > 0 ? 2 : 1),
    riskProfile: (individStats.staked + weeklyStats.staked) > 0
      ? (individStats.riskProfile * individStats.staked + weeklyStats.riskProfile * weeklyStats.staked) / (individStats.staked + weeklyStats.staked)
      : 0,
  }), [individStats, weeklyStats, filteredBets, weeklyMultis])

  // Kitty: total contributions + settled P&L − pending stakes (committed, can't retrieve)
  const kitty = useMemo(() => {
    const totalPaid = personaList.reduce((s, p) => s + parseFloat(p.amount_paid || 0), 0)
    const totalTarget = personaList.reduce((s, p) => s + parseFloat(p.contribution_target || 400), 0)
    // Only settled bets affect P&L; pending bets are treated as a deduction (stake already out)
    const settledPL = bets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    // Deduct real pending stakes (bonus bets are free — no real money at risk)
    const pendingStakes = bets
      .filter(b => b.outcome === 'pending' && !b.is_bonus_bet)
      .reduce((sum, b) => sum + parseFloat(b.stake), 0)
    // Weekly multis: deduct stakes for any still-pending multis
    const pendingWeeklyStakes = weeklyMultis
      .filter(m => {
        const legs = m.weekly_multi_legs || []
        const nonVoid = legs.filter(l => l.outcome !== 'void')
        return nonVoid.length === 0 || nonVoid.some(l => l.outcome === 'pending')
      })
      .reduce((sum, m) => sum + parseFloat(m.stake || 0), 0)
    const balance = totalPaid + settledPL + weeklyStats.pl - pendingStakes - pendingWeeklyStakes
    return { totalPaid, totalTarget, toPay: totalTarget - totalPaid, balance, pendingStakes: pendingStakes + pendingWeeklyStakes }
  }, [personaList, bets, weeklyMultis, weeklyStats])

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

  // Merge bets + weekly multis into a single feed sorted by activity
  // Pending items with furthest event time sit at the top; resolved below
  const feedItems = useMemo(() => {
    // Treat weekly multis like bets for sorting: use created_at as fallback time
    const allItems = [
      ...filteredBets.map(b => ({ type: 'bet', key: b.id, data: b, outcome: b.outcome, lastTime: betLastEventTime(b), date: b.date, created_at: b.created_at })),
      ...weeklyMultis.map(m => {
        const legs = m.weekly_multi_legs || []
        const outcome = legs.length === 0 ? 'pending' : legs.every(l => l.outcome === 'won' || l.outcome === 'void') && legs.some(l => l.outcome === 'won') ? 'won' : legs.some(l => l.outcome === 'lost') ? 'lost' : 'pending'
        // Use earliest pending leg's event_time for sorting (mirrors betLastEventTime for regular bets)
        const pendingLegTimes = legs
          .filter(l => l.outcome === 'pending' && l.event_time)
          .map(l => new Date(l.event_time).getTime())
          .filter(t => !isNaN(t))
        const lastTime = pendingLegTimes.length > 0 ? Math.max(...pendingLegTimes) : null
        return { type: 'weekly', key: m.id, data: m, outcome, lastTime, date: m.created_at?.slice(0, 10), created_at: m.created_at }
      }),
    ]
    return allItems.sort((a, b) => {
      const aPending = a.outcome === 'pending'
      const bPending = b.outcome === 'pending'
      if (aPending && !bPending) return -1
      if (!aPending && bPending) return 1
      if (aPending) {
        if (a.lastTime && b.lastTime) return b.lastTime - a.lastTime
        if (a.lastTime) return -1
        if (b.lastTime) return 1
        return b.created_at.localeCompare(a.created_at)
      }
      return (b.date || '').localeCompare(a.date || '') || b.created_at.localeCompare(a.created_at)
    })
  }, [filteredBets, weeklyMultis])

  return (
    <div className="space-y-5">
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
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Balance</p>
              <p className={`text-2xl font-bold ${kitty.balance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                ${kitty.balance.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Paid In</p>
              <p className="text-xl font-bold text-white">${kitty.totalPaid.toFixed(2)}</p>
              <p className="text-xs text-slate-500 mt-0.5">of ${kitty.totalTarget.toFixed(0)} target</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">To Pay</p>
              <p className="text-xl font-bold text-amber-400">${kitty.toPay.toFixed(2)}</p>
            </div>
          </div>
          {/* Progress bar */}
          <div className="mt-3 h-2 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${Math.min((kitty.totalPaid / kitty.totalTarget) * 100, 100)}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-1.5">
            {Math.round((kitty.totalPaid / kitty.totalTarget) * 100)}% collected · {personaList.filter(p => parseFloat(p.amount_paid || 0) >= parseFloat(p.contribution_target || 400)).length}/{personaList.length} members fully paid
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
            { label: 'Boldness', value: combined.boldness > 0 ? combined.boldness.toFixed(0) : '—', color: 'text-orange-400' },
            { label: 'Risk Profile', value: combined.riskProfile > 0 ? combined.riskProfile.toFixed(2) : '—', color: 'text-purple-400' },
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
              <span className="text-orange-400">Boldness {s.boldness > 0 ? s.boldness.toFixed(0) : '—'}</span>
              <span className="text-purple-400">Risk {s.riskProfile > 0 ? s.riskProfile.toFixed(2) : '—'}</span>
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

      {loading ? (
        <div className="text-center text-slate-400 py-16">Loading bets...</div>
      ) : feedItems.length === 0 ? (
        <div className="text-center text-slate-400 py-16">
          {Object.values(filters).some(Boolean)
            ? 'No bets match the current filters.'
            : 'No bets yet. Be the first to add one!'}
        </div>
      ) : (
        <div className="space-y-3">
          {feedItems.map((item) =>
            item.type === 'bet' ? (
              <BetCard key={item.key} bet={item.data} onDelete={handleDelete} onUpdate={handleUpdate} />
            ) : (
              <WeeklyMultiCard key={item.key} multi={item.data} onUpdate={handleWeeklyUpdate} />
            )
          )}
        </div>
      )}
    </div>
  )
}
