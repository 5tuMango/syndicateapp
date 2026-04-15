import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { calcProfitLoss, formatCurrency, profitLossColor } from '../lib/utils'

const RANK_COLORS = ['text-yellow-400', 'text-slate-300', 'text-amber-600']

export default function Leaderboard() {
  const { user } = useAuth()
  const [bets, setBets] = useState([])
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const [betsRes, membersRes] = await Promise.all([
      supabase.from('bets').select('user_id, stake, odds, outcome'),
      supabase.from('profiles').select('id, username, full_name').order('full_name'),
    ])
    setBets(betsRes.data || [])
    setMembers(membersRes.data || [])
    setLoading(false)
  }

  const leaderboard = useMemo(() => {
    return members
      .map((member) => {
        const mb = bets.filter((b) => b.user_id === member.id)
        const resolved = mb.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void')
        const won = mb.filter((b) => b.outcome === 'won').length
        const lost = mb.filter((b) => b.outcome === 'lost').length
        const pending = mb.filter((b) => b.outcome === 'pending').length
        const voided = mb.filter((b) => b.outcome === 'void').length
        const pl = mb.reduce((sum, b) => sum + calcProfitLoss(b), 0)
        const staked = mb.filter((b) => b.outcome !== 'void').reduce((sum, b) => sum + parseFloat(b.stake), 0)
        return {
          ...member,
          total: mb.length,
          won,
          lost,
          pending,
          voided,
          winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0,
          pl,
          staked,
        }
      })
      .sort((a, b) => b.pl - a.pl)
  }, [bets, members])

  const groupStats = useMemo(() => {
    const pl = bets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const staked = bets.reduce((sum, b) => sum + parseFloat(b.stake), 0)
    const resolved = bets.filter((b) => b.outcome !== 'pending')
    const won = bets.filter((b) => b.outcome === 'won').length
    return {
      pl,
      staked,
      winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0,
      total: bets.length,
    }
  }, [bets])

  if (loading) {
    return <div className="text-center text-slate-400 py-16">Loading...</div>
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Leaderboard</h1>
        <p className="text-slate-400 text-sm mt-0.5">Ranked by profit / loss</p>
      </div>

      {/* Group summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Group Bets', value: groupStats.total, color: 'text-white' },
          { label: 'Group Win Rate', value: `${groupStats.winRate}%`, color: 'text-white' },
          {
            label: 'Group Staked',
            value: `$${groupStats.staked.toFixed(2)}`,
            color: 'text-white',
          },
          {
            label: 'Group P&L',
            value: formatCurrency(groupStats.pl),
            color: profitLossColor(groupStats.pl),
          },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <p className="text-slate-400 text-xs uppercase tracking-wide">{label}</p>
            <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

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
                {/* Rank */}
                <div
                  className={`text-xl font-bold w-7 text-center shrink-0 ${
                    RANK_COLORS[i] ?? 'text-slate-600'
                  }`}
                >
                  {i + 1}
                </div>

                {/* Avatar */}
                <div className="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center text-base font-bold text-slate-300 shrink-0">
                  {(member.full_name || member.username)[0].toUpperCase()}
                </div>

                {/* Name + record */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-white text-sm">
                      {member.full_name || member.username}
                    </span>
                    {isMe && (
                      <span className="text-xs text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">
                        You
                      </span>
                    )}
                  </div>
                  {member.total > 0 ? (
                    <div className="flex gap-2 text-xs text-slate-400 mt-0.5 flex-wrap">
                      <span>{member.total} bets</span>
                      <span className="text-green-400">{member.won}W</span>
                      <span className="text-red-400">{member.lost}L</span>
                      {member.pending > 0 && (
                        <span className="text-yellow-400">{member.pending} pending</span>
                      )}
                      {member.voided > 0 && (
                        <span className="text-slate-400">{member.voided} void</span>
                      )}
                      <span>· ${member.staked.toFixed(2)} staked</span>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 mt-0.5">No bets yet</p>
                  )}
                </div>

                {/* P&L + win rate */}
                <div className="text-right shrink-0">
                  <div className={`text-base font-bold ${profitLossColor(member.pl)}`}>
                    {formatCurrency(member.pl)}
                  </div>
                  <div className="text-xs text-slate-400">{member.winRate}% win rate</div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
