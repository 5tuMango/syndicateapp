import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

export default function AdminPersonas() {
  const { profile } = useAuth()
  const [personas, setPersonas] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null) // persona id being edited
  const [editForm, setEditForm] = useState({ nickname: '', emoji: '', amount_paid: '', contribution_target: '' })
  const [msg, setMsg] = useState({}) // { [id]: { ok, text } }

  if (!profile?.is_admin) return <Navigate to="/" replace />

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [personasRes, profilesRes] = await Promise.all([
      supabase.from('personas').select('*').order('created_at'),
      supabase.from('profiles').select('id, full_name, username'),
    ])
    const profileMap = {}
    for (const p of (profilesRes.data || [])) profileMap[p.id] = p
    const merged = (personasRes.data || []).map((p) => ({
      ...p,
      profile: p.claimed_by ? profileMap[p.claimed_by] : null,
    }))
    setPersonas(merged)
    setLoading(false)
  }

  function startEdit(persona) {
    setEditing(persona.id)
    setEditForm({
      nickname: persona.nickname,
      emoji: persona.emoji,
      amount_paid: String(persona.amount_paid ?? 0),
      contribution_target: String(persona.contribution_target ?? 400),
    })
  }

  function cancelEdit() {
    setEditing(null)
    setEditForm({ nickname: '', emoji: '' })
  }

  async function saveEdit(id) {
    const { error } = await supabase
      .from('personas')
      .update({
        nickname: editForm.nickname.trim(),
        emoji: editForm.emoji.trim(),
        amount_paid: parseFloat(editForm.amount_paid) || 0,
        contribution_target: parseFloat(editForm.contribution_target) || 400,
      })
      .eq('id', id)
    if (error) {
      flash(id, false, error.message)
      return
    }
    flash(id, true, 'Saved')
    setEditing(null)
    load()
  }

  async function resetClaim(id) {
    const { error } = await supabase
      .from('personas')
      .update({ claimed_by: null })
      .eq('id', id)
    if (error) {
      flash(id, false, error.message)
      return
    }
    flash(id, true, 'Claim reset')
    load()
  }

  function flash(id, ok, text) {
    setMsg((m) => ({ ...m, [id]: { ok, text } }))
    setTimeout(() => setMsg((m) => ({ ...m, [id]: null })), 2500)
  }

  function displayName(p) {
    return p?.full_name || p?.username || '—'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="text-slate-400 text-sm">Loading personas…</div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Personas</h1>
        <p className="text-sm text-slate-400 mt-1">
          Manage the 8 syndicate personas. Members will claim one when they sign up.
        </p>
      </div>

      <div className="space-y-3">
        {personas.map((p) => {
          const claimed = !!p.claimed_by
          const isEditing = editing === p.id

          return (
            <div
              key={p.id}
              className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-4"
            >
              {isEditing ? (
                /* ── Edit mode ── */
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-xs text-slate-400 mb-1 block">Emoji</label>
                      <input
                        type="text"
                        value={editForm.emoji}
                        onChange={(e) => setEditForm((f) => ({ ...f, emoji: e.target.value }))}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-lg focus:outline-none focus:border-purple-500"
                        maxLength={4}
                      />
                    </div>
                    <div className="flex-[3]">
                      <label className="text-xs text-slate-400 mb-1 block">Nickname</label>
                      <input
                        type="text"
                        value={editForm.nickname}
                        onChange={(e) => setEditForm((f) => ({ ...f, nickname: e.target.value }))}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-purple-500"
                      />
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-xs text-slate-400 mb-1 block">Paid In ($)</label>
                      <input
                        type="number"
                        value={editForm.amount_paid}
                        onChange={(e) => setEditForm((f) => ({ ...f, amount_paid: e.target.value }))}
                        step="50"
                        min="0"
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-slate-400 mb-1 block">Target ($)</label>
                      <input
                        type="number"
                        value={editForm.contribution_target}
                        onChange={(e) => setEditForm((f) => ({ ...f, contribution_target: e.target.value }))}
                        step="50"
                        min="0"
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => saveEdit(p.id)}
                      className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg transition-colors"
                    >
                      Save
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* ── View mode ── */
                <div className="flex items-center gap-4">
                  <span className="text-3xl">{p.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-white">{p.nickname}</div>
                    <div className="text-xs mt-0.5">
                      {claimed ? (
                        <span className="text-green-400">
                          Claimed by {displayName(p.profile)}
                        </span>
                      ) : (
                        <span className="text-slate-500">Unclaimed</span>
                      )}
                    </div>
                    <div className="text-xs mt-1">
                      {(() => {
                        const paid = parseFloat(p.amount_paid || 0)
                        const target = parseFloat(p.contribution_target || 400)
                        const full = paid >= target
                        return (
                          <span className={full ? 'text-emerald-400' : 'text-amber-400'}>
                            Kitty: ${paid.toFixed(0)} / ${target.toFixed(0)}{full ? ' ✓' : ''}
                          </span>
                        )
                      })()}
                    </div>
                    {msg[p.id] && (
                      <div
                        className={`text-xs mt-1 ${
                          msg[p.id].ok ? 'text-green-400' : 'text-red-400'
                        }`}
                      >
                        {msg[p.id].text}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => startEdit(p)}
                      className="text-xs px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
                    >
                      Edit
                    </button>
                    {claimed && (
                      <button
                        onClick={() => resetClaim(p.id)}
                        className="text-xs px-3 py-1.5 bg-red-900/40 hover:bg-red-900/70 text-red-400 rounded-lg transition-colors"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="text-xs text-slate-600 text-center">
        {personas.filter((p) => p.claimed_by).length} / {personas.length} claimed
      </div>
    </div>
  )
}
