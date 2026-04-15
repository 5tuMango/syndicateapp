import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import BetCard from '../components/BetCard'
import FilterBar from '../components/FilterBar'
import { calcProfitLoss, formatCurrency, profitLossColor } from '../lib/utils'

export default function Profile() {
  const { id } = useParams()
  const { user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [bets, setBets] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({})

  const isOwn = user?.id === id

  useEffect(() => {
    setBets([])
    setFilters({})
    setLoading(true)
    fetchData()
  }, [id])

  async function fetchData() {
    const [profileRes, betsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', id).single(),
      supabase
        .from('bets')
        .select('*, profiles(id, username, full_name), bet_legs(*)')
        .eq('user_id', id)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false }),
    ])
    setProfile(profileRes.data)
    setBets(betsRes.data || [])
    setLoading(false)
  }

  const filteredBets = useMemo(() => {
    return bets.filter((bet) => {
      if (filters.sport && bet.sport !== filters.sport) return false
      if (filters.bet_type && bet.bet_type !== filters.bet_type) return false
      if (filters.outcome && bet.outcome !== filters.outcome) return false
      if (filters.date_from && bet.date < filters.date_from) return false
      if (filters.date_to && bet.date > filters.date_to) return false
      return true
    })
  }, [bets, filters])

  const stats = useMemo(() => {
    const resolved = bets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void')
    const won = bets.filter((b) => b.outcome === 'won').length
    const pl = bets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const staked = bets.filter((b) => b.outcome !== 'void').reduce((sum, b) => sum + parseFloat(b.stake), 0)
    return {
      total: bets.length,
      won,
      lost: bets.filter((b) => b.outcome === 'lost').length,
      pending: bets.filter((b) => b.outcome === 'pending').length,
      winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0,
      pl,
      staked,
    }
  }, [bets])

  const handleDelete = (deletedId) => setBets((p) => p.filter((b) => b.id !== deletedId))

  const handleUpdate = async (betId) => {
    const { data } = await supabase
      .from('bets')
      .select('*, profiles(id, username, full_name), bet_legs(*)')
      .eq('id', betId)
      .single()
    if (data) setBets((p) => p.map((b) => (b.id === betId ? data : b)))
  }

  if (loading) {
    return <div className="text-center text-slate-400 py-16">Loading...</div>
  }

  if (!profile) {
    return <div className="text-center text-slate-400 py-16">Member not found.</div>
  }

  const displayName = profile.full_name || profile.username

  return (
    <div className="space-y-5">
      {/* Profile header */}
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-green-500/20 border-2 border-green-500/30 flex items-center justify-center text-xl font-bold text-green-400 shrink-0">
          {displayName[0].toUpperCase()}
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">{displayName}</h1>
          <p className="text-slate-400 text-sm">
            {isOwn ? 'Your profile' : `@${profile.username}`}
          </p>
        </div>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Bets', value: stats.total, color: 'text-white' },
          { label: 'Win Rate', value: `${stats.winRate}%`, color: 'text-white' },
          { label: 'Total Staked', value: `$${stats.staked.toFixed(2)}`, color: 'text-white' },
          { label: 'P&L', value: formatCurrency(stats.pl), color: profitLossColor(stats.pl) },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <p className="text-slate-400 text-xs uppercase tracking-wide">{label}</p>
            <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* W / L / Pending breakdown */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Won', value: stats.won, color: 'text-green-400' },
          { label: 'Lost', value: stats.lost, color: 'text-red-400' },
          { label: 'Pending', value: stats.pending, color: 'text-yellow-400' },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            className="bg-slate-800 rounded-lg border border-slate-700 p-4 text-center"
          >
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
            <p className="text-slate-400 text-xs mt-1">{label}</p>
          </div>
        ))}
      </div>

      <FilterBar filters={filters} onChange={setFilters} />

      {filteredBets.length === 0 ? (
        <div className="text-center text-slate-400 py-16">
          {bets.length === 0
            ? isOwn
              ? "You haven't placed any bets yet."
              : `${displayName} hasn't placed any bets yet.`
            : 'No bets match the current filters.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredBets.map((bet) => (
            <BetCard key={bet.id} bet={bet} onDelete={handleDelete} onUpdate={handleUpdate} showMember={false} />
          ))}
        </div>
      )}
    </div>
  )
}
