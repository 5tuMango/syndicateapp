import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

export default function AdminAssignBets() {
  const { profile } = useAuth()
  const [bets, setBets] = useState([])
  const [personas, setPersonas] = useState([])
  const [profiles, setProfiles] = useState({})
  const [loading, setLoading] = useState(true)
  const [autoAssigning, setAutoAssigning] = useState(false)
  const [autoMsg, setAutoMsg] = useState(null)
  const [saving, setSaving] = useState({})
  const [autoAssigningLegs, setAutoAssigningLegs] = useState(false)
  const [autoLegsMsg, setAutoLegsMsg] = useState(null)

  if (!profile?.is_admin) return <Navigate to="/" replace />

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const [betsRes, personasRes, profilesRes] = await Promise.all([
      supabase
        .from('bets')
        .select('id, date, event, sport, odds, stake, outcome, user_id, persona_id')
        .order('date', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('personas').select('*').order('nickname'),
      supabase.from('profiles').select('id, full_name, username'),
    ])
    const profileMap = {}
    for (const p of (profilesRes.data || [])) profileMap[p.id] = p
    setBets(betsRes.data || [])
    setPersonas(personasRes.data || [])
    setProfiles(profileMap)
    setLoading(false)
  }

  // Auto-assign: for each claimed persona, assign all bets where user_id = claimed_by
  async function autoAssign() {
    setAutoAssigning(true)
    setAutoMsg(null)
    const claimed = personas.filter((p) => p.claimed_by)
    let total = 0
    for (const persona of claimed) {
      const { data: updated } = await supabase
        .from('bets')
        .update({ persona_id: persona.id })
        .eq('user_id', persona.claimed_by)
        .is('persona_id', null)
        .select('id')
      total += updated?.length || 0
    }
    setAutoMsg(`Auto-assigned ${total} bet${total !== 1 ? 's' : ''}`)
    setAutoAssigning(false)
    load()
  }

  // Auto-assign weekly multi legs: match assigned_user_id → persona.claimed_by
  async function autoAssignLegs() {
    setAutoAssigningLegs(true)
    setAutoLegsMsg(null)
    const claimed = personas.filter((p) => p.claimed_by)
    let total = 0
    for (const persona of claimed) {
      const { data: updated } = await supabase
        .from('weekly_multi_legs')
        .update({ persona_id: persona.id })
        .eq('assigned_user_id', persona.claimed_by)
        .is('persona_id', null)
        .select('id')
      total += updated?.length || 0
    }
    setAutoLegsMsg(`Auto-assigned ${total} leg${total !== 1 ? 's' : ''}`)
    setAutoAssigningLegs(false)
  }

  async function assignBet(betId, personaId) {
    setSaving((s) => ({ ...s, [betId]: true }))
    await supabase
      .from('bets')
      .update({ persona_id: personaId || null })
      .eq('id', betId)
    setSaving((s) => ({ ...s, [betId]: false }))
    setBets((prev) =>
      prev.map((b) => (b.id === betId ? { ...b, persona_id: personaId || null } : b))
    )
  }

  function profileName(userId) {
    const p = profiles[userId]
    return p?.full_name || p?.username || userId?.slice(0, 8)
  }

  function personaName(personaId) {
    const p = personas.find((p) => p.id === personaId)
    return p ? `${p.emoji} ${p.nickname}` : '—'
  }

  const assigned = bets.filter((b) => b.persona_id).length
  const unassigned = bets.length - assigned

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="text-slate-400 text-sm">Loading…</div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Assign Bets to Personas</h1>
        <p className="text-sm text-slate-400 mt-1">
          Link each bet to a persona. Use auto-assign for existing members, or set manually.
        </p>
      </div>

      {/* Stats + auto-assign */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-4 flex flex-wrap items-center gap-4">
        <div className="flex gap-6 flex-1">
          <div>
            <div className="text-2xl font-bold text-green-400">{assigned}</div>
            <div className="text-xs text-slate-400">Assigned</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-amber-400">{unassigned}</div>
            <div className="text-xs text-slate-400">Unassigned</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-white">{bets.length}</div>
            <div className="text-xs text-slate-400">Total</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={autoAssign}
            disabled={autoAssigning}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {autoAssigning ? 'Assigning…' : 'Auto-assign'}
          </button>
          {autoMsg && <span className="text-xs text-green-400">{autoMsg}</span>}
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Auto-assign links bets to personas based on who's signed in and claimed. Use the dropdowns below for manual overrides.
      </p>

      {/* Weekly multi legs auto-assign */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-4 flex items-center justify-between gap-4">
        <div>
          <div className="text-white font-semibold text-sm">Weekly Multi Legs</div>
          <div className="text-xs text-slate-400 mt-0.5">
            Link existing leg slots to personas based on assigned_user_id.
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <button
            onClick={autoAssignLegs}
            disabled={autoAssigningLegs}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {autoAssigningLegs ? 'Assigning…' : 'Auto-assign legs'}
          </button>
          {autoLegsMsg && <span className="text-xs text-green-400">{autoLegsMsg}</span>}
        </div>
      </div>

      {/* Bet list */}
      <div className="space-y-2">
        {bets.map((bet) => (
          <div
            key={bet.id}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${
              bet.persona_id
                ? 'bg-slate-800/50 border-slate-700/50'
                : 'bg-amber-900/10 border-amber-700/30'
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="text-white font-medium truncate">{bet.event}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {bet.date} · {bet.sport} · @{bet.odds} · ${bet.stake}
                {' · '}
                <span className="text-slate-400">{profileName(bet.user_id)}</span>
              </div>
            </div>

            <select
              value={bet.persona_id || ''}
              onChange={(e) => assignBet(bet.id, e.target.value)}
              disabled={saving[bet.id]}
              className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-purple-500 shrink-0"
            >
              <option value="">— unassigned —</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.emoji} {p.nickname}
                  {p.claimed_by ? '' : ' (unclaimed)'}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}
