import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { calcProfitLoss, formatCurrency, profitLossColor } from '../lib/utils'

const RANK_COLORS = ['text-yellow-400', 'text-slate-300', 'text-amber-600']

const SORT_OPTIONS = [
  { key: 'winnings', label: 'Winnings', format: (m) => `$${m.winnings.toFixed(2)}`, color: () => 'text-white' },
  { key: 'pl', label: 'P&L', format: (m) => formatCurrency(m.pl), color: (m) => profitLossColor(m.pl) },
  { key: 'winRate', label: 'Win Rate', format: (m) => `${m.winRate}%`, color: () => 'text-white' },
  { key: 'betBoldness', label: 'Boldness', format: (m) => m.betBoldness > 0 ? m.betBoldness.toFixed(0) : '—', color: () => 'text-orange-400' },
  { key: 'riskProfile', label: 'Risk Profile', format: (m) => m.riskProfile > 0 ? m.riskProfile.toFixed(2) : '—', color: () => 'text-purple-400' },
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
  const withStake = results.filter((r) => r.stake > 0)
  const boldness = withStake.length > 0 ? sumStakeOdds / withStake.length : 0
  const riskProfile = staked > 0 ? sumStakeOdds / staked : 0
  return { total: multis.length, won, winnings, pl, staked, winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0, boldness, riskProfile }
}

export default function Leaderboard() {
  const { user } = useAuth()
  const [bets, setBets] = useState([])
  const [members, setMembers] = useState([])
  const [teams, setTeams] = useState([])
  const [weeklyMultis, setWeeklyMultis] = useState([])
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState('winnings')

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const [betsRes, membersRes, teamsRes, weeklyRes] = await Promise.all([
      supabase.from('bets').select('user_id, stake, odds, outcome'),
      supabase.from('profiles').select('id, username, full_name, team_id').order('full_name'),
      supabase.from('teams').select('*').order('created_at'),
      supabase.from('weekly_multis').select('*, weekly_multi_legs(*)'),
    ])
    setBets(betsRes.data || [])
    setMembers(membersRes.data || [])
    setTeams(teamsRes.data || [])
    setWeeklyMultis(weeklyRes.data || [])
    setLoading(false)
  }

  function calcStats(memberBets) {
    const resolved = memberBets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void')
    const won = memberBets.filter((b) => b.outcome === 'won').length
    const lost = memberBets.filter((b) => b.outcome === 'lost').length
    const pending = memberBets.filter((b) => b.outcome === 'pending').length
    const voided = memberBets.filter((b) => b.outcome === 'void').length
    const pl = memberBets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const staked = memberBets.filter((b) => b.outcome !== 'void').reduce((sum, b) => sum + parseFloat(b.stake), 0)
    const winnings = memberBets.filter((b) => b.outcome === 'won').reduce((sum, b) => sum + parseFloat(b.stake) * parseFloat(b.odds), 0)
    // Bet Boldness: avg(stake × odds) per bet — rewards both big stakes AND long odds
    // Risk Profile: sum(stake × odds) / total staked = stake-weighted avg odds — pure measure of how risky your selections are
    const nonVoid = memberBets.filter((b) => b.outcome !== 'void')
    const sumStakeOdds = nonVoid.reduce((sum, b) => sum + parseFloat(b.stake) * parseFloat(b.odds), 0)
    const betBoldness = nonVoid.length > 0 ? sumStakeOdds / nonVoid.length : 0
    const riskProfile = staked > 0 ? sumStakeOdds / staked : 0
    return { total: memberBets.length, won, lost, pending, voided, winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0, pl, staked, winnings, betBoldness, riskProfile }
  }

  const leaderboard = useMemo(() => {
    return members
      .map((member) => ({ ...member, ...calcStats(bets.filter((b) => b.user_id === member.id)) }))
      .sort((a, b) => b[sortKey] - a[sortKey])
  }, [bets, members, sortKey])

  const teamLeaderboard = useMemo(() => {
    return teams.map((team) => {
      const teamMembers = members.filter((m) => m.team_id === team.id)
      const memberIds = new Set(teamMembers.map((m) => m.id))
      const teamBets = bets.filter((b) => memberIds.has(b.user_id))
      return { ...team, memberCount: teamMembers.length, ...calcStats(teamBets) }
    }).sort((a, b) => b[sortKey] - a[sortKey])
  }, [bets, members, teams, sortKey])

  const individStats = useMemo(() => {
    const pl = bets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const nonVoid = bets.filter((b) => b.outcome !== 'void')
    const staked = nonVoid.reduce((sum, b) => sum + parseFloat(b.stake), 0)
    const resolved = bets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void')
    const won = bets.filter((b) => b.outcome === 'won').length
    const winnings = bets.filter((b) => b.outcome === 'won').reduce((sum, b) => sum + parseFloat(b.stake) * parseFloat(b.odds), 0)
    const sumStakeOdds = nonVoid.reduce((sum, b) => sum + parseFloat(b.stake) * parseFloat(b.odds), 0)
    const boldness = nonVoid.length > 0 ? sumStakeOdds / nonVoid.length : 0
    const riskProfile = staked > 0 ? sumStakeOdds / staked : 0
    return { pl, staked, winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0, total: bets.length, winnings, boldness, riskProfile }
  }, [bets])

  const weeklyStats = useMemo(() => calcWeeklyStats(weeklyMultis), [weeklyMultis])

  const groupStats = useMemo(() => {
    const winnings = individStats.winnings + weeklyStats.winnings
    const staked = individStats.staked + weeklyStats.staked
    const pl = individStats.pl + weeklyStats.pl
    const totalResolved = bets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void').length
      + weeklyMultis.filter((m) => { const nv = (m.weekly_multi_legs||[]).filter(l=>l.outcome!=='void'); return nv.length > 0 && nv.every(l=>l.outcome==='won'||l.outcome==='lost') }).length
    const totalWon = bets.filter((b) => b.outcome === 'won').length + weeklyStats.won
    const winRate = totalResolved ? Math.round((totalWon / totalResolved) * 100) : 0
    const total = individStats.total + weeklyStats.total
    const riskProfile = staked > 0
      ? (individStats.riskProfile * individStats.staked + weeklyStats.riskProfile * weeklyStats.staked) / staked
      : 0
    const boldness = (individStats.total > 0 && weeklyStats.total > 0)
      ? (individStats.boldness + weeklyStats.boldness) / 2
      : individStats.boldness || weeklyStats.boldness
    return { winnings, staked, pl, winRate, total, boldness, riskProfile }
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
          {/* Total Winnings — hero card pinned left */}
          <div className="bg-green-500/15 rounded-lg border border-green-500/40 p-4 shrink-0 min-w-[140px]">
            <p className="text-green-400/70 text-xs uppercase tracking-wide">Total Winnings</p>
            <p className="text-2xl font-bold mt-1 text-green-400">${groupStats.winnings.toFixed(2)}</p>
          </div>
          {[
            { label: 'Total Bets Placed', value: groupStats.total, color: 'text-white' },
            { label: 'Win Rate', value: `${groupStats.winRate}%`, color: 'text-white' },
            { label: 'Staked', value: `$${groupStats.staked.toFixed(2)}`, color: 'text-white' },
            { label: 'P&L', value: formatCurrency(groupStats.pl), color: profitLossColor(groupStats.pl) },
            { label: 'Boldness', value: groupStats.boldness > 0 ? groupStats.boldness.toFixed(0) : '—', color: 'text-orange-400' },
            { label: 'Risk Profile', value: groupStats.riskProfile > 0 ? groupStats.riskProfile.toFixed(2) : '—', color: 'text-purple-400' },
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
                      <div className={`text-lg font-bold ${activeSortOpt.color(team)}`}>
                        {activeSortOpt.format(team)}
                      </div>
                      {sortKey !== 'winnings' && (
                        <div className="text-xs text-slate-500">Winnings ${team.winnings.toFixed(2)}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-4 text-xs flex-wrap">
                    <span className="text-slate-500">Bets <span className="text-white font-medium">{team.total}</span></span>
                    <span className="text-green-400">{team.won}W</span>
                    <span className="text-red-400">{team.lost}L</span>
                    {team.pending > 0 && <span className="text-yellow-400">{team.pending}P</span>}
                    {team.voided > 0 && <span className="text-slate-500">{team.voided}V</span>}
                    <span className="text-slate-500">Win rate <span className="text-white font-medium">{team.winRate}%</span></span>
                    <span className={profitLossColor(team.pl)}>P&L {formatCurrency(team.pl)}</span>
                  </div>
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
            {leaderboard.map((member, i) => {
              const isMe = member.id === user?.id
              const noActivity = member.total === 0
              return (
                <Link
                  key={member.id}
                  to={`/profile/${member.id}`}
                  className={`flex items-center gap-4 bg-slate-800 rounded-lg border p-4 hover:border-slate-500 transition-colors ${
                    isMe ? 'border-green-500/40' : 'border-slate-700'
                  } ${noActivity ? 'opacity-50' : ''}`}
                >
                  <div className={`text-xl font-bold w-7 text-center shrink-0 ${RANK_COLORS[i] ?? 'text-slate-600'}`}>
                    {i + 1}
                  </div>
                  <div className="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center text-base font-bold text-slate-300 shrink-0">
                    {(member.full_name || member.username)[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-white text-sm">{member.full_name || member.username}</span>
                      {isMe && <span className="text-xs text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">You</span>}
                    </div>
                    {member.total > 0 ? (
                      <div className="flex gap-2 text-xs text-slate-400 mt-0.5 flex-wrap">
                        <span>{member.total} bets</span>
                        <span className="text-green-400">{member.won}W</span>
                        <span className="text-red-400">{member.lost}L</span>
                        {member.pending > 0 && <span className="text-yellow-400">{member.pending}P</span>}
                        {member.voided > 0 && <span className="text-slate-500">{member.voided}V</span>}
                        <span>· ${member.staked.toFixed(2)} staked</span>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500 mt-0.5">No bets yet</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-base font-bold ${activeSortOpt.color(member)}`}>
                      {activeSortOpt.format(member)}
                    </div>
                    {sortKey !== 'winnings' && (
                      <div className="text-xs text-slate-500">Won ${member.winnings.toFixed(2)}</div>
                    )}
                    {sortKey !== 'pl' && (
                      <div className={`text-xs ${profitLossColor(member.pl)}`}>P&L {formatCurrency(member.pl)}</div>
                    )}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
