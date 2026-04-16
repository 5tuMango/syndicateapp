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
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const [betsRes, membersRes, teamsRes] = await Promise.all([
      supabase.from('bets').select('user_id, stake, odds, outcome'),
      supabase.from('profiles').select('id, username, full_name, team_id').order('full_name'),
      supabase.from('teams').select('*').order('created_at'),
    ])
    setBets(betsRes.data || [])
    setMembers(membersRes.data || [])
    setTeams(teamsRes.data || [])
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
        const winnings = mb.filter((b) => b.outcome === 'won').reduce((sum, b) => sum + parseFloat(b.stake) * parseFloat(b.odds), 0)
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
          winnings,
        }
      })
      .sort((a, b) => b.winnings - a.winnings)
  }, [bets, members])

  const teamLeaderboard = useMemo(() => {
    return teams.map((team) => {
      const teamMembers = members.filter((m) => m.team_id === team.id)
      const memberIds = new Set(teamMembers.map((m) => m.id))
      const teamBets = bets.filter((b) => memberIds.has(b.user_id))
      const resolved = teamBets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void')
      const won = teamBets.filter((b) => b.outcome === 'won').length
      const lost = teamBets.filter((b) => b.outcome === 'lost').length
      const pl = teamBets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
      const staked = teamBets.filter((b) => b.outcome !== 'void').reduce((sum, b) => sum + parseFloat(b.stake), 0)
      const winnings = teamBets.filter((b) => b.outcome === 'won').reduce((sum, b) => sum + parseFloat(b.stake) * parseFloat(b.odds), 0)
      return {
        ...team,
        memberCount: teamMembers.length,
        total: teamBets.length,
        won,
        lost,
        winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0,
        pl,
        staked,
        winnings,
      }
    }).sort((a, b) => b.winnings - a.winnings)
  }, [bets, members, teams])

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
          { label: 'Group Staked', value: `$${groupStats.staked.toFixed(2)}`, color: 'text-white' },
          { label: 'Group P&L', value: formatCurrency(groupStats.pl), color: profitLossColor(groupStats.pl) },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <p className="text-slate-400 text-xs uppercase tracking-wide">{label}</p>
            <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Team leaderboard */}
      {teamLeaderboard.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">Team Standings</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {teamLeaderboard.map((team, i) => {
              const isLeading = i === 0 && teamLeaderboard.length > 1 && team.pl !== teamLeaderboard[1].pl
              return (
                <div
                  key={team.id}
                  className={`bg-slate-800 rounded-lg border p-4 space-y-3 ${
                    isLeading ? 'border-yellow-500/30' : 'border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {isLeading && <span>🏆</span>}
                      <span className="font-bold text-white">{team.name}</span>
                      <span className="text-xs text-slate-500">{team.memberCount} members</span>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold text-white">${team.winnings.toFixed(2)}</div>
                      <div className={`text-xs ${profitLossColor(team.pl)}`}>P&L {formatCurrency(team.pl)}</div>
                    </div>
                  </div>
                  <div className="flex gap-4 text-sm">
                    <div>
                      <span className="text-slate-500 text-xs">Bets </span>
                      <span className="text-white font-medium">{team.total}</span>
                    </div>
                    <div>
                      <span className="text-green-400">{team.won}W</span>
                      <span className="text-slate-600 mx-1">/</span>
                      <span className="text-red-400">{team.lost}L</span>
                    </div>
                    <div>
                      <span className="text-slate-500 text-xs">Win rate </span>
                      <span className="text-white font-medium">{team.winRate}%</span>
                    </div>
                    <div>
                      <span className="text-slate-500 text-xs">Staked </span>
                      <span className="text-white font-medium">${team.staked.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

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

                {/* Winnings + P&L */}
                <div className="text-right shrink-0">
                  <div className="text-base font-bold text-white">
                    ${member.winnings.toFixed(2)}
                  </div>
                  <div className={`text-xs ${profitLossColor(member.pl)}`}>
                    P&L {formatCurrency(member.pl)}
                  </div>
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
