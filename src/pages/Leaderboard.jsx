import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { calcProfitLoss, calcWinnings, formatCurrency, profitLossColor, isRealStake } from '../lib/utils'
import { usePersonas } from '../hooks/usePersonas'
import { aestMondayKey, currentAestMondayKey } from '../lib/goAgain'

const RANK_COLORS = ['text-yellow-400', 'text-slate-300', 'text-amber-600']

const SORT_OPTIONS = [
  { key: 'winnings', label: 'Winnings', format: (m) => `$${m.winnings.toFixed(2)}`, color: () => 'text-white' },
  { key: 'pl', label: 'P&L', format: (m) => formatCurrency(m.pl), color: (m) => profitLossColor(m.pl) },
  { key: 'winRate', label: 'Win Rate', format: (m) => `${m.winRate}%`, color: () => 'text-white' },
  { key: 'avgOdds', label: 'Avg Odds', format: (m) => m.avgOdds > 0 ? m.avgOdds.toFixed(2) : '—', color: () => 'text-purple-400' },
  { key: 'total', label: 'Bets', format: (m) => m.total, color: () => 'text-white' },
]

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
  return { total: multis.length, won, winnings, pl, staked, winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0, avgOdds }
}

export default function Leaderboard() {
  const { user } = useAuth()
  const { byUserId: personaMap, byPersonaId } = usePersonas()
  const [bets, setBets] = useState([])
  const [members, setMembers] = useState([]) // personas with team_id resolved
  const [teams, setTeams] = useState([])
  const [weeklyMultis, setWeeklyMultis] = useState([])
  const [goAgainCredits, setGoAgainCredits] = useState([])
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState('winnings')

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const [betsRes, personasRes, profilesRes, teamsRes, weeklyRes, creditsRes] = await Promise.all([
      supabase.from('bets').select('user_id, persona_id, stake, odds, outcome, is_bonus_bet, is_rollover, intend_to_rollover, bet_return_value, created_at, date'),
      // select('*') so we get team_id if the column exists, without error if it doesn't
      supabase.from('personas').select('*').order('nickname'),
      // keep profiles for team fallback (pre-migration) and kitty data if needed
      supabase.from('profiles').select('id, team_id'),
      supabase.from('teams').select('*').order('created_at'),
      supabase.from('weekly_multis').select('*, weekly_multi_legs(*)'),
      supabase.from('go_again_credits').select('*'),
    ])

    // Build profile→team fallback map for claimed personas pre-migration
    const profileTeamMap = {}
    for (const p of profilesRes.data || []) {
      if (p.team_id) profileTeamMap[p.id] = p.team_id
    }

    // Augment personas: if team_id not yet on persona row, derive from profile
    const personas = (personasRes.data || []).map((p) => ({
      ...p,
      team_id: p.team_id || (p.claimed_by ? (profileTeamMap[p.claimed_by] ?? null) : null),
    }))

    setBets(betsRes.data || [])
    setMembers(personas)
    setTeams(teamsRes.data || [])
    setWeeklyMultis(weeklyRes.data || [])
    setGoAgainCredits(creditsRes.data || [])
    setLoading(false)
  }

  function calcStats(memberBets) {
    // Exclude rollover bets from win/loss/total counts — they're not real settled capital bets.
    // intend_to_rollover wins are pass-through (winnings get re-bet); is_rollover are funded
    // from that pass-through pool. P&L and staked use all bets via their own helpers.
    const countable = memberBets.filter((b) => !b.intend_to_rollover && !b.is_rollover)
    const resolved = countable.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void')
    const won = countable.filter((b) => b.outcome === 'won').length
    const lost = countable.filter((b) => b.outcome === 'lost').length
    const pending = countable.filter((b) => b.outcome === 'pending').length
    const voided = countable.filter((b) => b.outcome === 'void').length
    const pl = memberBets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const staked = memberBets.filter((b) => b.outcome !== 'void' && isRealStake(b)).reduce((sum, b) => sum + parseFloat(b.stake), 0)
    const winnings = memberBets.filter((b) => b.outcome === 'won').reduce((sum, b) => sum + calcWinnings(b), 0)
    const nonVoid = memberBets.filter((b) => b.outcome !== 'void')
    const sumStakeOdds = nonVoid.reduce((sum, b) => sum + parseFloat(b.stake) * parseFloat(b.odds), 0)
    const avgOdds = staked > 0 ? sumStakeOdds / staked : 0
    const betReturnsEarned = memberBets.filter((b) => b.outcome === 'lost' && b.bet_return_value > 0)
      .reduce((sum, b) => sum + parseFloat(b.bet_return_value), 0)
    const bonusBetsUsed = memberBets.filter((b) => b.is_bonus_bet)
      .reduce((sum, b) => sum + parseFloat(b.stake), 0)
    return { total: countable.length, won, lost, pending, voided, winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0, pl, staked, winnings, avgOdds, betReturnsEarned, bonusBetsUsed }
  }

  // A bet belongs to a persona if persona_id matches directly,
  // or (no persona_id set) if the bet's user_id matches this persona's claimed_by
  function betBelongsToPersona(bet, personaId) {
    if (bet.persona_id) return bet.persona_id === personaId
    const persona = byPersonaId[personaId]
    return !!(persona?.claimed_by && bet.user_id === persona.claimed_by)
  }

  const leaderboard = useMemo(() => {
    return members
      .map((persona) => ({ ...persona, ...calcStats(bets.filter((b) => betBelongsToPersona(b, persona.id))) }))
      .sort((a, b) => b[sortKey] - a[sortKey])
  }, [bets, members, sortKey, byPersonaId])

  const teamLeaderboard = useMemo(() => {
    return teams.map((team) => {
      const teamPersonas = members.filter((m) => m.team_id === team.id)
      const teamBets = bets.filter((b) => teamPersonas.some((p) => betBelongsToPersona(b, p.id)))
      return { ...team, memberCount: teamPersonas.length, ...calcStats(teamBets) }
    }).sort((a, b) => b[sortKey] - a[sortKey])
  }, [bets, members, teams, sortKey, byPersonaId])

  const individStats = useMemo(() => {
    const pl = bets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const nonVoid = bets.filter((b) => b.outcome !== 'void')
    const staked = nonVoid.filter((b) => isRealStake(b)).reduce((sum, b) => sum + parseFloat(b.stake), 0)
    const resolved = bets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void')
    const won = bets.filter((b) => b.outcome === 'won').length
    const winnings = bets.reduce((sum, b) => sum + calcWinnings(b), 0)
    const sumStakeOdds = nonVoid.reduce((sum, b) => sum + parseFloat(b.stake) * parseFloat(b.odds), 0)
    const avgOdds = staked > 0 ? sumStakeOdds / staked : 0
    return { pl, staked, winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0, total: bets.length, winnings, avgOdds }
  }, [bets])

  const weeklyStats = useMemo(() => calcWeeklyStats(weeklyMultis), [weeklyMultis])

  // ── Weekly rotation & allocation tracking ─────────────────────────────────
  // Allocation = $50 per active week the team has had (including current week
  // once Monday AEST has flipped) + $50 per Go-Again credit earned by the
  // member, regardless of whether it's been used yet (used credits still count
  // toward the lifetime allocation total — "actual stakes" tracks usage).
  const ALLOCATION_PER_WEEKEND = 50

  const rotationStats = useMemo(() => {
    if (teams.length < 2) return null

    // Use total multi count (not just resolved ones) — a created multi means
    // that betting week happened, regardless of whether legs have been resolved.
    const sortedMultis = [...weeklyMultis].sort((a, b) =>
      (a.created_at || '').localeCompare(b.created_at || '')
    )
    const totalMultis = sortedMultis.length

    // Completed (fully-resolved) multis still drive the rotation banner — keeps
    // the "this/next weekend" labels stable across multi-resolution windows.
    const completedWeeks = weeklyMultis.filter((m) => {
      const nonVoid = (m.weekly_multi_legs || []).filter((l) => l.outcome !== 'void')
      return nonVoid.length > 0 && nonVoid.every((l) => l.outcome === 'won' || l.outcome === 'lost')
    }).length
    const upcomingWeekNum = completedWeeks + 1
    const thisWeekendTeam = teams[upcomingWeekNum % 2]
    const nextWeekendTeam = teams[(upcomingWeekNum - 1) % 2]

    // Active weeks per team, alternating with the same rotation as thisWeekendTeam.
    // weekNum N → teams[N % 2]. So teams[1] gets odd weeks, teams[0] gets even weeks.
    const teamActiveWeeks = {}
    for (const t of teams) teamActiveWeeks[t.id] = 0
    for (let i = 1; i <= totalMultis; i++) {
      const teamId = teams[i % 2]?.id
      if (teamId) teamActiveWeeks[teamId]++
    }

    // If today (Monday-AEST week) hasn't yet had a multi created for it, the
    // upcoming team should already see their +$50 — that's the "team flips
    // Monday" behaviour. The cron creates multis Mon 06:00 AEST, so this gap
    // is small but real (and matters when manually checking on a Monday morning).
    const currentWeek = currentAestMondayKey()
    const lastMultiWeek = sortedMultis.length > 0
      ? aestMondayKey(sortedMultis[sortedMultis.length - 1].created_at)
      : null
    const currentWeekHasMulti = lastMultiWeek === currentWeek
    if (!currentWeekHasMulti) {
      const nextWeekNum = totalMultis + 1
      const nextActiveTeamId = teams[nextWeekNum % 2]?.id
      if (nextActiveTeamId) teamActiveWeeks[nextActiveTeamId]++
    }

    const memberAllocations = members.map((persona) => {
      const teamWeeks = teamActiveWeeks[persona.team_id] || 0
      const baseAllocation = teamWeeks * ALLOCATION_PER_WEEKEND
      const personaCreditCount = goAgainCredits.filter((c) => c.persona_id === persona.id).length
      const goAgainBonus = personaCreditCount * ALLOCATION_PER_WEEKEND
      const expected = baseAllocation + goAgainBonus
      const actual = bets
        .filter((b) => betBelongsToPersona(b, persona.id) && b.outcome !== 'void' && isRealStake(b))
        .reduce((sum, b) => sum + parseFloat(b.stake), 0)
      const remaining = Math.max(0, expected - actual)
      return { memberId: persona.id, teamId: persona.team_id, expected, actual, remaining, goAgainBonus }
    })

    // Per-team allocation totals — sum of all members' expected allocation.
    const teamAllocations = {}
    for (const t of teams) {
      const sum = memberAllocations
        .filter((a) => a.teamId === t.id)
        .reduce((s, a) => s + a.expected, 0)
      const used = memberAllocations
        .filter((a) => a.teamId === t.id)
        .reduce((s, a) => s + a.actual, 0)
      teamAllocations[t.id] = { expected: sum, actual: used, remaining: Math.max(0, sum - used) }
    }

    return {
      thisWeekendTeam,
      nextWeekendTeam,
      upcomingWeekNum,
      completedWeeks,
      memberAllocations,
      teamAllocations,
    }
  }, [weeklyMultis, teams, members, bets, byPersonaId, goAgainCredits])

  const groupStats = useMemo(() => {
    const winnings = individStats.winnings + weeklyStats.winnings
    const staked = individStats.staked + weeklyStats.staked
    const pl = individStats.pl + weeklyStats.pl
    const totalResolved = bets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void').length
      + weeklyMultis.filter((m) => { const nv = (m.weekly_multi_legs||[]).filter(l=>l.outcome!=='void'); return nv.length > 0 && nv.every(l=>l.outcome==='won'||l.outcome==='lost') }).length
    const totalWon = bets.filter((b) => b.outcome === 'won').length + weeklyStats.won
    const winRate = totalResolved ? Math.round((totalWon / totalResolved) * 100) : 0
    const total = individStats.total + weeklyStats.total
    const avgOdds = staked > 0
      ? (individStats.avgOdds * individStats.staked + weeklyStats.avgOdds * weeklyStats.staked) / staked
      : 0
    return { winnings, staked, pl, winRate, total, avgOdds }
  }, [individStats, weeklyStats, bets, weeklyMultis])

  const activeSortOpt = SORT_OPTIONS.find((o) => o.key === sortKey)

  if (loading) return <div className="text-center text-slate-400 py-16">Loading...</div>

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Leaderboard</h1>
        <p className="text-slate-400 text-sm mt-0.5">Ranked by {activeSortOpt?.label}</p>
      </div>

      {/* Group summary */}
      <div className="space-y-2">
        <div className="flex gap-3 overflow-x-auto pb-1">
          <div className="bg-green-500/15 rounded-lg border border-green-500/40 p-4 shrink-0 min-w-[140px]">
            <p className="text-green-400/70 text-xs uppercase tracking-wide">Total Winnings</p>
            <p className="text-2xl font-bold mt-1 text-green-400">${groupStats.winnings.toFixed(2)}</p>
          </div>
          {[
            { label: 'Total Bets Placed', value: groupStats.total, color: 'text-white' },
            { label: 'Win Rate', value: `${groupStats.winRate}%`, color: 'text-white' },
            { label: 'Staked', value: `$${groupStats.staked.toFixed(2)}`, color: 'text-white' },
            { label: 'P&L', value: formatCurrency(groupStats.pl), color: profitLossColor(groupStats.pl) },
            { label: 'Avg Odds', value: groupStats.avgOdds > 0 ? groupStats.avgOdds.toFixed(2) : '—', color: 'text-purple-400' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-slate-800 rounded-lg border border-slate-700 p-4 shrink-0 min-w-[110px]">
              <p className="text-slate-400 text-xs uppercase tracking-wide">{label}</p>
              <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
            </div>
          ))}
        </div>

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

      {/* Sort toggle */}
      <div className="flex gap-2 flex-wrap">
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => setSortKey(opt.key)}
            className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              sortKey === opt.key
                ? 'bg-green-500/20 border-green-500/40 text-green-400'
                : 'border-slate-700 text-slate-400 hover:text-white hover:border-slate-500'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Weekly rotation banner */}
      {rotationStats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
            <p className="text-green-400 text-xs uppercase tracking-wide font-semibold mb-1">
              🏉 This Weekend — Week {rotationStats.upcomingWeekNum}
            </p>
            <p className="text-white font-bold text-lg">{rotationStats.thisWeekendTeam?.name}</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {members.filter((m) => m.team_id === rotationStats.thisWeekendTeam?.id).map((m) => (
                <span key={m.id} className="text-xs bg-green-500/20 text-green-300 px-2 py-0.5 rounded-full">
                  {m.emoji} {m.nickname}
                </span>
              ))}
            </div>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
            <p className="text-slate-400 text-xs uppercase tracking-wide font-semibold mb-1">
              Next Weekend — Week {rotationStats.upcomingWeekNum + 1}
            </p>
            <p className="text-slate-300 font-bold text-lg">{rotationStats.nextWeekendTeam?.name}</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {members.filter((m) => m.team_id === rotationStats.nextWeekendTeam?.id).map((m) => (
                <span key={m.id} className="text-xs bg-slate-700 text-slate-400 px-2 py-0.5 rounded-full">
                  {m.emoji} {m.nickname}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Team standings */}
      {teamLeaderboard.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">Team Standings</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {teamLeaderboard.map((team, i) => {
              const isLeading = i === 0 && teamLeaderboard.length > 1 && team[sortKey] !== teamLeaderboard[1]?.[sortKey]
              return (
                <div
                  key={team.id}
                  className={`bg-slate-800 rounded-lg border p-4 space-y-3 ${isLeading ? 'border-yellow-500/30' : 'border-slate-700'}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {isLeading && <span>🏆</span>}
                      <span className="font-bold text-white">{team.name}</span>
                      <span className="text-xs text-slate-500">{team.memberCount} members</span>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold text-green-400">
                        ${team.winnings.toFixed(2)}
                      </div>
                      <div className="text-xs text-slate-500">Total Winnings</div>
                    </div>
                  </div>
                  <div className="flex gap-4 text-xs flex-wrap">
                    <span className="text-slate-500">Bets <span className="text-white font-medium">{team.total}</span></span>
                    <span className="text-green-400">{team.won}W</span>
                    <span className="text-red-400">{team.lost}L</span>
                    {team.pending > 0 && <span className="text-yellow-400">{team.pending}P</span>}
                    {team.voided > 0 && <span className="text-slate-500">{team.voided}V</span>}
                    <span className={profitLossColor(team.pl)}>P&L {formatCurrency(team.pl)}</span>
                  </div>
                  {(() => {
                    const alloc = rotationStats?.teamAllocations?.[team.id]
                    if (!alloc || alloc.expected === 0) return null
                    return (
                      <div className="flex items-center gap-2 text-xs pt-1 border-t border-slate-700/40">
                        <span className="text-slate-500">Allocation</span>
                        <span className="text-white font-medium">${alloc.actual.toFixed(0)} / ${alloc.expected.toFixed(0)}</span>
                        {alloc.remaining > 0 && (
                          <span className="text-amber-400">${alloc.remaining.toFixed(0)} left</span>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Individual */}
      <div>
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">Individual</h2>
        {leaderboard.length === 0 ? (
          <div className="text-center text-slate-400 py-16">No bets recorded yet.</div>
        ) : (
          <div className="space-y-2">
            {leaderboard.map((persona, i) => {
              const isMe = persona.claimed_by === user?.id
              const noActivity = persona.total === 0
              const isClaimed = !!persona.claimed_by

              const rowContent = (
                <>
                  <div className={`text-xl font-bold w-7 text-center shrink-0 ${RANK_COLORS[i] ?? 'text-slate-600'}`}>
                    {i + 1}
                  </div>
                  <div className="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center text-xl shrink-0">
                    {persona.emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-white text-sm">{persona.nickname}</span>
                      {isMe && <span className="text-xs text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">You</span>}
                      {!isClaimed && <span className="text-xs text-slate-500 bg-slate-700/60 px-1.5 py-0.5 rounded">Unclaimed</span>}
                    </div>
                    {persona.total > 0 ? (
                      <div className="flex gap-2 text-xs text-slate-400 mt-0.5 flex-wrap">
                        <span>{persona.total} bets</span>
                        <span className="text-green-400">{persona.won}W</span>
                        <span className="text-red-400">{persona.lost}L</span>
                        {persona.pending > 0 && <span className="text-yellow-400">{persona.pending}P</span>}
                        {persona.voided > 0 && <span className="text-slate-500">{persona.voided}V</span>}
                        <span>· ${persona.staked.toFixed(2)} staked</span>
                        {persona.bonusBetsUsed > 0 && <span className="text-amber-400">· ${persona.bonusBetsUsed.toFixed(2)} bonus</span>}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500 mt-0.5">No bets yet</p>
                    )}
                    {/* Kitty contribution */}
                    {(() => {
                      const paid = parseFloat(persona.amount_paid || 0)
                      const penalties = parseFloat(persona.penalties_paid || 0)
                      const target = parseFloat(persona.contribution_target || 400)
                      const owed = Math.max(0, target - paid)
                      const pct = Math.min((paid / target) * 100, 100)
                      const full = paid >= target
                      return (
                        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                          <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden max-w-[80px]">
                            <div className={`h-full rounded-full ${full ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-emerald-400">Paid ${paid.toFixed(0)}</span>
                          {!full && <span className="text-xs text-amber-400">· Owes ${owed.toFixed(0)}</span>}
                          {full && <span className="text-xs text-emerald-400">· Kitty paid ✓</span>}
                          {penalties > 0 && <span className="text-xs text-purple-400">+${penalties.toFixed(0)} fines</span>}
                        </div>
                      )
                    })()}
                    {/* Weekly allocation */}
                    {(() => {
                      const alloc = rotationStats?.memberAllocations?.find((a) => a.memberId === persona.id)
                      if (!alloc || alloc.expected === 0) return null
                      const pct = Math.min((alloc.actual / alloc.expected) * 100, 100)
                      const hasRemaining = alloc.remaining > 0
                      return (
                        <div className="mt-1 flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden max-w-[80px]">
                            <div className={`h-full rounded-full ${hasRemaining ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className={`text-xs ${hasRemaining ? 'text-amber-400' : 'text-emerald-400'}`}>
                            ${alloc.actual.toFixed(0)} / ${alloc.expected.toFixed(0)} allocation
                          </span>
                          {hasRemaining && (
                            <span className="text-xs text-amber-300 font-medium">${alloc.remaining.toFixed(0)} left</span>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-base font-bold ${activeSortOpt.color(persona)}`}>
                      {activeSortOpt.format(persona)}
                    </div>
                    {sortKey !== 'winnings' && (
                      <div className="text-xs text-slate-500">Won ${persona.winnings.toFixed(2)}</div>
                    )}
                    {sortKey !== 'pl' && (
                      <div className={`text-xs ${profitLossColor(persona.pl)}`}>P&L {formatCurrency(persona.pl)}</div>
                    )}
                  </div>
                </>
              )

              const rowClass = `flex items-center gap-4 bg-slate-800 rounded-lg border p-4 transition-colors ${
                isMe ? 'border-green-500/40' : 'border-slate-700'
              } ${noActivity ? 'opacity-60' : ''}`

              // Claimed personas link to their profile page; unclaimed are non-clickable
              return isClaimed ? (
                <Link
                  key={persona.id}
                  to={`/profile/${persona.claimed_by}`}
                  className={`${rowClass} hover:border-slate-500`}
                >
                  {rowContent}
                </Link>
              ) : (
                <div key={persona.id} className={rowClass}>
                  {rowContent}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
