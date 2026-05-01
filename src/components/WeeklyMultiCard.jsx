import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { formatCurrency, profitLossColor, eventTimeToDate, formatEventTime, isCashedOut } from '../lib/utils'
import { usePersonas } from '../hooks/usePersonas'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { fileToResizedBase64 } from '../utils/resizeImage'

function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function formatDiff(ms) {
  const d = Math.floor(ms / 86400000)
  const h = Math.floor((ms % 86400000) / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join(' ')
}

function CountdownBadge({ eventTime }) {
  const now = useNow()
  if (!eventTime) return null
  const target = eventTimeToDate(eventTime)
  if (!target) return null
  const diff = target - now
  if (diff < -10800000) return null
  if (diff <= 0) return <span className="text-red-400 text-xs font-semibold animate-pulse">● Live</span>
  const color = diff >= 86400000 ? 'text-slate-400' : diff < 3600000 ? 'text-orange-400' : 'text-yellow-400'
  return <span className={`${color} text-xs font-medium tabular-nums`}>⏱ {formatDiff(diff)}</span>
}

function NextEventBar({ legs }) {
  const now = useNow()
  const pendingLegs = legs.filter(l => l.outcome === 'pending' || !l.outcome)
  const upcoming = pendingLegs
    .filter(l => l.event_time)
    .map(l => ({ t: l.event_time, d: eventTimeToDate(l.event_time) }))
    .filter(l => l.d)
    .sort((a, b) => a.d - b.d)

  // No legs have event_time set — show how many legs are still pending
  if (!upcoming.length) {
    if (!pendingLegs.length) return null
    return (
      <div className="flex items-center gap-2 rounded-lg px-3 py-2 bg-slate-700/40 border border-slate-600/40">
        <span className="text-slate-400 text-xs">Pending:</span>
        <span className="text-slate-300 text-sm font-medium">{pendingLegs.length} leg{pendingLegs.length !== 1 ? 's' : ''} remaining</span>
        <span className="text-slate-500 text-xs ml-auto">No times set</span>
      </div>
    )
  }

  const { t, d } = upcoming[0]
  const diff = d - now
  if (diff < -10800000) return null
  if (diff <= 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg px-3 py-2 bg-red-500/10 border border-red-500/30">
        <span className="text-slate-400 text-xs">Next leg:</span>
        <span className="text-red-400 text-sm font-semibold animate-pulse">● Live now</span>
        <span className="text-slate-500 text-xs ml-auto">{formatEventTime(t)}</span>
      </div>
    )
  }
  const color = diff >= 86400000 ? 'text-slate-200' : diff < 3600000 ? 'text-orange-400' : 'text-yellow-400'
  const bg    = diff >= 86400000 ? 'bg-slate-700/40 border-slate-600/40' : diff < 3600000 ? 'bg-orange-500/10 border-orange-500/30' : 'bg-yellow-500/10 border-yellow-500/30'
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 border ${bg}`}>
      <span className="text-slate-400 text-xs">Next leg:</span>
      <span className={`${color} text-sm font-bold tabular-nums`}>{formatDiff(diff)}</span>
      <span className="text-slate-500 text-xs ml-auto">{formatEventTime(t)}</span>
    </div>
  )
}

function combinedOdds(legs) {
  const entered = legs.filter(l => l.odds != null && parseFloat(l.odds) > 0)
  if (entered.length === 0) return null
  return entered.reduce((acc, l) => acc * parseFloat(l.odds), 1)
}

function deriveOutcome(legs) {
  const countable = legs.filter(l => l.outcome !== 'void' && l.outcome !== 'missed')
  if (countable.length === 0) return 'pending'
  if (countable.some(l => l.outcome === 'pending')) return 'pending'
  if (countable.some(l => l.outcome === 'lost')) return 'lost'
  return 'won'
}

function outcomeBadgeClass(outcome) {
  switch (outcome) {
    case 'won':     return 'bg-green-500/20 text-green-400 border-green-500/30'
    case 'lost':    return 'bg-red-500/20 text-red-400 border-red-500/30'
    case 'void':    return 'bg-slate-500/20 text-slate-400 border-slate-500/30'
    default:        return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  }
}

const LEG_OUTCOMES = ['pending', 'won', 'lost', 'void']

export default function WeeklyMultiCard({ multi, onUpdate, defaultExpanded = false }) {
  const { profile, user } = useAuth()
  const { byUserId, byPersonaId } = usePersonas()
  const isAdmin = profile?.is_admin

  // The persona claimed by the current user (used to detect their own leg)
  const myPersona = user ? byUserId[user.id] : null
  const isMyLeg = (leg) => {
    if (leg.persona_id && myPersona) return leg.persona_id === myPersona.id
    return !!(leg.assigned_user_id && leg.assigned_user_id === user?.id)
  }

  const [expanded, setExpanded] = useState(defaultExpanded)
  const [uploading, setUploading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [msg, setMsg] = useState(null)
  const [savingLeg, setSavingLeg] = useState({})
  const [inlinePicks, setInlinePicks] = useState({})
  const [savingPick, setSavingPick] = useState({})
  const [savingCashOut, setSavingCashOut] = useState(false)
  const cashedOut = isCashedOut(multi)

  // Inline cash-out toggle for the weekly multi. Selecting "cashed out" prompts
  // for the gross payout value; any other choice clears the flag.
  async function handleCashOutChange(action) {
    if (action === 'set') {
      const existing = multi.cash_out_value != null ? String(multi.cash_out_value) : ''
      const raw = window.prompt('Enter cash-out value (AUD, includes stake):', existing)
      if (raw === null) return
      const num = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''))
      if (!num || num <= 0) {
        alert('Invalid cash-out value — must be greater than $0.')
        return
      }
      setSavingCashOut(true)
      await supabase
        .from('weekly_multis')
        .update({ cashed_out: true, cash_out_value: num, updated_at: new Date().toISOString() })
        .eq('id', multi.id)
      setSavingCashOut(false)
      onUpdate?.()
    } else if (action === 'clear') {
      if (!confirm('Remove cash-out from this multi?')) return
      setSavingCashOut(true)
      await supabase
        .from('weekly_multis')
        .update({ cashed_out: false, cash_out_value: null, updated_at: new Date().toISOString() })
        .eq('id', multi.id)
      setSavingCashOut(false)
      onUpdate?.()
    }
  }

  const legs = [...(multi.weekly_multi_legs || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  // Auto-expand when the user's own leg has no pick yet (prompt them to enter it)
  useEffect(() => {
    if (!multi.is_live && legs.some(l => isMyLeg(l) && !l.raw_pick && !l.selection)) {
      setExpanded(true)
    }
  }, [multi.id])

  async function saveInlinePick(leg) {
    const value = inlinePicks[leg.id]
    if (value === undefined) return
    if (value.trim() === (leg.raw_pick || '').trim()) return
    setSavingPick(s => ({ ...s, [leg.id]: true }))
    await supabase.from('weekly_multi_legs').update({
      raw_pick: value.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('id', leg.id)
    setSavingPick(s => ({ ...s, [leg.id]: false }))
    onUpdate?.()
  }

  const odds = combinedOdds(legs)
  const baseOutcome = deriveOutcome(legs)
  // Cashed-out multis settle at cash_out_value regardless of leg outcomes —
  // legs continue to update for record/display, but settlement is locked.
  const outcome = cashedOut ? 'won' : baseOutcome
  const stake = parseFloat(multi.stake || 0)
  const winnings = cashedOut
    ? parseFloat(multi.cash_out_value || 0)
    : (outcome === 'won' && odds != null ? stake * odds : 0)
  const pl = cashedOut
    ? winnings - stake
    : (outcome === 'won' ? winnings - stake : outcome === 'lost' ? -stake : 0)
  const handleCheck = async () => {
    setChecking(true)
    setMsg(null)
    try {
      const res = await fetch('/api/check-weekly-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multiId: multi.id, userId: user?.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Server error')
      if (data.checked === 0) {
        setMsg({ type: 'info', text: 'No pending legs to check.' })
      } else {
        setMsg({
          type: 'ok',
          text: `Checked ${data.checked} leg${data.checked !== 1 ? 's' : ''} — ${data.multiOutcome.toUpperCase()}. ${data.message || 'Refreshing…'}`,
        })
        onUpdate?.()
      }
    } catch (err) {
      setMsg({ type: 'warn', text: `Error: ${err.message}` })
    } finally {
      setChecking(false)
    }
  }

  const handleResultUpload = async (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setUploading(true)
    setMsg(null)
    try {
      const images = await Promise.all(files.map(fileToResizedBase64))
      const res = await fetch('/api/extract-weekly-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, multiId: multi.id, userId: user?.id }),
      })
      const text = await res.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(text.substring(0, 200)) }
      if (!res.ok) throw new Error(data.error || 'Server error')
      const label = files.length > 1 ? ` (${files.length} screenshots)` : ''
      setMsg({ type: 'ok', text: `Updated ${data.updatedLegs} leg${data.updatedLegs !== 1 ? 's' : ''}${label} — ${data.multiOutcome.toUpperCase()}. Refreshing…` })
      onUpdate?.()
    } catch (err) {
      setMsg({ type: 'warn', text: `Error: ${err.message}` })
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  async function saveLegOutcome(legId, newOutcome) {
    setSavingLeg(s => ({ ...s, [legId]: true }))
    await supabase.from('weekly_multi_legs').update({ outcome: newOutcome }).eq('id', legId)
    setSavingLeg(s => ({ ...s, [legId]: false }))
    onUpdate?.()
  }

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 font-semibold">
              WEEKLY
            </span>
            {odds != null && (
              <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300">
                {odds.toFixed(2)} odds
              </span>
            )}
          </div>
          <p className="text-white font-medium leading-snug">{multi.week_label}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {(outcome === 'won' || cashedOut) && winnings > 0 && (
            <span className="text-green-400 font-bold text-lg leading-none">
              +${winnings.toFixed(2)}
            </span>
          )}
          {cashedOut ? (
            <span
              title={`Cashed out at $${parseFloat(multi.cash_out_value).toFixed(2)}`}
              className="text-xs px-2 py-0.5 rounded border bg-amber-500/20 text-amber-300 border-amber-500/40 font-semibold"
            >
              💰 cashed out
            </span>
          ) : (
            <span className={`text-xs px-2 py-0.5 rounded border ${outcomeBadgeClass(outcome)}`}>
              {outcome}
            </span>
          )}
        </div>
      </div>

      {/* Stats + actions row — stats stacked left (compact), actions wrap right */}
      <div className="flex items-start justify-between gap-3 pt-2 border-t border-slate-700/60">
        <div className="flex flex-col text-xs gap-0.5 shrink-0 leading-snug">
          {odds != null && (
            <div>
              <span className="text-slate-500">Odds </span>
              <span className="text-white font-medium">{odds.toFixed(2)}</span>
            </div>
          )}
          <div>
            <span className="text-slate-500">Stake </span>
            <span className="text-white font-medium">${stake.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-slate-500">P&L </span>
            <span className={`font-medium ${profitLossColor(pl)}`}>{formatCurrency(pl)}</span>
          </div>
        </div>

        <div className="flex flex-wrap justify-end items-center gap-x-3 gap-y-1.5 flex-1 min-w-0">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            {expanded ? `Hide legs ▴` : `${legs.length} legs ▾`}
          </button>

          {/* Check + Results only available once bet slip has been uploaded and bet is live */}
          {multi.is_live ? (
            <>
              <button
                onClick={handleCheck}
                disabled={checking || uploading}
                className="text-xs text-yellow-400 hover:text-yellow-300 disabled:opacity-50 transition-colors"
              >
                {checking ? 'Checking…' : '🔍 Check'}
              </button>

              <label className={`text-xs cursor-pointer transition-colors ${uploading ? 'text-slate-500' : 'text-slate-400 hover:text-blue-400'}`}>
                {uploading ? 'Reading…' : '📷 Results'}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  disabled={uploading}
                  onChange={handleResultUpload}
                />
              </label>
            </>
          ) : (
            <span className="text-xs text-slate-600 italic">Awaiting bet slip</span>
          )}

          {isAdmin && (
            <button
              onClick={() => handleCashOutChange(cashedOut ? 'clear' : 'set')}
              disabled={savingCashOut}
              className={`text-xs transition-colors disabled:opacity-50 ${cashedOut ? 'text-amber-400 hover:text-amber-300' : 'text-slate-400 hover:text-amber-400'}`}
              title={cashedOut ? 'Remove cash-out' : 'Mark this multi as cashed out'}
            >
              💰 {cashedOut ? 'Cash-Out ✓' : 'Cash Out'}
            </button>
          )}

          <Link
            to="/weekly-multi"
            className="text-xs text-slate-400 hover:text-purple-400 transition-colors"
          >
            Manage →
          </Link>
        </div>
      </div>

      {/* Next leg countdown — shown when multi is still pending */}
      {outcome === 'pending' && <NextEventBar legs={legs} />}

      {/* Result message */}
      {msg && (
        <div className={`text-xs px-3 py-2 rounded-lg border ${
          msg.type === 'ok'   ? 'bg-green-500/10 border-green-500/30 text-green-400'
          : msg.type === 'warn' ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400'
          : 'bg-slate-700/50 border-slate-600 text-slate-400'
        }`}>
          {msg.text}
        </div>
      )}

      {/* Expanded legs */}
      {expanded && (
        <div className="space-y-1.5 pt-1">
          {cashedOut && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-md px-4 py-3 text-sm flex items-center justify-between flex-wrap gap-2">
              <span className="text-amber-300 font-semibold">💰 Cashed out</span>
              <span className="text-slate-300">
                Settled at <span className="text-green-400 font-semibold">${parseFloat(multi.cash_out_value).toFixed(2)}</span>
                {odds != null && (
                  <span className="text-slate-500 text-xs"> (vs potential ${(stake * odds).toFixed(2)})</span>
                )}
              </span>
            </div>
          )}
          {legs.map((leg) => {
            const persona = (leg.persona_id && byPersonaId[leg.persona_id])
              || (leg.assigned_user_id && byUserId[leg.assigned_user_id])
            const label = persona ? persona.emoji : (leg.assigned_name || '?')
            const mine = isMyLeg(leg)
            const isMissed = leg.outcome === 'missed'
            const canEnterPick = mine && !multi.is_live && !isMissed
            const currentPick = inlinePicks[leg.id] ?? leg.raw_pick ?? ''
            return (
              <div key={leg.id} className={`rounded-md px-3 py-2 ${isMissed ? 'bg-red-950/40 border border-red-800/30' : 'bg-slate-900/80'}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-base mr-1">{label}</span>
                      {isMissed ? (
                        <span className="text-red-400 text-xs italic">❌ Missed this week</span>
                      ) : leg.selection || leg.event ? (
                        <>
                          <span className="text-sm text-white">{leg.event}</span>
                          {leg.description && <span className="text-slate-400 text-sm"> — {leg.description}</span>}
                          {leg.selection && <span className="text-green-400 text-sm font-medium"> · {leg.selection}</span>}
                        </>
                      ) : leg.raw_pick ? (
                        <span className={`text-sm italic ${mine ? 'text-slate-200' : 'text-slate-400'}`}>{leg.raw_pick}</span>
                      ) : canEnterPick ? (
                        <span className="text-purple-400 text-xs italic animate-pulse">Tap below to enter your pick ↓</span>
                      ) : (
                        <span className="text-slate-600 text-xs italic">No pick</span>
                      )}
                    </div>
                    {leg.event_time && !canEnterPick && (
                      <div className="flex items-center gap-2 mt-0.5 ml-7">
                        <span className="text-slate-500 text-xs">{formatEventTime(leg.event_time)}</span>
                        <CountdownBadge eventTime={leg.event_time} />
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {leg.odds != null && (
                      <span className="text-slate-400 text-sm">{parseFloat(leg.odds).toFixed(2)}</span>
                    )}
                    {multi.is_live && (
                      isAdmin ? (
                        <select
                          value={leg.outcome || 'pending'}
                          onChange={(e) => saveLegOutcome(leg.id, e.target.value)}
                          disabled={savingLeg[leg.id]}
                          className={`text-xs px-1.5 py-0.5 rounded border bg-slate-800 focus:outline-none focus:border-slate-500 ${outcomeBadgeClass(leg.outcome)}`}
                        >
                          {LEG_OUTCOMES.map(o => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                      ) : (
                        <span className={`text-xs px-1.5 py-0.5 rounded border ${outcomeBadgeClass(leg.outcome)}`}>
                          {leg.outcome}
                        </span>
                      )
                    )}
                  </div>
                </div>

                {/* Inline pick entry — only for the user's own leg before bet goes live */}
                {canEnterPick && (
                  <div className="flex gap-2 mt-2">
                    <input
                      type="text"
                      value={currentPick}
                      onChange={e => setInlinePicks(s => ({ ...s, [leg.id]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && saveInlinePick(leg)}
                      onBlur={() => saveInlinePick(leg)}
                      placeholder="Enter your pick e.g. Collingwood +17.5"
                      className="flex-1 bg-slate-700 border border-purple-500/40 rounded px-2.5 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-400"
                    />
                    <button
                      onClick={() => saveInlinePick(leg)}
                      disabled={savingPick[leg.id]}
                      className="text-xs px-3 py-1.5 bg-purple-500/20 text-purple-300 rounded border border-purple-500/30 hover:bg-purple-500/30 disabled:opacity-50 transition-colors shrink-0"
                    >
                      {savingPick[leg.id] ? '…' : 'Save'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
