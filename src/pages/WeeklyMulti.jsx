import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { usePersonas } from '../hooks/usePersonas'

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
  const { user, profile, persona: myPersona } = useAuth()
  const { byUserId: personaMap } = usePersonas()
  const isAdmin = profile?.is_admin

  const [multis, setMultis] = useState([])
  const [personas, setPersonas] = useState([])
  const [loading, setLoading] = useState(true)

  // Create multi modal
  const [showCreate, setShowCreate] = useState(false)
  const [weekLabel, setWeekLabel] = useState('')
  const [newStake, setNewStake] = useState('')
  const [createError, setCreateError] = useState('')
  const [addAllOnCreate, setAddAllOnCreate] = useState(true)
  const [creating, setCreating] = useState(false)

  // Add member slot modal
  const [addingLeg, setAddingLeg] = useState(null) // multiId or null
  const [legAssignee, setLegAssignee] = useState('') // user_id string
  const [legAssigneeName, setLegAssigneeName] = useState('') // free-text name
  const [addingLegSaving, setAddingLegSaving] = useState(false)

  // Enter/edit pick modal
  const [editingLeg, setEditingLeg] = useState(null) // leg object
  const [legForm, setLegForm] = useState({ raw_pick: '', event: '', description: '', selection: '', odds: '', event_time: '' })
  const [savingLeg, setSavingLeg] = useState(false)

  // Inline pick editing: { [legId]: currentValue }
  const [inlinePicks, setInlinePicks] = useState({})

  // Inline stake editing: { [multiId]: currentValue }
  const [inlineStakes, setInlineStakes] = useState({})
  const [stakeMsg, setStakeMsg] = useState({}) // { [multiId]: { ok: bool, text: string } }

  // Upload bet slip + match preview
  const [slipUploading, setSlipUploading] = useState(false)
  const [slipPreview, setSlipPreview] = useState(null) // { multiId, matches: [], unmatched_slip_legs: [] }
  const [manualAssignments, setManualAssignments] = useState({}) // { slipLegIndex: legId }

  // Set outcome modal
  const [overrideLeg, setOverrideLeg] = useState(null) // leg object
  const [overrideOutcome, setOverrideOutcome] = useState('pending')
  const [savingOverride, setSavingOverride] = useState(false)

  // Collapsed/expanded state for resolved multis (collapsed by default)
  const [expandedResolved, setExpandedResolved] = useState(new Set())

  function isResolved(multi) {
    const legs = multi.weekly_multi_legs || []
    if (legs.length === 0) return false
    const nonVoid = legs.filter((l) => l.outcome !== 'void')
    return nonVoid.length > 0 && nonVoid.every((l) => l.outcome === 'won' || l.outcome === 'lost')
  }

  function toggleResolved(id) {
    setExpandedResolved((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [{ data: multisData }, { data: personasData }] = await Promise.all([
      supabase
        .from('weekly_multis')
        .select('*, weekly_multi_legs(*)')
        .order('created_at', { ascending: false }),
      supabase.from('personas').select('*').order('nickname'),
    ])
    setMultis(multisData || [])
    setPersonas(personasData || [])
    setLoading(false)
  }

  function profileName(id) {
    const p = personaMap[id]
    if (p) return `${p.emoji} ${p.nickname}`
    // Fallback: check by persona_id directly in personas list
    const byId = personas.find((x) => x.id === id || x.claimed_by === id)
    return byId ? `${byId.emoji} ${byId.nickname}` : 'Unknown'
  }

  function legPersonaName(leg) {
    // Prefer persona_id lookup, fall back to assigned_user_id
    if (leg.persona_id) {
      const p = personas.find((x) => x.id === leg.persona_id)
      if (p) return `${p.emoji} ${p.nickname}`
    }
    if (leg.assigned_user_id) return profileName(leg.assigned_user_id)
    return leg.assigned_name || 'Unknown'
  }

  function legEmoji(leg) {
    if (leg.persona_id) {
      const p = personas.find((x) => x.id === leg.persona_id)
      if (p) return p.emoji
    }
    if (leg.assigned_user_id) {
      const p = personaMap[leg.assigned_user_id]
      if (p) return p.emoji
    }
    return null
  }

  // ── Season leaderboard (multis where all legs are resolved) ─────────────────
  function buildLeaderboard() {
    const resulted = multis.filter((m) => {
      const legs = m.weekly_multi_legs || []
      // Resolved = all legs have a final outcome (pending = not done; null = not done)
      return legs.length > 0 && legs.every(l => l.outcome && l.outcome !== 'pending')
    })
    if (resulted.length === 0) return null
    const stats = {}
    for (const multi of resulted) {
      const legs = multi.weekly_multi_legs || []
      for (const leg of legs) {
        // Key by persona_id first (handles unclaimed + claimed personas uniformly),
        // then fall back to assigned_user_id or assigned_name for legacy legs
        const key = leg.persona_id || leg.assigned_user_id || leg.assigned_name || 'Unknown'
        const name = legPersonaName(leg)
        if (!stats[key]) stats[key] = { name, won: 0, lost: 0, void: 0, missed: 0 }
        if (leg.outcome === 'won') stats[key].won++
        else if (leg.outcome === 'lost') stats[key].lost++
        else if (leg.outcome === 'void') stats[key].void++
        else if (leg.outcome === 'missed') stats[key].missed++
      }
    }
    return Object.values(stats).sort((a, b) => b.won - a.won)
  }

  const leaderboard = buildLeaderboard()

  // ── Create multi ─────────────────────────────────────────────────────────
  async function handleCreateMulti() {
    if (!weekLabel.trim()) return
    setCreating(true)
    setCreateError('')
    const insertData = { week_label: weekLabel.trim(), created_by: user.id }
    if (newStake !== '') insertData.stake = parseFloat(newStake) || 0
    const { data: multi, error } = await supabase
      .from('weekly_multis')
      .insert(insertData)
      .select()
      .single()
    if (error) {
      setCreateError(error.message)
      setCreating(false)
      return
    }
    if (!error && multi) {
      // Auto-add all personas as leg slots
      if (addAllOnCreate && personas.length > 0) {
        await supabase.from('weekly_multi_legs').insert(
          personas.map((p, i) => ({
            weekly_multi_id: multi.id,
            persona_id: p.id,
            assigned_user_id: p.claimed_by || null,
            assigned_name: null,
            sort_order: i,
          }))
        )
      }
      // Notify claimed members
      const notifs = personas
        .filter((p) => p.claimed_by)
        .map((p) => ({
          user_id: p.claimed_by,
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
    setNewStake('')
    setCreateError('')
    load()
  }

  // ── Add member slot ───────────────────────────────────────────────────────
  async function handleAddLeg() {
    if (!addingLeg) return
    setAddingLegSaving(true)
    const personaId = legAssignee || null
    const selectedPersona = personaId ? personas.find((p) => p.id === personaId) : null
    const name = !personaId ? legAssigneeName.trim() || null : null
    await supabase.from('weekly_multi_legs').insert({
      weekly_multi_id: addingLeg,
      persona_id: personaId,
      assigned_user_id: selectedPersona?.claimed_by || null,
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
      raw_pick: leg.raw_pick || '',
      event: leg.event || '',
      description: leg.description || '',
      selection: leg.selection || '',
      odds: leg.odds != null ? String(leg.odds) : '',
      event_time: leg.event_time ? new Date(leg.event_time).toISOString().substring(0, 16) : '',
    })
  }

  async function handleSaveLeg() {
    if (!editingLeg) return
    setSavingLeg(true)
    await supabase
      .from('weekly_multi_legs')
      .update({
        raw_pick: legForm.raw_pick.trim() || null,
        event: legForm.event.trim() || null,
        description: legForm.description.trim() || null,
        selection: legForm.selection.trim() || null,
        odds: legForm.odds ? parseFloat(legForm.odds) : null,
        event_time: legForm.event_time || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', editingLeg.id)
    setSavingLeg(false)
    setEditingLeg(null)
    load()
  }

  // ── Inline pick save (on blur / Enter) ───────────────────────────────────
  async function saveInlinePick(leg) {
    const value = inlinePicks[leg.id]
    if (value === undefined || value.trim() === (leg.raw_pick || '').trim()) return
    await supabase.from('weekly_multi_legs').update({
      raw_pick: value.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('id', leg.id)
    load()
  }

  async function saveInlineStake(multi, rawValue) {
    const val = parseFloat(rawValue) || 0
    if (val === parseFloat(multi.stake || 0)) return
    const { error } = await supabase.from('weekly_multis').update({ stake: val }).eq('id', multi.id)
    if (error) {
      setStakeMsg(m => ({ ...m, [multi.id]: { ok: false, text: error.message } }))
      return
    }
    setStakeMsg(m => ({ ...m, [multi.id]: { ok: true, text: 'Saved' } }))
    setTimeout(() => setStakeMsg(m => ({ ...m, [multi.id]: null })), 2000)
    load()
  }

  // ── Upload bet slip + match ────────────────────────────────────────────────
  async function handleSlipUpload(multiId, e) {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setSlipUploading(true)
    try {
      const images = await Promise.all(
        files.map(f => new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve({ imageBase64: reader.result.split(',')[1], mimeType: f.type })
          reader.onerror = reject
          reader.readAsDataURL(f)
        }))
      )
      const res = await fetch('/api/match-weekly-multi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, multiId }),
      })
      // Use .text() first so we get a useful error even if the body isn't valid JSON
      const text = await res.text()
      if (!text) throw new Error(`Server returned empty response (status ${res.status})`)
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Server error (status ${res.status}): ${text.slice(0, 200)}`) }
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
      setManualAssignments({})
      setSlipPreview({ multiId, matches: data.matches, unmatched_slip_legs: data.unmatched_slip_legs || [] })
    } catch (err) {
      alert('Error reading bet slip: ' + err.message)
    } finally {
      setSlipUploading(false)
      e.target.value = ''
    }
  }

  async function handleConfirmSlip() {
    if (!slipPreview) return
    const unmatched = slipPreview.unmatched_slip_legs || []

    // Save auto-matched legs
    const matched = slipPreview.matches.filter(m => m.matched && m.leg_id)
    for (const m of matched) {
      const update = {
        event: m.event || null,
        description: m.description || null,
        selection: m.selection || null,
        odds: m.odds || null,
        event_time: m.event_time || null,
        updated_at: new Date().toISOString(),
      }
      if (m.outcome && m.outcome !== 'pending') update.outcome = m.outcome
      await supabase.from('weekly_multi_legs').update(update).eq('id', m.leg_id)
    }

    // Save manually assigned unmatched slip legs
    for (const [slipIdx, legId] of Object.entries(manualAssignments)) {
      const slipLeg = unmatched[parseInt(slipIdx)]
      if (!slipLeg || !legId) continue
      const update = {
        event: slipLeg.event || null,
        description: slipLeg.description || null,
        selection: slipLeg.selection || null,
        odds: slipLeg.odds || null,
        event_time: slipLeg.event_time || null,
        updated_at: new Date().toISOString(),
      }
      if (slipLeg.outcome && slipLeg.outcome !== 'pending') update.outcome = slipLeg.outcome
      await supabase.from('weekly_multi_legs').update(update).eq('id', legId)
    }

    // Mark the multi as live — bet is now placed, result checking can begin
    await supabase.from('weekly_multis').update({ is_live: true }).eq('id', slipPreview.multiId)

    setSlipPreview(null)
    setManualAssignments({})
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

  // ── Remove leg (mark as missed) ───────────────────────────────────────────
  async function handleRemoveLeg(leg) {
    if (!confirm(`Mark ${legPersonaName(leg)} as missed for this week?`)) return
    await supabase.from('weekly_multi_legs').update({ outcome: 'missed' }).eq('id', leg.id)
    load()
  }

  // ── Delete multi ──────────────────────────────────────────────────────────
  async function handleDeleteMulti(multi) {
    if (!confirm(`Delete "${multi.week_label}"? This cannot be undone.`)) return
    await supabase.from('weekly_multis').delete().eq('id', multi.id)
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
                  <th className="text-center pb-2">Missed</th>
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
                      <td className="py-2 text-center text-slate-400">{row.void || 0}</td>
                      <td className="py-2 text-center text-red-500">{row.missed > 0 ? '❌'.repeat(Math.min(row.missed, 5)) : '—'}</td>
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
            const wonCount = legs.filter((l) => l.outcome === 'won').length
            const lostCount = legs.filter((l) => l.outcome === 'lost').length
            const nonVoidLegs = legs.filter((l) => l.outcome !== 'void')
            const multiWon = nonVoidLegs.length > 0 && nonVoidLegs.every((l) => l.outcome === 'won')
            const multiLost = nonVoidLegs.some((l) => l.outcome === 'lost')
            const stake = parseFloat(multi.stake || 0)
            const winnings = multiWon && odds != null ? stake * odds : null
            const resolved = isResolved(multi)
            const isExpanded = !resolved || expandedResolved.has(multi.id)

            return (
              <div
                key={multi.id}
                className={`bg-slate-800 rounded-xl border p-5 space-y-4 ${resolved ? 'border-slate-700/50 opacity-80' : 'border-slate-700'}`}
              >
                {/* Multi header — always visible */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-white font-bold text-base">{multi.week_label}</h3>
                    {odds != null && (
                      <span className="text-slate-400 text-xs">
                        Combined odds:{' '}
                        <span className="text-white font-semibold">{odds.toFixed(2)}</span>
                      </span>
                    )}
                    {/* Stake — editable by admin */}
                    <span className="text-slate-400 text-xs flex items-center gap-1">
                      Stake:{' '}
                      {isAdmin && !resolved ? (
                        <>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={inlineStakes[multi.id] ?? (multi.stake > 0 ? multi.stake : '')}
                            onChange={(e) => setInlineStakes(s => ({ ...s, [multi.id]: e.target.value }))}
                            onBlur={(e) => saveInlineStake(multi, e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
                            placeholder="0"
                            className="w-16 bg-slate-700 border border-slate-600 focus:border-green-500 rounded px-1.5 py-0.5 text-white text-xs focus:outline-none"
                          />
                          {stakeMsg[multi.id] && (
                            <span className={stakeMsg[multi.id].ok ? 'text-green-400' : 'text-red-400'}>
                              {stakeMsg[multi.id].text}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-white font-semibold">${stake.toFixed(2)}</span>
                      )}
                    </span>
                    {/* Winnings when won */}
                    {winnings != null && (
                      <span className="text-green-400 font-bold text-sm">+${winnings.toFixed(2)}</span>
                    )}
                    {(wonCount > 0 || lostCount > 0) && (
                      <span className="text-xs text-slate-400">
                        <span className="text-green-400 font-semibold">{wonCount}W</span>
                        {' / '}
                        <span className="text-red-400 font-semibold">{lostCount}L</span>
                      </span>
                    )}
                    {/* Resolved outcome badge */}
                    {resolved && (
                      <span className={`text-xs px-2 py-0.5 rounded border font-semibold ${multiWon ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-red-500/20 text-red-400 border-red-500/30'}`}>
                        {multiWon ? 'WON' : 'LOST'}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    {isAdmin && !resolved && (
                      <>
                        <label className={`text-xs cursor-pointer transition-colors ${slipUploading ? 'text-slate-500 cursor-wait' : 'text-slate-400 hover:text-blue-400'}`}>
                          {slipUploading ? 'Reading slip…' : '📋 Upload Bet Slip'}
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            disabled={slipUploading}
                            onChange={(e) => handleSlipUpload(multi.id, e)}
                          />
                        </label>
                        <button
                          onClick={() => handleDeleteMulti(multi)}
                          className="text-xs text-slate-500 hover:text-red-400 transition-colors"
                        >
                          Delete
                        </button>
                      </>
                    )}
                    {/* Collapse toggle for resolved multis */}
                    {resolved && (
                      <button
                        onClick={() => toggleResolved(multi.id)}
                        className="text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
                      >
                        {isExpanded ? 'Hide legs ▴' : 'Show legs ▾'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Legs table — hidden for resolved multis when collapsed */}
                {isExpanded && (
                  <>
                    {legs.length > 0 ? (
                      <div className="space-y-2">
                        {legs.map((leg) => {
                          const isMyLeg =
                            (leg.persona_id && leg.persona_id === myPersona?.id) ||
                            (!leg.persona_id && leg.assigned_user_id === user?.id)
                          const legName = legEmoji(leg) || legPersonaName(leg)
                          const canEdit = isMyLeg || isAdmin
                          const hasFullDetails = leg.event || leg.selection

                          const isMissed = leg.outcome === 'missed'
                          return (
                            <div
                              key={leg.id}
                              className={`rounded-lg px-3 py-2.5 ${isMissed ? 'bg-red-900/10 border border-red-500/20' : 'bg-slate-900/70'}`}
                            >
                              {/* Row 1: name | inline input | odds | outcome */}
                              <div className="flex items-center gap-2">
                                <span className={`text-xl shrink-0 w-8 text-center ${isMyLeg ? 'ring-1 ring-green-500/50 rounded' : ''} ${isMissed ? 'opacity-40' : ''}`}>
                                  {legName}
                                </span>

                                {isMissed ? (
                                  <span className="flex-1 text-xs text-red-400 italic">❌ Missed this week</span>
                                ) : (
                                  <>
                                    {/* Inline pick field — editable if open & can edit, otherwise read-only */}
                                    {canEdit && !hasFullDetails ? (
                                      <input
                                        type="text"
                                        value={inlinePicks[leg.id] ?? (leg.raw_pick || '')}
                                        onChange={(e) => setInlinePicks(p => ({ ...p, [leg.id]: e.target.value }))}
                                        onBlur={() => saveInlinePick(leg)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') { e.target.blur() } }}
                                        placeholder={isMyLeg ? 'e.g. Cats -16.5' : 'waiting...'}
                                        className="flex-1 min-w-0 bg-slate-800 border border-slate-600 focus:border-green-500 rounded px-2 py-1 text-sm text-white placeholder-slate-600 focus:outline-none transition-colors"
                                      />
                                    ) : (
                                      <span className="flex-1 min-w-0 text-sm truncate">
                                        {hasFullDetails ? (
                                          <>
                                            <span className="text-slate-200">{leg.selection || leg.event}</span>
                                            {leg.description && <span className="text-slate-500"> · {leg.description}</span>}
                                          </>
                                        ) : leg.raw_pick ? (
                                          <span className="text-slate-300 italic">{leg.raw_pick}</span>
                                        ) : (
                                          <span className="text-slate-600 italic text-xs">Waiting for pick...</span>
                                        )}
                                      </span>
                                    )}

                                    {leg.odds != null && (
                                      <span className="text-slate-400 text-xs shrink-0">@ {parseFloat(leg.odds).toFixed(2)}</span>
                                    )}
                                    {multi.is_live && <OutcomePill outcome={leg.outcome} />}
                                    {isAdmin && multi.is_live && (
                                      <button
                                        onClick={() => openOverride(leg)}
                                        className="text-xs text-slate-500 hover:text-yellow-400 transition-colors shrink-0"
                                      >
                                        Result
                                      </button>
                                    )}
                                  </>
                                )}

                                {/* Remove leg — anyone can mark as missed before bet is live */}
                                {!multi.is_live && !isMissed && (
                                  <button
                                    onClick={() => handleRemoveLeg(leg)}
                                    className="text-xs text-slate-600 hover:text-red-400 transition-colors shrink-0 ml-1"
                                    title="Mark as missed"
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>

                              {/* Row 2: full event detail (after slip upload) */}
                              {hasFullDetails && leg.event && leg.event !== leg.selection && (
                                <div className="mt-1 ml-[6.5rem] text-xs text-slate-500">{leg.event}</div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-slate-600 text-sm italic">No legs added yet.</p>
                    )}

                    {/* Add member slot (admin, active only) */}
                    {isAdmin && !resolved && (
                      <button
                        onClick={() => setAddingLeg(multi.id)}
                        className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                      >
                        + Add member slot
                      </button>
                    )}
                  </>
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
            <div>
              <label className="block text-xs text-slate-400 mb-1">Stake ($)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={newStake}
                onChange={(e) => setNewStake(e.target.value)}
                placeholder="e.g. 20"
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
                Auto-add all {personas.length} personas as leg slots
              </span>
            </label>
            {createError && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{createError}</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={handleCreateMulti}
                disabled={creating || !weekLabel.trim()}
                className="flex-1 bg-green-500 hover:bg-green-400 text-white font-semibold rounded-lg py-2 text-sm transition-colors disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
              <button
                onClick={() => { setShowCreate(false); setWeekLabel(''); setNewStake(''); setCreateError('') }}
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
              <label className="block text-xs text-slate-400 mb-1">Persona</label>
              <select
                value={legAssignee}
                onChange={(e) => { setLegAssignee(e.target.value); setLegAssigneeName('') }}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
              >
                <option value="">— Select persona —</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.emoji} {p.nickname}{!p.claimed_by ? ' (unclaimed)' : ''}
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
            <h3 className="text-white font-semibold">
              {isAdmin ? 'Edit Pick' : 'Enter Your Pick'}
            </h3>

            {/* Raw pick — everyone */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">Your pick</label>
              <input
                type="text"
                value={legForm.raw_pick}
                onChange={(e) => setLegForm((f) => ({ ...f, raw_pick: e.target.value }))}
                placeholder='e.g. "Cats -16.5" or "Storm h2h"'
                autoFocus
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
              />
              {!isAdmin && (
                <p className="text-xs text-slate-500 mt-1">
                  Keep it short — just the team and line/market. Full details are filled in when the bet slip is uploaded.
                </p>
              )}
            </div>

            {/* Full details — admin only */}
            {isAdmin && (
              <>
                <p className="text-xs text-slate-500 -mt-2">Full details (filled automatically when bet slip is uploaded)</p>
                {[
                  { key: 'event', label: 'Event', placeholder: 'e.g. Collingwood vs Carlton' },
                  { key: 'description', label: 'Market', placeholder: 'e.g. Head to Head' },
                  { key: 'selection', label: 'Selection', placeholder: 'e.g. Collingwood (+35.5)' },
                  { key: 'odds', label: 'Odds', placeholder: 'e.g. 1.32', type: 'number' },
                  { key: 'event_time', label: 'Event Date & Time AEST', placeholder: '', type: 'datetime-local' },
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
              </>
            )}

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

      {/* Bet slip match preview */}
      {slipPreview && (() => {
        const unmatched = slipPreview.unmatched_slip_legs || []
        // Leg IDs that already have an auto-match
        const autoMatchedLegIds = new Set(slipPreview.matches.filter(m => m.matched && m.leg_id).map(m => m.leg_id))
        // Leg IDs assigned via manual assignment
        const manuallyAssignedLegIds = new Set(Object.values(manualAssignments))
        // Available legs for assignment: picks that aren't auto-matched and aren't already manually assigned
        const availableForAssignment = slipPreview.matches.filter(
          m => !m.matched && m.leg_id && !manuallyAssignedLegIds.has(m.leg_id)
        )

        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-xl border border-slate-700 p-6 w-full max-w-lg space-y-4">
              <h3 className="text-white font-semibold">Confirm Bet Slip Matches</h3>
              <p className="text-xs text-slate-500">Review how Claude matched each pick to the bet slip.</p>

              <div className="space-y-2 max-h-96 overflow-y-auto">
                {/* Auto-matched picks */}
                {slipPreview.matches.map((m, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg ${m.matched ? 'bg-slate-900/70' : 'bg-slate-900/40 border border-slate-700'}`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-semibold text-slate-200 shrink-0">{m.member_name}</span>
                        {m.raw_pick && (
                          <span className="text-slate-500 text-xs italic truncate">"{m.raw_pick}"</span>
                        )}
                      </div>
                      {m.matched
                        ? <span className="text-green-400 text-xs shrink-0">✓ Matched</span>
                        : <span className="text-slate-500 text-xs shrink-0">— no slip match</span>
                      }
                    </div>
                    {m.matched && (
                      <div className="text-xs text-slate-400 flex flex-wrap items-center gap-x-1">
                        {m.event && <span className="text-slate-300">{m.event}</span>}
                        {m.description && <span>· {m.description}</span>}
                        {m.selection && <span className="text-green-400">· {m.selection}</span>}
                        {m.odds && <span className="text-white font-medium">@ {parseFloat(m.odds).toFixed(2)}</span>}
                        {m.outcome && m.outcome !== 'pending' && (
                          <span className={`ml-1 px-1.5 py-0.5 rounded border text-xs font-semibold ${outcomeBadge(m.outcome)}`}>{m.outcome}</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {/* Unmatched slip legs — user assigns to a persona */}
                {unmatched.length > 0 && (
                  <div className="pt-2 space-y-2">
                    <p className="text-xs text-amber-400 font-semibold">Unrecognised slip legs — assign manually:</p>
                    {unmatched.map((sl, si) => {
                      const assignedLegId = manualAssignments[si]
                      return (
                        <div key={si} className="p-3 rounded-lg bg-amber-900/20 border border-amber-500/30 space-y-2">
                          <div className="text-xs text-slate-300 flex flex-wrap items-center gap-x-1">
                            {sl.event && <span>{sl.event}</span>}
                            {sl.description && <span className="text-slate-400">· {sl.description}</span>}
                            {sl.selection && <span className="text-green-400">· {sl.selection}</span>}
                            {sl.odds && <span className="text-white font-medium">@ {parseFloat(sl.odds).toFixed(2)}</span>}
                            {sl.outcome && sl.outcome !== 'pending' && (
                              <span className={`ml-1 px-1.5 py-0.5 rounded border text-xs font-semibold ${outcomeBadge(sl.outcome)}`}>{sl.outcome}</span>
                            )}
                          </div>
                          <select
                            value={assignedLegId || ''}
                            onChange={e => {
                              const val = e.target.value
                              setManualAssignments(prev => {
                                const next = { ...prev }
                                // Clear any other slip leg that was assigned to this legId
                                for (const k of Object.keys(next)) {
                                  if (next[k] === val) delete next[k]
                                }
                                if (val) next[si] = val
                                else delete next[si]
                                return next
                              })
                            }}
                            className="w-full text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-200 focus:outline-none"
                          >
                            <option value="">— assign to persona —</option>
                            {availableForAssignment
                              .filter(m => !manuallyAssignedLegIds.has(m.leg_id) || assignedLegId === m.leg_id)
                              .map(m => (
                                <option key={m.leg_id} value={m.leg_id}>{m.member_name}{m.raw_pick ? ` — "${m.raw_pick}"` : ''}</option>
                              ))
                            }
                          </select>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleConfirmSlip}
                  className="flex-1 bg-green-500 hover:bg-green-400 text-white font-semibold rounded-lg py-2 text-sm transition-colors"
                >
                  Confirm & Save
                </button>
                <button
                  onClick={() => { setSlipPreview(null); setManualAssignments({}) }}
                  className="flex-1 border border-slate-600 text-slate-300 hover:text-white rounded-lg py-2 text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )
      })()}

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
