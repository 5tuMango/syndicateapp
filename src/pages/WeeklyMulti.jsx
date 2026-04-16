import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

const OUTCOME_OPTS = ['won', 'lost', 'void', 'pending']

function outcomeBadge(outcome) {
  switch (outcome) {
    case 'won':
      return 'bg-green-500/20 text-green-400 border-green-500/30'
    case 'lost':
      return 'bg-red-500/20 text-red-400 border-red-500/30'
    case 'void':
      return 'bg-slate-500/20 text-slate-400 border-slate-500/30'
    default:
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  }
}

function statusBadge(status) {
  return status === 'resulted'
    ? 'bg-green-500/20 text-green-400 border-green-500/30'
    : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
}

function combinedOdds(legs) {
  const entered = legs.filter((l) => l.odds != null && l.odds > 0)
  if (entered.length === 0) return null
  return entered.reduce((acc, l) => acc * parseFloat(l.odds), 1)
}

function OutcomePill({ outcome }) {
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border ${outcomeBadge(outcome)}`}>
      {outcome}
    </span>
  )
}

export default function WeeklyMulti() {
  const { user, profile } = useAuth()
  const isAdmin = profile?.is_admin

  const [multis, setMultis] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)

  // Create multi modal
  const [showCreate, setShowCreate] = useState(false)
  const [weekLabel, setWeekLabel] = useState('')
  const [addAllOnCreate, setAddAllOnCreate] = useState(true)
  const [creating, setCreating] = useState(false)

  // Add member slot modal
  const [addingLeg, setAddingLeg] = useState(null) // multiId or null
  const [legAssignee, setLegAssignee] = useState('') // user_id string
  const [legAssigneeName, setLegAssigneeName] = useState('') // free-text name
  const [addingLegSaving, setAddingLegSaving] = useState(false)

  // Enter/edit pick modal
  const [editingLeg, setEditingLeg] = useState(null) // leg object
  const [legForm, setLegForm] = useState({ event: '', description: '', selection: '', odds: '' })
  const [savingLeg, setSavingLeg] = useState(false)

  // Set outcome modal
  const [overrideLeg, setOverrideLeg] = useState(null) // leg object
  const [overrideOutcome, setOverrideOutcome] = useState('pending')
  const [savingOverride, setSavingOverride] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [{ data: multisData }, { data: profilesData }] = await Promise.all([
      supabase
        .from('weekly_multis')
        .select('*, weekly_multi_legs(*)')
        .order('created_at', { ascending: false }),
      supabase.from('profiles').select('id, full_name, username'),
    ])
    setMultis(multisData || [])
    setProfiles(profilesData || [])
    setLoading(false)
  }

  function profileName(id) {
    const p = profiles.find((x) => x.id === id)
    return p ? p.full_name || p.username : 'Unknown'
  }

  // ── Season leaderboard (resulted multis) ─────────────────────────────────
  function buildLeaderboard() {
    const resulted = multis.filter((m) => m.status === 'resulted')
    if (resulted.length === 0) return null
    const stats = {}
    for (const multi of resulted) {
      const legs = multi.weekly_multi_legs || []
      for (const leg of legs) {
        const key = leg.assigned_user_id || leg.assigned_name || 'Unknown'
        const name = leg.assigned_user_id
          ? profileName(leg.assigned_user_id)
          : leg.assigned_name || 'Unknown'
        if (!stats[key]) stats[key] = { name, won: 0, lost: 0, void: 0 }
        if (leg.outcome === 'won') stats[key].won++
        else if (leg.outcome === 'lost') stats[key].lost++
        else if (leg.outcome === 'void') stats[key].void++
      }
    }
    return Object.values(stats).sort((a, b) => b.won - a.won)
  }

  const leaderboard = buildLeaderboard()

  // ── Create multi ─────────────────────────────────────────────────────────
  async function handleCreateMulti() {
    if (!weekLabel.trim()) return
    setCreating(true)
    const { data: multi, error } = await supabase
      .from('weekly_multis')
      .insert({ week_label: weekLabel.trim(), created_by: user.id })
      .select()
      .single()
    if (!error && multi) {
      // Auto-add all registered members as leg slots
      if (addAllOnCreate && profiles.length > 0) {
        await supabase.from('weekly_multi_legs').insert(
          profiles.map((p, i) => ({
            weekly_multi_id: multi.id,
            assigned_user_id: p.id,
            assigned_name: null,
            sort_order: i,
          }))
        )
      }
      // Notify all profiles
      const notifs = profiles.map((p) => ({
        user_id: p.id,
        title: `New Weekly Multi: ${weekLabel.trim()}`,
        body: 'A new weekly multi has been created. Enter your pick!',
        link: '/weekly-multi',
      }))
      if (notifs.length > 0) {
        await supabase.from('notifications').insert(notifs)
      }
    }
    setCreating(false)
    setShowCreate(false)
    setWeekLabel('')
    load()
  }

  // ── Add member slot ───────────────────────────────────────────────────────
  async function handleAddLeg() {
    if (!addingLeg) return
    setAddingLegSaving(true)
    const userId = legAssignee || null
    const name = userId ? null : legAssigneeName.trim() || null
    await supabase.from('weekly_multi_legs').insert({
      weekly_multi_id: addingLeg,
      assigned_user_id: userId,
      assigned_name: name,
      sort_order: 0,
    })
    setAddingLegSaving(false)
    setAddingLeg(null)
    setLegAssignee('')
    setLegAssigneeName('')
    load()
  }

  // ── Enter / edit pick ─────────────────────────────────────────────────────
  function openEditLeg(leg) {
    setEditingLeg(leg)
    setLegForm({
      event: leg.event || '',
      description: leg.description || '',
      selection: leg.selection || '',
      odds: leg.odds != null ? String(leg.odds) : '',
    })
  }

  async function handleSaveLeg() {
    if (!editingLeg) return
    setSavingLeg(true)
    await supabase
      .from('weekly_multi_legs')
      .update({
        event: legForm.event.trim() || null,
        description: legForm.description.trim() || null,
        selection: legForm.selection.trim() || null,
        odds: legForm.odds ? parseFloat(legForm.odds) : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', editingLeg.id)
    setSavingLeg(false)
    setEditingLeg(null)
    load()
  }

  // ── Set outcome ───────────────────────────────────────────────────────────
  function openOverride(leg) {
    setOverrideLeg(leg)
    setOverrideOutcome(leg.outcome || 'pending')
  }

  async function handleSaveOverride() {
    if (!overrideLeg) return
    setSavingOverride(true)
    await supabase
      .from('weekly_multi_legs')
      .update({ outcome: overrideOutcome, updated_at: new Date().toISOString() })
      .eq('id', overrideLeg.id)
    setSavingOverride(false)
    setOverrideLeg(null)
    load()
  }

  // ── Delete multi ──────────────────────────────────────────────────────────
  async function handleDeleteMulti(multi) {
    if (!confirm(`Delete "${multi.week_label}"? This cannot be undone.`)) return
    await supabase.from('weekly_multis').delete().eq('id', multi.id)
    load()
  }

  // ── Mark resulted ─────────────────────────────────────────────────────────
  async function markResulted(multi) {
    await supabase
      .from('weekly_multis')
      .update({ status: 'resulted' })
      .eq('id', multi.id)
    // Notify all profiles
    const notifs = profiles.map((p) => ({
      user_id: p.id,
      title: `Weekly Multi Resulted: ${multi.week_label}`,
      body: 'The weekly multi has been resulted. Check how everyone went!',
      link: '/weekly-multi',
    }))
    if (notifs.length > 0) {
      await supabase.from('notifications').insert(notifs)
    }
    load()
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 text-center text-slate-400 text-sm">
        Loading...
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Weekly Multi</h1>
          <p className="text-slate-400 text-sm mt-1">
            Club multi — everyone picks a leg
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setShowCreate(true)}
            className="bg-green-500 hover:bg-green-400 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
          >
            + New Week
          </button>
        )}
      </div>

      {/* Season Leaderboard */}
      {leaderboard && leaderboard.length > 0 && (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-5">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">
            Season Leaderboard
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-500 text-xs">
                  <th className="text-left pb-2">Member</th>
                  <th className="text-center pb-2">Won</th>
                  <th className="text-center pb-2">Lost</th>
                  <th className="text-center pb-2">Void</th>
                  <th className="text-right pb-2">Win %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {leaderboard.map((row, i) => {
                  const total = row.won + row.lost
                  const pct = total > 0 ? Math.round((row.won / total) * 100) : 0
                  return (
                    <tr key={i}>
                      <td className="py-2 text-slate-200 font-medium">{row.name}</td>
                      <td className="py-2 text-center text-green-400">{row.won}</td>
                      <td className="py-2 text-center text-red-400">{row.lost}</td>
                      <td className="py-2 text-center text-slate-400">{row.void}</td>
                      <td className="py-2 text-right text-slate-300">{pct}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Multi list */}
      {multis.length === 0 ? (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-8 text-center text-slate-500 text-sm">
          No weekly multis yet.{isAdmin ? ' Create one above!' : ''}
        </div>
      ) : (
        <div className="space-y-4">
          {multis.map((multi) => {
            const legs = (multi.weekly_multi_legs || []).sort(
              (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
            )
            const odds = combinedOdds(legs)
            const allResolved = legs.length > 0 && legs.every((l) => l.outcome !== 'pending')
            const wonCount = legs.filter((l) => l.outcome === 'won').length
            const lostCount = legs.filter((l) => l.outcome === 'lost').length

            return (
              <div
                key={multi.id}
                className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-4"
              >
                {/* Multi header */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-white font-bold text-base">{multi.week_label}</h3>
                    <span
                      className={`text-xs px-2 py-0.5 rounded border ${statusBadge(multi.status)}`}
                    >
                      {multi.status === 'resulted' ? 'Resulted' : 'Open'}
                    </span>
                    {odds != null && (
                      <span className="text-slate-400 text-xs">
                        Combined odds:{' '}
                        <span className="text-white font-semibold">{odds.toFixed(2)}</span>
                      </span>
                    )}
                    {multi.status === 'resulted' && (
                      <span className="text-xs text-slate-400">
                        <span className="text-green-400 font-semibold">{wonCount}W</span>
                        {' / '}
                        <span className="text-red-400 font-semibold">{lostCount}L</span>
                      </span>
                    )}
                  </div>
                  {isAdmin && (
                    <div className="flex items-center gap-2">
                      {multi.status === 'open' && allResolved && legs.length > 0 && (
                        <button
                          onClick={() => markResulted(multi)}
                          className="text-xs bg-green-500 hover:bg-green-400 text-white font-semibold rounded-lg px-3 py-1.5 transition-colors"
                        >
                          Mark Resulted
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteMulti(multi)}
                        className="text-xs text-slate-500 hover:text-red-400 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>

                {/* Legs table */}
                {legs.length > 0 ? (
                  <div className="space-y-2">
                    {legs.map((leg) => {
                      const isMyLeg = leg.assigned_user_id === user?.id
                      const legName = leg.assigned_user_id
                        ? profileName(leg.assigned_user_id)
                        : leg.assigned_name || 'Unknown'
                      const canEdit =
                        (isMyLeg || isAdmin) && multi.status === 'open'
                      const hasPickEntered = leg.event || leg.selection

                      return (
                        <div
                          key={leg.id}
                          className="bg-slate-900/70 rounded-lg px-3 py-2.5 space-y-1.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            {/* Name + odds */}
                            <div className="flex items-center gap-2 flex-wrap min-w-0">
                              <span
                                className={`text-sm font-semibold ${
                                  isMyLeg ? 'text-green-400' : 'text-slate-300'
                                }`}
                              >
                                {legName}
                                {isMyLeg && (
                                  <span className="text-green-500/70 font-normal ml-1">
                                    (You)
                                  </span>
                                )}
                              </span>
                              {leg.odds != null && (
                                <span className="text-slate-400 text-xs">
                                  @ {parseFloat(leg.odds).toFixed(2)}
                                </span>
                              )}
                            </div>
                            {/* Outcome badge */}
                            <OutcomePill outcome={leg.outcome} />
                          </div>

                          {/* Pick details */}
                          <div className="text-sm text-slate-400">
                            {hasPickEntered ? (
                              <>
                                {leg.event && (
                                  <span className="text-slate-200">{leg.event}</span>
                                )}
                                {leg.description && (
                                  <span className="text-slate-400"> · {leg.description}</span>
                                )}
                                {leg.selection && (
                                  <span className="text-green-400 font-medium">
                                    {' '}
                                    · {leg.selection}
                                  </span>
                                )}
                              </>
                            ) : isMyLeg ? (
                              <span className="italic text-slate-500 text-xs">
                                Tap &apos;Enter pick&apos; to add your selection
                              </span>
                            ) : (
                              <span className="italic text-slate-600 text-xs">
                                Waiting for pick...
                              </span>
                            )}
                          </div>

                          {/* Action buttons */}
                          <div className="flex items-center gap-3 pt-0.5">
                            {canEdit && (
                              <button
                                onClick={() => openEditLeg(leg)}
                                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                              >
                                {hasPickEntered ? 'Edit' : 'Enter pick'}
                              </button>
                            )}
                            {isAdmin && (
                              <button
                                onClick={() => openOverride(leg)}
                                className="text-xs text-slate-400 hover:text-yellow-400 transition-colors"
                              >
                                Result
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-slate-600 text-sm italic">No legs added yet.</p>
                )}

                {/* Add member slot (admin, open only) */}
                {isAdmin && multi.status === 'open' && (
                  <button
                    onClick={() => setAddingLeg(multi.id)}
                    className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    + Add member slot
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Modals ────────────────────────────────────────────────────────── */}

      {/* Create multi */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-6 w-full max-w-sm space-y-4">
            <h3 className="text-white font-semibold">New Weekly Multi</h3>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Week label</label>
              <input
                value={weekLabel}
                onChange={(e) => setWeekLabel(e.target.value)}
                placeholder="e.g. Round 5 — 19 Apr 2026"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && !creating && weekLabel.trim() && handleCreateMulti()}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
              />
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={addAllOnCreate}
                onChange={(e) => setAddAllOnCreate(e.target.checked)}
                className="w-4 h-4 rounded accent-green-500"
              />
              <span className="text-sm text-slate-300">
                Auto-add all {profiles.length} members as leg slots
              </span>
            </label>
            <div className="flex gap-3">
              <button
                onClick={handleCreateMulti}
                disabled={creating || !weekLabel.trim()}
                className="flex-1 bg-green-500 hover:bg-green-400 text-white font-semibold rounded-lg py-2 text-sm transition-colors disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
              <button
                onClick={() => { setShowCreate(false); setWeekLabel('') }}
                className="flex-1 border border-slate-600 text-slate-300 hover:text-white rounded-lg py-2 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add member slot */}
      {addingLeg !== null && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-6 w-full max-w-sm space-y-4">
            <h3 className="text-white font-semibold">Add Member Slot</h3>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Registered user</label>
              <select
                value={legAssignee}
                onChange={(e) => { setLegAssignee(e.target.value); setLegAssigneeName('') }}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
              >
                <option value="">— Select member —</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.username}
                  </option>
                ))}
              </select>
            </div>
            {!legAssignee && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Or enter name (unregistered)
                </label>
                <input
                  value={legAssigneeName}
                  onChange={(e) => setLegAssigneeName(e.target.value)}
                  placeholder="Full name"
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                />
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={handleAddLeg}
                disabled={addingLegSaving || (!legAssignee && !legAssigneeName.trim())}
                className="flex-1 bg-green-500 hover:bg-green-400 text-white font-semibold rounded-lg py-2 text-sm transition-colors disabled:opacity-50"
              >
                {addingLegSaving ? 'Adding...' : 'Add Slot'}
              </button>
              <button
                onClick={() => { setAddingLeg(null); setLegAssignee(''); setLegAssigneeName('') }}
                className="flex-1 border border-slate-600 text-slate-300 hover:text-white rounded-lg py-2 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Enter / edit pick */}
      {editingLeg && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-6 w-full max-w-sm space-y-4">
            <h3 className="text-white font-semibold">Enter Pick</h3>
            {[
              { key: 'event', label: 'Event', placeholder: 'e.g. Collingwood vs Carlton' },
              { key: 'description', label: 'Market', placeholder: 'e.g. Head to head' },
              { key: 'selection', label: 'Selection', placeholder: 'e.g. Collingwood' },
              { key: 'odds', label: 'Odds', placeholder: 'e.g. 1.85', type: 'number' },
            ].map(({ key, label, placeholder, type }) => (
              <div key={key}>
                <label className="block text-xs text-slate-400 mb-1">{label}</label>
                <input
                  type={type || 'text'}
                  value={legForm[key]}
                  onChange={(e) => setLegForm((f) => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                />
              </div>
            ))}
            <div className="flex gap-3">
              <button
                onClick={handleSaveLeg}
                disabled={savingLeg}
                className="flex-1 bg-green-500 hover:bg-green-400 text-white font-semibold rounded-lg py-2 text-sm transition-colors disabled:opacity-50"
              >
                {savingLeg ? 'Saving...' : 'Save Pick'}
              </button>
              <button
                onClick={() => setEditingLeg(null)}
                className="flex-1 border border-slate-600 text-slate-300 hover:text-white rounded-lg py-2 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Set outcome */}
      {overrideLeg && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-6 w-full max-w-sm space-y-4">
            <h3 className="text-white font-semibold">Set Outcome</h3>
            <p className="text-slate-400 text-sm">
              {overrideLeg.assigned_user_id
                ? profileName(overrideLeg.assigned_user_id)
                : overrideLeg.assigned_name || 'Unknown'}
              {overrideLeg.selection && (
                <span className="text-white"> — {overrideLeg.selection}</span>
              )}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {OUTCOME_OPTS.map((o) => (
                <button
                  key={o}
                  onClick={() => setOverrideOutcome(o)}
                  className={`py-2 rounded-lg border text-sm font-medium transition-colors capitalize ${
                    overrideOutcome === o
                      ? outcomeBadge(o) + ' font-bold'
                      : 'border-slate-600 text-slate-400 hover:text-white'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleSaveOverride}
                disabled={savingOverride}
                className="flex-1 bg-green-500 hover:bg-green-400 text-white font-semibold rounded-lg py-2 text-sm transition-colors disabled:opacity-50"
              >
                {savingOverride ? 'Saving...' : 'Confirm'}
              </button>
              <button
                onClick={() => setOverrideLeg(null)}
                className="flex-1 border border-slate-600 text-slate-300 hover:text-white rounded-lg py-2 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
