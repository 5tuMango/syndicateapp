import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { usePersonas } from '../hooks/usePersonas'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { supabase } from '../lib/supabase'
import { calcProfitLoss, calcWinnings, formatCurrency, normalizeMarketType, profitLossColor, SPORTS } from '../lib/utils'

const TABS = ['Overview', 'By Sport', 'Leg Types', 'Multi Bets', 'Risk Profile', 'Weekly']

// One colour per member (up to 10)
const LINE_COLORS = [
  '#22c55e', '#3b82f6', '#a855f7', '#f59e0b',
  '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#8b5cf6',
]

export default function Insights() {
  const { byUserId: personaMap, byPersonaId } = usePersonas()
  const [bets, setBets] = useState([])
  const [members, setMembers] = useState([])
  const [weeklyMultis, setWeeklyMultis] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState(0)

  useEffect(() => {
    async function fetchData() {
      const [betsRes, membersRes, weeklyRes] = await Promise.all([
        supabase
          .from('bets')
          .select('*, bet_legs(*)')
          .order('date', { ascending: true })
          .order('created_at', { ascending: true }),
        supabase.from('profiles').select('id, username, full_name').order('full_name'),
        supabase
          .from('weekly_multis')
          .select('*, weekly_multi_legs(*)')
          .order('created_at', { ascending: true }),
      ])
      setBets(betsRes.data || [])
      setMembers(membersRes.data || [])
      setWeeklyMultis(weeklyRes.data || [])
      setLoading(false)
    }
    fetchData()
  }, [])

  // Resolve the effective member ID for a bet — persona_id takes priority over user_id
  const betMemberId = (bet) => {
    if (bet.persona_id && byPersonaId[bet.persona_id]?.claimed_by) {
      return byPersonaId[bet.persona_id].claimed_by
    }
    return bet.user_id
  }

  // ── Total winnings (payout from won bets + weekly multis) ────────────────
  const totalWinnings = useMemo(() => {
    const indiv = bets.reduce((sum, b) => sum + calcWinnings(b), 0)
    const weekly = weeklyMultis.reduce((sum, m) => {
      const legs = m.weekly_multi_legs || []
      const nonVoid = legs.filter(l => l.outcome !== 'void')
      if (nonVoid.length === 0 || nonVoid.some(l => l.outcome === 'pending') || nonVoid.some(l => l.outcome === 'lost')) return sum
      const validLegs = legs.filter(l => l.odds != null && parseFloat(l.odds) > 0)
      const combo = validLegs.reduce((acc, l) => acc * parseFloat(l.odds), 1)
      return sum + parseFloat(m.stake || 0) * combo
    }, 0)
    return indiv + weekly
  }, [bets, weeklyMultis])

  // ── Cumulative P&L + cumulative winnings chart data ───────────────────────
  const pnlChartData = useMemo(() => {
    const resolved = bets.filter((b) => b.outcome !== 'pending')

    // Compute resolved weekly multi winnings keyed by date
    const weeklyWinByDate = {}
    for (const m of weeklyMultis) {
      const legs = m.weekly_multi_legs || []
      const nonVoid = legs.filter(l => l.outcome !== 'void')
      if (nonVoid.length === 0 || nonVoid.some(l => l.outcome === 'pending') || nonVoid.some(l => l.outcome === 'lost')) continue
      const validLegs = legs.filter(l => l.odds != null && parseFloat(l.odds) > 0)
      const combo = validLegs.reduce((acc, l) => acc * parseFloat(l.odds), 1)
      const date = (m.created_at || '').slice(0, 10)
      weeklyWinByDate[date] = (weeklyWinByDate[date] || 0) + parseFloat(m.stake || 0) * combo
    }

    const allDates = [...new Set([
      ...resolved.map(b => b.date),
      ...Object.keys(weeklyWinByDate),
    ])].sort()

    let runningPL = 0
    let runningWinnings = 0
    return allDates.map((date) => {
      resolved.filter((b) => b.date === date).forEach((b) => {
        runningPL += calcProfitLoss(b)
        runningWinnings += calcWinnings(b)
      })
      runningWinnings += weeklyWinByDate[date] || 0
      return {
        date: formatChartDate(date),
        __winnings: parseFloat(runningWinnings.toFixed(2)),
        __pl: parseFloat(runningPL.toFixed(2)),
      }
    })
  }, [bets, weeklyMultis, members, byPersonaId])

  // ── Strike rate table (7d / 30d / all-time) ───────────────────────────────
  const strikeRates = useMemo(() => {
    const now = new Date()
    const cutoffs = {
      '7d': new Date(now - 7 * 864e5).toISOString().slice(0, 10),
      '30d': new Date(now - 30 * 864e5).toISOString().slice(0, 10),
      all: '1970-01-01',
    }
    return members.map((m) => {
      const mb = bets.filter((b) => betMemberId(b) === m.id)
      const rates = {}
      for (const [label, cutoff] of Object.entries(cutoffs)) {
        const period = mb.filter((b) => b.date >= cutoff && b.outcome !== 'void')
        const resolved = period.filter((b) => b.outcome !== 'pending')
        const won = resolved.filter((b) => b.outcome === 'won').length
        rates[label] = resolved.length ? Math.round((won / resolved.length) * 100) : null
      }
      // Days since last win
      const lastWin = mb
        .filter((b) => b.outcome === 'won')
        .sort((a, b) => b.date.localeCompare(a.date))[0]
      const daysSinceWin = lastWin
        ? Math.floor((now - new Date(lastWin.date + 'T00:00:00')) / 864e5)
        : null
      return { ...m, ...rates, daysSinceWin }
    })
  }, [bets, members, byPersonaId])

  // ── Win rate by sport — based on individual legs (includes multi legs) ──────
  const bySport = useMemo(() => {
    // Collect all resolved legs with their sport (leg.sport takes priority, fall back to parent bet.sport)
    const resolvedLegs = bets.flatMap((b) => {
      const legs = b.bet_legs || []
      if (legs.length > 0) {
        return legs
          .filter((l) => l.outcome === 'won' || l.outcome === 'lost')
          .map((l) => ({ sport: l.sport || b.sport, outcome: l.outcome, user_id: betMemberId(b) }))
      }
      // Single bets with no legs — use the bet itself
      if (b.outcome === 'won' || b.outcome === 'lost') {
        return [{ sport: b.sport, outcome: b.outcome, user_id: betMemberId(b) }]
      }
      return []
    })

    const usedSports = [...new Set(resolvedLegs.map((l) => l.sport).filter(Boolean))].sort()

    return {
      usedSports,
      byMember: members.map((m) => {
        const myLegs = resolvedLegs.filter((l) => l.user_id === m.id)
        const sportRows = usedSports.map((sport) => {
          const legs = myLegs.filter((l) => l.sport === sport)
          if (legs.length === 0) return { sport, w: 0, l: 0, rate: null }
          const won = legs.filter((l) => l.outcome === 'won').length
          return { sport, w: won, l: legs.length - won, rate: Math.round((won / legs.length) * 100) }
        }).filter((r) => r.w + r.l > 0)
        return { member: m, sportRows }
      }),
    }
  }, [bets, members, byPersonaId])

  // ── Multi bet stats ───────────────────────────────────────────────────────
  const multiStats = useMemo(() => {
    return members.map((m) => {
      const multis = bets.filter((b) => betMemberId(b) === m.id && b.bet_type === 'multi')
      const resolved = multis.filter((b) => b.outcome === 'won' || b.outcome === 'lost')
      const won = resolved.filter((b) => b.outcome === 'won').length

      // "Lost by 1 leg" = multi where exactly one leg is lost and the rest won
      const lostBy1 = multis.filter((b) => {
        const legs = b.bet_legs || []
        const nonVoid = legs.filter((l) => l.outcome !== 'void')
        const lost = nonVoid.filter((l) => l.outcome === 'lost').length
        return b.outcome === 'lost' && lost === 1
      }).length

      // Leg win rate across all multi legs
      const allLegs = multis.flatMap((b) => b.bet_legs || []).filter((l) => l.outcome !== 'void' && l.outcome !== 'pending')
      const legsWon = allLegs.filter((l) => l.outcome === 'won').length

      // Avg legs per multi
      const legCounts = multis.map((b) => (b.bet_legs || []).length)
      const avgLegs = legCounts.length ? (legCounts.reduce((s, n) => s + n, 0) / legCounts.length).toFixed(1) : '—'

      return {
        member: m,
        total: multis.length,
        won,
        lost: resolved.length - won,
        pending: multis.filter((b) => b.outcome === 'pending').length,
        lostBy1,
        legWinRate: allLegs.length ? Math.round((legsWon / allLegs.length) * 100) : null,
        avgLegs,
        pl: multis.reduce((s, b) => s + calcProfitLoss(b), 0),
      }
    })
  }, [bets, members, byPersonaId])

  // ── Risk profile ─────────────────────────────────────────────────────────
  const riskProfiles = useMemo(() => {
    return members.map((m) => {
      const mb = bets.filter((b) => betMemberId(b) === m.id && b.outcome !== 'void')
      if (mb.length === 0) return { member: m, empty: true }
      const avgOdds = mb.reduce((s, b) => s + parseFloat(b.odds), 0) / mb.length
      const avgStake = mb.reduce((s, b) => s + parseFloat(b.stake), 0) / mb.length
      const totalStaked = mb.reduce((s, b) => s + parseFloat(b.stake), 0)
      const sumStakeOdds = mb.reduce((s, b) => s + parseFloat(b.stake) * parseFloat(b.odds), 0)
      // Bet Boldness: avg(stake × odds) per bet — rewards big stakes + long odds
      const betBoldness = mb.length > 0 ? sumStakeOdds / mb.length : 0
      // Risk Profile: stake-weighted avg odds — pure measure of selection risk
      const riskProfile = totalStaked > 0 ? sumStakeOdds / totalStaked : 0
      const pctMulti = Math.round((mb.filter((b) => b.bet_type === 'multi').length / mb.length) * 100)
      const resolved = mb.filter((b) => b.outcome === 'won' || b.outcome === 'lost')
      const winRate = resolved.length ? Math.round((resolved.filter((b) => b.outcome === 'won').length / resolved.length) * 100) : null
      const bestWin = mb
        .filter((b) => b.outcome === 'won')
        .reduce((best, b) => Math.max(best, calcProfitLoss(b)), 0)

      // Stake vs odds correlation: bucket bets into odds ranges, show avg stake per bucket
      const oddsRanges = [
        { label: '1.01–1.5', min: 1.01, max: 1.5 },
        { label: '1.51–3.0', min: 1.51, max: 3.0 },
        { label: '3.01–10', min: 3.01, max: 10 },
        { label: '10+', min: 10.01, max: Infinity },
      ]
      const stakeByOdds = oddsRanges.map(({ label, min, max }) => {
        const group = mb.filter((b) => {
          const o = parseFloat(b.odds)
          return o >= min && o <= max
        })
        if (group.length === 0) return { label, avgStake: null, count: 0 }
        const avg = group.reduce((s, b) => s + parseFloat(b.stake), 0) / group.length
        return { label, avgStake: avg, count: group.length }
      }).filter((r) => r.count > 0)

      return { member: m, avgOdds, avgStake, pctMulti, winRate, bestWin, stakeByOdds, betBoldness, riskProfile, empty: false }
    })
  }, [bets, members, byPersonaId])

  // ── Leg type win rates ────────────────────────────────────────────────────
  const legTypeStats = useMemo(() => {
    // Collect all resolved legs with their parent bet's user_id
    const resolvedLegs = bets.flatMap((b) =>
      (b.bet_legs || [])
        .filter((l) => l.outcome === 'won' || l.outcome === 'lost')
        .map((l) => ({ ...l, user_id: betMemberId(b) }))
    )

    // Get unique market types (normalised descriptions)
    const marketTypes = [...new Set(resolvedLegs.map((l) => normalizeMarketType(l.description)).filter(Boolean))].sort()

    return {
      marketTypes,
      byMember: members.map((m) => {
        const myLegs = resolvedLegs.filter((l) => l.user_id === m.id)
        const rows = marketTypes.map((mt) => {
          const legs = myLegs.filter((l) => normalizeMarketType(l.description) === mt)
          if (legs.length === 0) return { mt, w: 0, l: 0, rate: null }
          const won = legs.filter((l) => l.outcome === 'won').length
          return { mt, w: won, l: legs.length - won, rate: Math.round((won / legs.length) * 100) }
        }).filter((r) => r.w + r.l > 0)
        return { member: m, rows }
      }),
    }
  }, [bets, members, byPersonaId])

  // ── Weekly multi insights ─────────────────────────────────────────────────
  const TOTAL_WEEKS = 33

  const weeklyInsights = useMemo(() => {
    // Build a lookup: week number → multi object (parse "Week N" from label)
    const multiByWeek = {}
    for (const m of weeklyMultis) {
      const match = m.week_label?.match(/Week\s+(\d+)/i)
      if (match) multiByWeek[parseInt(match[1])] = m
    }

    // Fixed 33-week slots
    const slots = Array.from({ length: TOTAL_WEEKS }, (_, i) => ({
      weekNum: i + 1,
      multi: multiByWeek[i + 1] || null,
    }))

    // For each member, result per slot
    const memberStats = members.map((m) => {
      const weekResults = slots.map(({ multi }) => {
        if (!multi) return null
        const leg = (multi.weekly_multi_legs || []).find((l) =>
          l.assigned_user_id === m.id ||
          (l.persona_id && byPersonaId[l.persona_id]?.claimed_by === m.id)
        )
        if (!leg) return null
        return { outcome: leg.outcome, odds: leg.odds ? parseFloat(leg.odds) : null }
      })

      const resolvedLegs = weekResults.filter((r) => r && (r.outcome === 'won' || r.outcome === 'lost'))
      const won = resolvedLegs.filter((r) => r.outcome === 'won').length
      const oddsEntries = weekResults.filter((r) => r && r.odds != null)
      const avgOdds = oddsEntries.length > 0
        ? oddsEntries.reduce((s, r) => s + r.odds, 0) / oddsEntries.length
        : null
      const winPct = resolvedLegs.length > 0 ? Math.round((won / resolvedLegs.length) * 100) : null

      return { member: m, weekResults, avgOdds, winPct, won, lost: resolvedLegs.length - won, total: resolvedLegs.length }
    })

    return { slots, memberStats }
  }, [weeklyMultis, members, byPersonaId])

  if (loading) {
    return <div className="text-center text-slate-400 py-16">Loading…</div>
  }

  const noData = bets.length === 0

  const displayName = (m) => {
    const p = personaMap[m.id]
    return p ? `${p.emoji} ${p.nickname}` : (m.full_name || m.username)
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Insights</h1>
        <p className="text-slate-400 text-sm mt-0.5">Deep analytics across the syndicate</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-slate-800/60 rounded-lg border border-slate-700 p-1 overflow-x-auto">
        {TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => setTab(i)}
            className={`shrink-0 px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
              tab === i ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {noData ? (
        <div className="text-center text-slate-400 py-16">No resolved bets yet — check back after some results come in.</div>
      ) : (
        <>
          {/* ── Tab 0: Overview ────────────────────────────────────────────── */}
          {tab === 0 && (
            <div className="space-y-6">
              {/* Hero: Total Winnings */}
              <div className="bg-slate-800 rounded-xl border border-slate-700 p-6 text-center">
                <p className="text-slate-400 text-xs uppercase tracking-widest mb-2">Total Winnings</p>
                <p className="text-5xl font-bold text-green-400">{formatCurrency(totalWinnings)}</p>
                <p className="text-slate-500 text-xs mt-2">Sum of all payouts from winning bets</p>
              </div>

              <Section title="Cumulative Winnings & P&L Over Time">
                {pnlChartData.length < 2 ? (
                  <p className="text-slate-500 text-sm py-4 text-center">Not enough resolved bets for a trend yet.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={pnlChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                      <YAxis
                        tick={{ fill: '#94a3b8', fontSize: 11 }}
                        tickFormatter={(v) => `$${v}`}
                        width={55}
                      />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                        labelStyle={{ color: '#e2e8f0' }}
                        formatter={(v, name) => {
                          if (name === '__winnings') return [formatCurrency(v), 'Cumulative Winnings']
                          if (name === '__pl') return [formatCurrency(v), 'Cumulative P&L']
                          return [formatCurrency(v), name]
                        }}
                      />
                      <Legend
                        formatter={(value) => {
                          if (value === '__winnings') return <span style={{ color: '#4ade80', fontSize: 12 }}>Cumulative Winnings</span>
                          if (value === '__pl') return <span style={{ color: '#818cf8', fontSize: 12 }}>Cumulative P&L</span>
                          return value
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="__winnings"
                        stroke="#4ade80"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="__pl"
                        stroke="#818cf8"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </Section>

              <Section title="Strike Rates">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-400 text-xs uppercase tracking-wide border-b border-slate-700">
                        <th className="pb-2 pr-4">Member</th>
                        <th className="pb-2 pr-4 text-right">Last 7d</th>
                        <th className="pb-2 pr-4 text-right">Last 30d</th>
                        <th className="pb-2 pr-4 text-right">All Time</th>
                        <th className="pb-2 text-right">Last Win</th>
                      </tr>
                    </thead>
                    <tbody>
                      {strikeRates.map((row) => (
                        <tr key={row.id} className="border-b border-slate-700/50">
                          <td className="py-2 pr-4 text-white font-medium">{displayName(row)}</td>
                          <td className="py-2 pr-4 text-right">{rateCell(row['7d'])}</td>
                          <td className="py-2 pr-4 text-right">{rateCell(row['30d'])}</td>
                          <td className="py-2 pr-4 text-right">{rateCell(row['all'])}</td>
                          <td className="py-2 text-right">
                            {row.daysSinceWin === null
                              ? <span className="text-slate-600">—</span>
                              : row.daysSinceWin === 0
                              ? <span className="text-green-400 font-semibold">Today</span>
                              : row.daysSinceWin === 1
                              ? <span className="text-green-400">Yesterday</span>
                              : <span className={row.daysSinceWin > 14 ? 'text-red-400' : row.daysSinceWin > 7 ? 'text-yellow-400' : 'text-slate-300'}>{row.daysSinceWin}d ago</span>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </div>
          )}

          {/* ── Tab 1: By Sport ────────────────────────────────────────────── */}
          {tab === 1 && (
            <div className="space-y-4">
              <p className="text-slate-500 text-xs">Win rate based on individual legs (including legs within multis), grouped by sport.</p>
              {bySport.byMember.map(({ member, sportRows }) => (
                <div key={member.id} className="bg-slate-800 rounded-lg border border-slate-700 p-4">
                  <p className="text-white font-semibold mb-3">{displayName(member)}</p>
                  {sportRows.length === 0 ? (
                    <p className="text-slate-500 text-sm">No resolved legs yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-slate-400 text-xs uppercase tracking-wide border-b border-slate-700">
                            <th className="pb-2 pr-4">Sport</th>
                            <th className="pb-2 pr-4 text-right">W</th>
                            <th className="pb-2 pr-4 text-right">L</th>
                            <th className="pb-2 pr-4 text-right">Total Legs</th>
                            <th className="pb-2 text-right">Win Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sportRows.sort((a, b) => (b.w + b.l) - (a.w + a.l)).map((r) => (
                            <tr key={r.sport} className="border-b border-slate-700/50">
                              <td className="py-2 pr-4 text-slate-200">{r.sport}</td>
                              <td className="py-2 pr-4 text-right text-green-400">{r.w}</td>
                              <td className="py-2 pr-4 text-right text-red-400">{r.l}</td>
                              <td className="py-2 pr-4 text-right text-slate-400">{r.w + r.l}</td>
                              <td className="py-2 text-right">{rateCell(r.rate)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Tab 2: Leg Types ───────────────────────────────────────────── */}
          {tab === 2 && (
            <div className="space-y-4">
              {legTypeStats.byMember.map(({ member, rows }) => (
                <div key={member.id} className="bg-slate-800 rounded-lg border border-slate-700 p-4">
                  <p className="text-white font-semibold mb-3">{displayName(member)}</p>
                  {rows.length === 0 ? (
                    <p className="text-slate-500 text-sm">No resolved leg data yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-slate-400 text-xs uppercase tracking-wide border-b border-slate-700">
                            <th className="pb-2 pr-4">Market Type</th>
                            <th className="pb-2 pr-4 text-right">W</th>
                            <th className="pb-2 pr-4 text-right">L</th>
                            <th className="pb-2 pr-4 text-right">Total</th>
                            <th className="pb-2 text-right">Win Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.sort((a, b) => (b.w + b.l) - (a.w + a.l)).map((r) => (
                            <tr key={r.mt} className="border-b border-slate-700/50">
                              <td className="py-2 pr-4 text-slate-200">{r.mt}</td>
                              <td className="py-2 pr-4 text-right text-green-400">{r.w}</td>
                              <td className="py-2 pr-4 text-right text-red-400">{r.l}</td>
                              <td className="py-2 pr-4 text-right text-slate-400">{r.w + r.l}</td>
                              <td className="py-2 text-right">{rateCell(r.rate)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Tab 3: Multi Bets ──────────────────────────────────────────── */}
          {tab === 3 && (
            <div className="space-y-4">
              {multiStats.map((row) => (
                <div key={row.member.id} className="bg-slate-800 rounded-lg border border-slate-700 p-4">
                  <p className="text-white font-semibold mb-3">{displayName(row.member)}</p>
                  {row.total === 0 ? (
                    <p className="text-slate-500 text-sm">No multi bets placed.</p>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <Stat label="Multis" value={row.total} />
                      <Stat label="W / L" value={`${row.won} / ${row.lost}`} />
                      <Stat label="Pending" value={row.pending} />
                      <Stat label="P&L" value={formatCurrency(row.pl)} color={profitLossColor(row.pl)} />
                      <Stat label="Avg Legs" value={row.avgLegs} />
                      <Stat
                        label="Leg Win Rate"
                        value={row.legWinRate !== null ? `${row.legWinRate}%` : '—'}
                        color={row.legWinRate !== null ? rateColor(row.legWinRate) : 'text-slate-400'}
                      />
                      <Stat
                        label="Lost by 1 Leg"
                        value={row.lostBy1}
                        color={row.lostBy1 > 0 ? 'text-red-400' : 'text-slate-400'}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Tab 4: Risk Profile ────────────────────────────────────────── */}
          {tab === 4 && (
            <div className="space-y-4">
              {riskProfiles.map((row) => (
                <div key={row.member.id} className="bg-slate-800 rounded-lg border border-slate-700 p-4">
                  <p className="text-white font-semibold mb-3">{displayName(row.member)}</p>
                  {row.empty ? (
                    <p className="text-slate-500 text-sm">No bets yet.</p>
                  ) : (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <Stat label="Boldness" value={row.betBoldness > 0 ? row.betBoldness.toFixed(0) : '—'} color="text-orange-400" />
                        <Stat label="Risk Profile" value={row.riskProfile > 0 ? row.riskProfile.toFixed(2) : '—'} color="text-purple-400" />
                        <Stat label="Avg Odds" value={row.avgOdds.toFixed(2)} />
                        <Stat label="Avg Stake" value={`$${row.avgStake.toFixed(2)}`} />
                        <Stat label="% Multis" value={`${row.pctMulti}%`} />
                        <Stat
                          label="Win Rate"
                          value={row.winRate !== null ? `${row.winRate}%` : '—'}
                          color={row.winRate !== null ? rateColor(row.winRate) : 'text-slate-400'}
                        />
                        <Stat label="Best Win" value={formatCurrency(row.bestWin)} color="text-green-400" />
                      </div>

                      {/* Stake vs Odds correlation */}
                      {row.stakeByOdds.length > 0 && (
                        <div>
                          <p className="text-slate-400 text-xs uppercase tracking-wide mb-2">Avg Stake by Odds Range</p>
                          <div className="space-y-2">
                            {row.stakeByOdds.map((r) => {
                              const maxStake = Math.max(...row.stakeByOdds.map((x) => x.avgStake))
                              const pct = Math.round((r.avgStake / maxStake) * 100)
                              return (
                                <div key={r.label} className="flex items-center gap-3">
                                  <span className="text-slate-400 text-xs w-20 shrink-0">{r.label}</span>
                                  <div className="flex-1 bg-slate-700 rounded-full h-2">
                                    <div
                                      className="bg-green-500 h-2 rounded-full"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                  <span className="text-slate-200 text-xs w-16 text-right shrink-0">
                                    ${r.avgStake.toFixed(2)} <span className="text-slate-500">({r.count})</span>
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                          <p className="text-slate-600 text-xs mt-2">Bar width = relative avg stake. Count = number of bets in that range.</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* ── Tab 5: Weekly ─────────────────────────────────────────────── */}
          {tab === 5 && (
            <div className="space-y-4">
              <Section title="Season Results — Week by Week">
                {/* Transposed table: members across top, weeks down left */}
                <div className="overflow-x-auto">
                  <table className="text-sm border-collapse w-full">
                    <thead>
                      {/* Row 1: Member names */}
                      <tr className="border-b border-slate-700">
                        <th className="py-2 pr-3 text-left text-slate-500 text-xs font-medium sticky left-0 bg-slate-800 z-10 whitespace-nowrap w-14">Week</th>
                        {weeklyInsights.memberStats.map(({ member }) => (
                          <th key={member.id} className="py-2 px-2 text-center text-white text-xs font-semibold whitespace-nowrap">
                            {displayName(member)}
                          </th>
                        ))}
                      </tr>
                      {/* Row 2: Avg Odds */}
                      <tr className="border-b border-slate-700/40">
                        <td className="py-1.5 pr-3 text-slate-500 text-xs sticky left-0 bg-slate-800 z-10 whitespace-nowrap">Avg Odds</td>
                        {weeklyInsights.memberStats.map(({ member, avgOdds }) => (
                          <td key={member.id} className="py-1.5 px-2 text-center text-slate-200 text-xs font-medium">
                            {avgOdds != null ? avgOdds.toFixed(2) : <span className="text-slate-700">—</span>}
                          </td>
                        ))}
                      </tr>
                      {/* Row 3: Win % */}
                      <tr className="border-b border-slate-600">
                        <td className="py-1.5 pr-3 text-slate-500 text-xs sticky left-0 bg-slate-800 z-10 whitespace-nowrap">Win %</td>
                        {weeklyInsights.memberStats.map(({ member, winPct }) => (
                          <td key={member.id} className="py-1.5 px-2 text-center text-xs font-semibold">
                            {winPct !== null
                              ? <span className={rateColor(winPct)}>{winPct}%</span>
                              : <span className="text-slate-700">—</span>}
                          </td>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {weeklyInsights.slots.map(({ weekNum, multi }) => (
                        <tr key={weekNum} className="border-b border-slate-700/30">
                          {/* Week number — link if multi exists */}
                          <td className="py-2 pr-3 sticky left-0 bg-slate-800 z-10 whitespace-nowrap">
                            {multi ? (
                              <Link to="/weekly-multi" className="text-purple-400 hover:text-purple-300 text-xs font-semibold transition-colors">
                                W{weekNum}
                              </Link>
                            ) : (
                              <span className="text-slate-700 text-xs">W{weekNum}</span>
                            )}
                          </td>
                          {/* Each member's result for this week */}
                          {weeklyInsights.memberStats.map(({ member, weekResults }) => {
                            const r = weekResults[weekNum - 1]
                            return (
                              <td key={member.id} className="py-2 px-2 text-center">
                                {r === null ? (
                                  <span className="text-slate-800 text-xs">·</span>
                                ) : r.outcome === 'won' ? (
                                  <span className="text-green-400 font-bold">✓</span>
                                ) : r.outcome === 'lost' ? (
                                  <span className="text-red-400 font-bold">✗</span>
                                ) : r.outcome === 'void' ? (
                                  <span className="text-slate-600 text-xs">V</span>
                                ) : (
                                  <span className="text-yellow-500 text-xs">?</span>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-slate-600 text-xs mt-2">✓ won · ✗ lost · ? pending · W# links to Weekly Multi page</p>
              </Section>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div className="bg-slate-800 rounded-xl border border-slate-700 p-4 space-y-3">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{title}</p>
      {children}
    </div>
  )
}

function Stat({ label, value, color = 'text-white' }) {
  return (
    <div className="bg-slate-900/60 rounded-lg p-3">
      <p className="text-slate-400 text-xs uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${color}`}>{value}</p>
    </div>
  )
}

function rateCell(val) {
  if (val === null) return <span className="text-slate-600">—</span>
  return <span className={`font-semibold ${rateColor(val)}`}>{val}%</span>
}

function rateColor(rate) {
  if (rate >= 55) return 'text-green-400'
  if (rate >= 40) return 'text-yellow-400'
  return 'text-red-400'
}

function formatChartDate(dateStr) {
  const [, m, d] = dateStr.split('-')
  return `${parseInt(d)}/${parseInt(m)}`
}
