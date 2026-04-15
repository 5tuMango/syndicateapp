import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import BetCard from '../components/BetCard'
import FilterBar from '../components/FilterBar'
import { calcProfitLoss, formatCurrency, profitLossColor } from '../lib/utils'

export default function Dashboard() {
  const [bets, setBets] = useState([])
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({})

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const [betsRes, membersRes] = await Promise.all([
      supabase
        .from('bets')
        .select('*, profiles(id, username, full_name), bet_legs(*)')
        .order('date', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('profiles').select('id, username, full_name').order('full_name'),
    ])
    setBets(betsRes.data || [])
    setMembers(membersRes.data || [])
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

  const stats = useMemo(() => {
    // Void bets are excluded from staked (stake returned) and win rate (not a resolved bet)
    const resolved = filteredBets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void')
    const won = filteredBets.filter((b) => b.outcome === 'won').length
    const pl = filteredBets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const staked = filteredBets.filter((b) => b.outcome !== 'void').reduce((sum, b) => sum + parseFloat(b.stake), 0)
    return {
      total: filteredBets.length,
      winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0,
      pl,
      staked,
    }
  }, [filteredBets])

  const handleDelete = (id) => setBets((prev) => prev.filter((b) => b.id !== id))

  const handleUpdate = async (betId) => {
    const { data } = await supabase
      .from('bets')
      .select('*, profiles(id, username, full_name), bet_legs(*)')
      .eq('id', betId)
      .single()
    if (data) setBets((prev) => prev.map((b) => (b.id === betId ? data : b)))
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-slate-400 text-sm mt-0.5">All bets across the syndicate</p>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Bets', value: stats.total, color: 'text-white' },
          { label: 'Win Rate', value: `${stats.winRate}%`, color: 'text-white' },
          { label: 'Total Staked', value: `$${stats.staked.toFixed(2)}`, color: 'text-white' },
          {
            label: 'Group P&L',
            value: formatCurrency(stats.pl),
            color: profitLossColor(stats.pl),
          },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <p className="text-slate-400 text-xs uppercase tracking-wide">{label}</p>
            <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <FilterBar filters={filters} onChange={setFilters} members={members} />

      {loading ? (
        <div className="text-center text-slate-400 py-16">Loading bets...</div>
      ) : filteredBets.length === 0 ? (
        <div className="text-center text-slate-400 py-16">
          {Object.values(filters).some(Boolean)
            ? 'No bets match the current filters.'
            : 'No bets yet. Be the first to add one!'}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredBets.map((bet) => (
            <BetCard key={bet.id} bet={bet} onDelete={handleDelete} onUpdate={handleUpdate} />
          ))}
        </div>
      )}
    </div>
  )
}
