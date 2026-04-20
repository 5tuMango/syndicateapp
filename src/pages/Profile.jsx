import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import BetCard from '../components/BetCard'
import FilterBar from '../components/FilterBar'
import { calcProfitLoss, formatCurrency, profitLossColor, sortBetsByActivity, isRealStake } from '../lib/utils'

export default function Profile() {
  const { id } = useParams()
  const { user, profile: authProfile } = useAuth()
  const [profile, setProfile] = useState(null)
  const [persona, setPersona] = useState(null)
  const [bets, setBets] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({})
  const [tab, setTab] = useState('bets')

  // Kitty editing
  const [editingKitty, setEditingKitty] = useState(false)
  const [kittyForm, setKittyForm] = useState({ amount_paid: '', penalties_paid: '' })
  const [savingKitty, setSavingKitty] = useState(false)
  const [kittyMsg, setKittyMsg] = useState(null)
  const [kittyBalance, setKittyBalance] = useState(null) // full group balance
  const [numPunters, setNumPunters] = useState(8)
  const [stillOwedTotal, setStillOwedTotal] = useState(0)

  const isOwn = user?.id === id
  const isAdmin = authProfile?.is_admin
  const canEditKitty = isOwn || isAdmin

  useEffect(() => {
    setBets([])
    setFilters({})
    setLoading(true)
    fetchData()
  }, [id])

  async function fetchData() {
    const [profileRes, personaRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', id).single(),
      supabase.from('personas').select('*').eq('claimed_by', id).maybeSingle(),
    ])
    setProfile(profileRes.data)
    setPersona(personaRes.data)

    const p = personaRes.data

    let query = supabase
      .from('bets')
      .select('*, profiles(id, username, full_name), bet_legs(*)')

    if (p) {
      query = query.or(`and(user_id.eq.${id},persona_id.is.null),persona_id.eq.${p.id}`)
    } else {
      query = query.eq('user_id', id).is('persona_id', null)
    }

    const betsRes = await query
    const seen = new Set()
    const unique = (betsRes.data || []).filter(b => {
      if (seen.has(b.id)) return false
      seen.add(b.id)
      return true
    })
    setBets(sortBetsByActivity(unique))

    // Fetch kitty balance data
    const [allPersonasRes, allBetsRes, weeklyRes, kittySettingsRes] = await Promise.all([
      supabase.from('personas').select('amount_paid, penalties_paid, contribution_target'),
      supabase.from('bets').select('stake, odds, outcome, is_bonus_bet, intend_to_rollover, is_rollover'),
      supabase.from('weekly_multis').select('stake, weekly_multi_legs(outcome, odds)'),
      supabase.from('kitty_settings').select('unattributed_funds').eq('id', 1).maybeSingle(),
    ])
    const allPersonas = allPersonasRes.data || []
    const allBets = allBetsRes.data || []
    const weeklyMultis = weeklyRes.data || []
    const unattributed = parseFloat(kittySettingsRes.data?.unattributed_funds || 0)

    const totalPaid = allPersonas.reduce((s, p) => s + parseFloat(p.amount_paid || 0) + parseFloat(p.penalties_paid || 0), 0)
    const settledPL = allBets.reduce((s, b) => {
      const stake = parseFloat(b.stake), odds = parseFloat(b.odds)
      if (b.outcome === 'won') return s + stake * (odds - 1)
      if (b.outcome === 'lost') return s + (b.is_bonus_bet ? 0 : -stake)
      return s
    }, 0)
    const pendingStakes = allBets.filter(b => b.outcome === 'pending' && !b.is_bonus_bet).reduce((s, b) => s + parseFloat(b.stake), 0)
    const weeklyPL = weeklyMultis.reduce((s, m) => {
      const legs = m.weekly_multi_legs || []
      const nonVoid = legs.filter(l => l.outcome !== 'void')
      if (nonVoid.length === 0 || nonVoid.some(l => l.outcome === 'pending')) return s
      if (nonVoid.some(l => l.outcome === 'lost')) return s - parseFloat(m.stake || 0)
      const combo = legs.filter(l => l.odds != null).reduce((acc, l) => acc * parseFloat(l.odds), 1)
      return s + parseFloat(m.stake || 0) * (combo - 1)
    }, 0)
    const pendingWeeklyStakes = weeklyMultis.filter(m => {
      const legs = m.weekly_multi_legs || []
      const nonVoid = legs.filter(l => l.outcome !== 'void')
      return nonVoid.length === 0 || nonVoid.some(l => l.outcome === 'pending')
    }).reduce((s, m) => s + parseFloat(m.stake || 0), 0)

    const balance = totalPaid + unattributed + settledPL + weeklyPL - pendingStakes - pendingWeeklyStakes
    const owedByAll = allPersonas.reduce((s, p) => s + Math.max(0, parseFloat(p.contribution_target || 400) - parseFloat(p.amount_paid || 0)), 0)
    setKittyBalance(balance)
    setStillOwedTotal(owedByAll)
    setNumPunters(allPersonas.length || 8)
    setLoading(false)
  }

  const filteredBets = useMemo(() => {
    return sortBetsByActivity(bets.filter((bet) => {
      if (filters.sport && bet.sport !== filters.sport) return false
      if (filters.bet_type && bet.bet_type !== filters.bet_type) return false
      if (filters.outcome && bet.outcome !== filters.outcome) return false
      if (filters.date_from && bet.date < filters.date_from) return false
      if (filters.date_to && bet.date > filters.date_to) return false
      return true
    }))
  }, [bets, filters])

  const stats = useMemo(() => {
    const resolved = bets.filter((b) => b.outcome !== 'pending' && b.outcome !== 'void')
    const won = bets.filter((b) => b.outcome === 'won').length
    const pl = bets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const staked = bets.filter((b) => b.outcome !== 'void' && isRealStake(b)).reduce((sum, b) => sum + parseFloat(b.stake), 0)
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

  function startEditKitty() {
    setKittyForm({
      amount_paid: String(persona?.amount_paid ?? 0),
      penalties_paid: String(persona?.penalties_paid ?? 0),
    })
    setEditingKitty(true)
    setKittyMsg(null)
  }

  async function saveKitty() {
    if (!persona) return
    setSavingKitty(true)
    const { data, error } = await supabase
      .from('personas')
      .update({
        amount_paid: parseFloat(kittyForm.amount_paid) || 0,
        penalties_paid: parseFloat(kittyForm.penalties_paid) || 0,
      })
      .eq('id', persona.id)
      .select()
      .single()
    setSavingKitty(false)
    if (error) {
      setKittyMsg({ ok: false, text: error.message })
    } else {
      setPersona(data)
      setEditingKitty(false)
      setKittyMsg({ ok: true, text: 'Saved' })
      setTimeout(() => setKittyMsg(null), 2500)
    }
  }

  if (loading) return <div className="text-center text-slate-400 py-16">Loading...</div>
  if (!profile) return <div className="text-center text-slate-400 py-16">Member not found.</div>

  const displayName = profile.full_name || profile.username

  const amountPaid = parseFloat(persona?.amount_paid ?? 0)
  const penaltiesPaid = parseFloat(persona?.penalties_paid ?? 0)
  const target = parseFloat(persona?.contribution_target ?? 400)
  const totalPaidIn = amountPaid + penaltiesPaid
  const owed = Math.max(0, target - amountPaid)
  const pct = Math.min((amountPaid / target) * 100, 100)

  return (
    <div className="space-y-5">
      {/* Profile header */}
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-green-500/20 border-2 border-green-500/30 flex items-center justify-center text-xl font-bold text-green-400 shrink-0">
          {persona?.emoji || displayName[0].toUpperCase()}
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">{persona?.nickname || displayName}</h1>
          <p className="text-slate-400 text-sm">{isOwn ? 'Your profile' : `@${profile.username}`}</p>
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
          <div key={label} className="bg-slate-800 rounded-lg border border-slate-700 p-4 text-center">
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
            <p className="text-slate-400 text-xs mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-slate-800/60 rounded-lg border border-slate-700 p-1">
        {[['bets', 'Bets'], ['kitty', '💰 Kitty']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === key ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Bets tab ── */}
      {tab === 'bets' && (
        <>
          <FilterBar filters={filters} onChange={setFilters} />
          {filteredBets.length === 0 ? (
            <div className="text-center text-slate-400 py-16">
              {bets.length === 0
                ? isOwn ? "You haven't placed any bets yet." : `${displayName} hasn't placed any bets yet.`
                : 'No bets match the current filters.'}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredBets.map((bet) => (
                <BetCard key={bet.id} bet={bet} onDelete={handleDelete} onUpdate={handleUpdate} showMember={false} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Kitty tab ── */}
      {tab === 'kitty' && (
        <div className="space-y-4">
          {!persona ? (
            <p className="text-slate-500 text-sm text-center py-8">No persona linked to this account yet.</p>
          ) : (
            <>
              {/* Summary card */}
              <div className="bg-slate-800 rounded-xl border border-emerald-700/40 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-emerald-400 uppercase tracking-wide">Contribution</p>
                  {canEditKitty && !editingKitty && (
                    <button onClick={startEditKitty} className="text-xs text-slate-400 hover:text-white transition-colors">Edit</button>
                  )}
                </div>

                {editingKitty ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-slate-400 mb-1 block">Paid towards target ($)</label>
                        <input
                          type="number"
                          value={kittyForm.amount_paid}
                          onChange={e => setKittyForm(f => ({ ...f, amount_paid: e.target.value }))}
                          step="50" min="0"
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 text-sm"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-400 mb-1 block">Penalties / extras paid ($)</label>
                        <input
                          type="number"
                          value={kittyForm.penalties_paid}
                          onChange={e => setKittyForm(f => ({ ...f, penalties_paid: e.target.value }))}
                          step="10" min="0"
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 text-sm"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={saveKitty} disabled={savingKitty} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
                        {savingKitty ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={() => setEditingKitty(false)} className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <p className="text-xs text-slate-400 mb-1">Paid In</p>
                        <p className="text-2xl font-bold text-white">${amountPaid.toFixed(0)}</p>
                        <p className="text-xs text-slate-500 mt-0.5">of ${target.toFixed(0)} target</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-400 mb-1">Still Owed</p>
                        <p className={`text-2xl font-bold ${owed > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>${owed.toFixed(0)}</p>
                        {owed === 0 && <p className="text-xs text-emerald-500 mt-0.5">Fully paid ✓</p>}
                      </div>
                      <div>
                        <p className="text-xs text-slate-400 mb-1">Extras</p>
                        <p className={`text-2xl font-bold ${penaltiesPaid > 0 ? 'text-purple-400' : 'text-slate-600'}`}>${penaltiesPaid.toFixed(0)}</p>
                        <p className="text-xs text-slate-500 mt-0.5">penalties / fines</p>
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div>
                      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${pct >= 100 ? 'bg-emerald-500' : 'bg-amber-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-xs text-slate-500 mt-1.5">{Math.round(pct)}% of contribution target paid</p>
                    </div>

                    {totalPaidIn > 0 && (
                      <div className="bg-slate-900/50 rounded-lg px-4 py-2 text-sm text-slate-400">
                        Total paid into kitty: <span className="text-white font-semibold">${totalPaidIn.toFixed(0)}</span>
                        {penaltiesPaid > 0 && <span className="text-slate-500 text-xs"> (${amountPaid.toFixed(0)} contribution + ${penaltiesPaid.toFixed(0)} extras)</span>}
                      </div>
                    )}

                    {/* Payout section */}
                    {kittyBalance !== null && (
                      <div className="border-t border-slate-700 pt-4 space-y-3">
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Projected payout (incl. outstanding contributions)</p>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="bg-slate-900/50 rounded-lg p-3">
                            <p className="text-xs text-slate-400 mb-1">Your share</p>
                            {(() => {
                              const projectedKitty = kittyBalance + stillOwedTotal
                              const share = projectedKitty / numPunters
                              return (
                                <>
                                  <p className={`text-xl font-bold ${share >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                    ${share.toFixed(2)}
                                  </p>
                                  <p className="text-xs text-slate-500 mt-0.5">projected kitty ÷ {numPunters}</p>
                                </>
                              )
                            })()}
                          </div>
                          <div className="bg-slate-900/50 rounded-lg p-3">
                            <p className="text-xs text-slate-400 mb-1">Net return</p>
                            {(() => {
                              const projectedKitty = kittyBalance + stillOwedTotal
                              const share = projectedKitty / numPunters
                              const net = share - owed
                              return (
                                <>
                                  <p className={`text-xl font-bold ${net >= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                                    ${net.toFixed(2)}
                                  </p>
                                  <p className="text-xs text-slate-500 mt-0.5">share − $${owed.toFixed(0)} owed</p>
                                </>
                              )
                            })()}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {kittyMsg && (
                  <p className={`text-xs ${kittyMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{kittyMsg.text}</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
