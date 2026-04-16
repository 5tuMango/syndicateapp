import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { calcProfitLoss, formatCurrency, outcomeBadge, profitLossColor, eventTimeToDate, formatEventTime } from '../lib/utils'
import { supabase } from '../lib/supabase'
import { usePersonas } from '../hooks/usePersonas'

// ── Single hook: current timestamp, ticks every second ───────────────────────
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

// ── Shared: ms → "Xd Xh Xm Xs" ──────────────────────────────────────────────
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

// ── Inline badge next to a leg's time ────────────────────────────────────────
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

// ── Prominent countdown bar on the collapsed card face ────────────────────────
function NextEventBar({ eventTime, legs }) {
  const now = useNow()

  // Pick the target: single bet uses eventTime, multi uses earliest upcoming leg
  const { targetTime, targetDate } = (() => {
    if (eventTime) {
      const d = eventTimeToDate(eventTime)
      return { targetTime: eventTime, targetDate: d }
    }
    if (legs?.length) {
      const upcoming = legs
        .filter((l) => l.event_time)
        .map((l) => ({ t: l.event_time, d: eventTimeToDate(l.event_time) }))
        .filter((l) => l.d && l.d.getTime() > now)
        .sort((a, b) => a.d - b.d)
      if (upcoming.length) return { targetTime: upcoming[0].t, targetDate: upcoming[0].d }
    }
    return { targetTime: null, targetDate: null }
  })()

  if (!targetDate || !targetTime) return null

  const diff = targetDate - now
  if (diff < -10800000) return null   // > 3h past
  const label = legs?.length ? 'Next leg' : 'Starts'

  if (diff <= 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg px-3 py-2 bg-red-500/10 border border-red-500/30">
        <span className="text-slate-400 text-xs">{label}:</span>
        <span className="text-red-400 text-sm font-semibold animate-pulse">● Live now</span>
        <span className="text-slate-500 text-xs ml-auto">{formatEventTime(targetTime)}</span>
      </div>
    )
  }

  const color = diff >= 86400000 ? 'text-slate-200' : diff < 3600000 ? 'text-orange-400' : 'text-yellow-400'
  const bg    = diff >= 86400000 ? 'bg-slate-700/40 border-slate-600/40' : diff < 3600000 ? 'bg-orange-500/10 border-orange-500/30' : 'bg-yellow-500/10 border-yellow-500/30'

  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 border ${bg}`}>
      <span className="text-slate-400 text-xs">{label}:</span>
      <span className={`${color} text-sm font-bold tabular-nums`}>{formatDiff(diff)}</span>
      <span className="text-slate-500 text-xs ml-auto">{formatEventTime(targetTime)}</span>
    </div>
  )
}

// Build display groups: SGM sub-legs are nested under a group header; standalone legs shown flat
function renderGroupedLegs(legs) {
  const sorted = [...legs].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  const rendered = []
  const seenGroups = {}
  let standaloneIdx = 0

  for (const leg of sorted) {
    if (!leg.leg_group) {
      standaloneIdx++
      rendered.push(
        <div
          key={leg.id}
          className="bg-slate-900/80 rounded-md px-3 py-2 flex items-center justify-between gap-3"
        >
          <div className="flex-1 min-w-0">
            <div>
              {leg.sport && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 mr-2">{leg.sport}</span>
              )}
              <span className="text-sm text-white">{leg.event}</span>
              {leg.description && <span className="text-slate-400 text-sm"> — {leg.description}</span>}
              {leg.selection && <span className="text-green-400 text-sm font-medium"> · {leg.selection}</span>}
            </div>
            {leg.event_time && (
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-slate-500 text-xs">{formatEventTime(leg.event_time)}</span>
                <CountdownBadge eventTime={leg.event_time} />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {leg.odds != null && (
              <span className="text-slate-300 text-sm">{parseFloat(leg.odds).toFixed(2)}</span>
            )}
            <OutcomePill outcome={leg.outcome} />
          </div>
        </div>
      )
    } else {
      // First time we see this group — create the group container
      if (!seenGroups[leg.leg_group]) {
        const groupLegs = sorted.filter((l) => l.leg_group === leg.leg_group)
        const groupOdds = leg.group_odds
        seenGroups[leg.leg_group] = true
        rendered.push(
          <div key={`sgm-${leg.leg_group}`} className="rounded-md overflow-hidden border border-purple-700/40">
            {/* SGM group header */}
            <div className="bg-purple-900/30 px-3 py-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {leg.sport && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-300">{leg.sport}</span>
                  )}
                  <span className="text-xs font-semibold text-purple-400">SGM — {leg.event}</span>
                </div>
              {groupOdds != null && (
                  <span className="text-slate-300 text-sm">{parseFloat(groupOdds).toFixed(2)}</span>
                )}
              </div>
              {/* Show time + countdown from first leg in group */}
              {leg.event_time && (
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-slate-500 text-xs">{formatEventTime(leg.event_time)}</span>
                  <CountdownBadge eventTime={leg.event_time} />
                </div>
              )}
            </div>
            {/* SGM sub-legs */}
            {groupLegs.map((gl) => (
              <div
                key={gl.id}
                className="bg-slate-900/80 px-4 py-2 flex items-center justify-between gap-3 border-t border-slate-800/60"
              >
                <div className="flex-1 min-w-0 text-sm">
                  {gl.description && <span className="text-slate-400">{gl.description}</span>}
                  {gl.selection && <span className="text-green-400 font-medium"> · {gl.selection}</span>}
                </div>
                <OutcomePill outcome={gl.outcome} />
              </div>
            ))}
          </div>
        )
      }
    }
  }
  return rendered
}

function OutcomePill({ outcome }) {
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border ${outcomeBadge(outcome)}`}>
      {outcome}
    </span>
  )
}

const OVERRIDE_OUTCOMES = ['won', 'lost', 'void', 'pending']

export default function BetCard({ bet, onDelete, onUpdate, showMember = true }) {
  const { user, profile } = useAuth()
  const personaMap = usePersonas()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkMsg, setCheckMsg] = useState(null) // { type: 'ok'|'info'|'warn', text }
  const [uploadingResult, setUploadingResult] = useState(false)

  // Admin outcome override
  const [overridingOutcome, setOverridingOutcome] = useState(false)
  const [overrideResult, setOverrideResult] = useState(bet.outcome)
  const [savingOverride, setSavingOverride] = useState(false)

  const isOwner = user?.id === bet.user_id
  const pl = calcProfitLoss(bet)
  const member = bet.profiles
  const persona = personaMap[bet.user_id]
  const displayName = persona
    ? `${persona.emoji} ${persona.nickname}`
    : (member?.full_name || member?.username || 'Unknown')
  const legs = bet.bet_legs || []
  const isMulti = bet.bet_type === 'multi'

  const handleDelete = async () => {
    if (!confirm('Delete this bet? This cannot be undone.')) return
    setDeleting(true)
    const { error } = await supabase.from('bets').delete().eq('id', bet.id)
    if (!error) onDelete?.(bet.id)
    else setDeleting(false)
  }

  const handleCheckResult = async () => {
    setChecking(true)
    setCheckMsg(null)
    try {
      const res = await fetch('/api/check-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ betId: bet.id }),
      })
      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Server error')

      const result = data.results?.[0]
      if (!result) {
        setCheckMsg({ type: 'info', text: 'No result found — try again later.' })
        return
      }

      if (result.needs_review) {
        setCheckMsg({
          type: 'warn',
          text: '⚠ Void leg detected — open Edit Bet to review manually.',
        })
        return
      }

      if (result.outcome === 'pending') {
        const conf = result.confidence === 'low' ? ' (result not yet available)' : ''
        setCheckMsg({ type: 'info', text: `Still pending${conf}. ${result.reasoning || ''}`.trim() })
        return
      }

      // Outcome changed — notify parent to refresh this bet
      setCheckMsg({
        type: 'ok',
        text: `Result found: ${result.outcome.toUpperCase()} — refreshing…`,
      })
      onUpdate?.(bet.id)
    } catch (err) {
      setCheckMsg({ type: 'warn', text: `Error: ${err.message}` })
    } finally {
      setChecking(false)
    }
  }

  const handleSaveOverride = async () => {
    setSavingOverride(true)
    await supabase
      .from('bets')
      .update({ outcome: overrideResult, updated_at: new Date().toISOString() })
      .eq('id', bet.id)
    setSavingOverride(false)
    setOverridingOutcome(false)
    onUpdate?.(bet.id)
  }

  const handleResultScreenshot = async (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setUploadingResult(true)
    setCheckMsg(null)
    try {
      // Convert all selected images to base64 in parallel
      const images = await Promise.all(
        files.map(
          (file) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve({ imageBase64: reader.result.split(',')[1], mimeType: file.type })
              reader.onerror = reject
              reader.readAsDataURL(file)
            })
        )
      )
      const res = await fetch('/api/extract-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, betId: bet.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Server error')
      const screenshotLabel = files.length > 1 ? ` (${files.length} screenshots)` : ''
      setCheckMsg({
        type: 'ok',
        text: `Updated ${data.updatedLegs} leg${data.updatedLegs !== 1 ? 's' : ''}${screenshotLabel} — ${data.parentOutcome.toUpperCase()}. Refreshing…`,
      })
      onUpdate?.(bet.id)
    } catch (err) {
      setCheckMsg({ type: 'warn', text: `Error: ${err.message}` })
    } finally {
      setUploadingResult(false)
      // Reset the file input so the same files can be re-uploaded if needed
      e.target.value = ''
    }
  }

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {showMember && member && (
              <Link
                to={`/profile/${member.id}`}
                className="text-green-400 text-sm font-semibold hover:text-green-300 transition-colors"
              >
                {displayName}
              </Link>
            )}
            <span className="text-slate-500 text-xs">
              {new Date(bet.date + 'T00:00:00').toLocaleDateString('en-AU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300">
              {bet.sport}
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded border ${
                bet.bet_type === 'multi'
                  ? 'bg-purple-500/20 text-purple-400 border-purple-500/30'
                  : 'bg-blue-500/20 text-blue-400 border-blue-500/30'
              }`}
            >
              {bet.bet_type}
            </span>
          </div>
          <p className="text-white font-medium leading-snug">{bet.event}</p>
          {bet.notes && <p className="text-slate-400 text-sm mt-0.5">{bet.notes}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {bet.outcome === 'won' && (
            <span className="text-green-400 font-bold text-lg leading-none">
              +${(parseFloat(bet.stake) * parseFloat(bet.odds)).toFixed(2)}
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded border ${outcomeBadge(bet.outcome)}`}>
            {bet.outcome}
          </span>
        </div>
      </div>

      {/* Stats + actions row */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-700/60">
        <div className="flex gap-4 text-sm flex-wrap">
          <div>
            <span className="text-slate-500">Odds </span>
            <span className="text-white font-medium">{parseFloat(bet.odds).toFixed(2)}</span>
          </div>
          <div>
            <span className="text-slate-500">Stake </span>
            <span className="text-white font-medium">${parseFloat(bet.stake).toFixed(2)}</span>
          </div>
          <div>
            <span className="text-slate-500">P&L </span>
            <span className={`font-medium ${profitLossColor(pl)}`}>{formatCurrency(pl)}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {isMulti && legs.length > 0 ? (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              {expanded ? 'Hide legs ▴' : `${legs.length} legs ▾`}
            </button>
          ) : (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              {expanded ? 'Hide details ▴' : 'Details ▾'}
            </button>
          )}

          {/* Check Result — shown for pending bets OR bets with pending legs */}
          {(bet.outcome === 'pending' || legs.some((l) => l.outcome === 'pending')) && (
            <>
              <button
                onClick={handleCheckResult}
                disabled={checking || uploadingResult}
                className="text-xs text-yellow-400 hover:text-yellow-300 disabled:opacity-50 transition-colors"
              >
                {checking ? 'Checking…' : '🔍 Check'}
              </button>
              <label className={`text-xs cursor-pointer transition-colors ${uploadingResult ? 'text-slate-500' : 'text-slate-400 hover:text-blue-400'}`}>
                {uploadingResult ? 'Reading…' : '📷 Results'}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  disabled={uploadingResult || checking}
                  onChange={handleResultScreenshot}
                />
              </label>
            </>
          )}

          {isOwner && (
            <>
              <button
                onClick={() => navigate(`/edit-bet/${bet.id}`)}
                className="text-xs text-slate-400 hover:text-blue-400 transition-colors"
              >
                Edit
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="text-xs text-slate-400 hover:text-red-400 transition-colors disabled:opacity-50"
              >
                {deleting ? '...' : 'Delete'}
              </button>
            </>
          )}
          {profile?.is_admin && (
            <button
              onClick={() => {
                setOverrideResult(bet.outcome)
                setOverridingOutcome((v) => !v)
              }}
              className="text-xs text-slate-400 hover:text-yellow-400 transition-colors"
            >
              Override
            </button>
          )}
        </div>
      </div>

      {/* Next event countdown bar — visible on collapsed card for pending bets */}
      {bet.outcome === 'pending' && (
        <NextEventBar
          eventTime={!isMulti ? bet.event_time : null}
          legs={isMulti ? legs : null}
        />
      )}

      {/* Check result message */}
      {checkMsg && (
        <div
          className={`text-xs px-3 py-2 rounded-lg border ${
            checkMsg.type === 'ok'
              ? 'bg-green-500/10 border-green-500/30 text-green-400'
              : checkMsg.type === 'warn'
              ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400'
              : 'bg-slate-700/50 border-slate-600 text-slate-400'
          }`}
        >
          {checkMsg.text}
        </div>
      )}

      {/* Admin outcome override UI */}
      {overridingOutcome && (
        <div className="bg-slate-900/80 rounded-lg px-3 py-3 space-y-3 border border-yellow-500/20">
          <p className="text-xs text-yellow-400 font-semibold">Override outcome</p>
          <div className="flex flex-wrap gap-2">
            {OVERRIDE_OUTCOMES.map((o) => (
              <button
                key={o}
                onClick={() => setOverrideResult(o)}
                className={`text-xs px-2.5 py-1 rounded border capitalize transition-colors ${
                  overrideResult === o
                    ? o === 'won'
                      ? 'bg-green-500/20 text-green-400 border-green-500/30 font-bold'
                      : o === 'lost'
                      ? 'bg-red-500/20 text-red-400 border-red-500/30 font-bold'
                      : o === 'void'
                      ? 'bg-slate-500/20 text-slate-300 border-slate-500/30 font-bold'
                      : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30 font-bold'
                    : 'border-slate-600 text-slate-400 hover:text-white'
                }`}
              >
                {o}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSaveOverride}
              disabled={savingOverride}
              className="text-xs bg-green-500 hover:bg-green-400 text-white font-semibold rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              {savingOverride ? 'Saving...' : 'Confirm'}
            </button>
            <button
              onClick={() => setOverridingOutcome(false)}
              className="text-xs border border-slate-600 text-slate-400 hover:text-white rounded-lg px-3 py-1.5 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Expanded detail panel */}
      {expanded && (
        <div className="space-y-2 pt-1">
          {isMulti && legs.length > 0 ? (
            /* Multi — group SGM sub-legs, show standalone legs normally */
            renderGroupedLegs(legs)
          ) : (
            /* Single — show full bet details */
            <div className="bg-slate-900/80 rounded-md px-4 py-3 space-y-2 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <div>
                  <span className="text-slate-500">Sport </span>
                  <span className="text-slate-200">{bet.sport}</span>
                </div>
                <div>
                  <span className="text-slate-500">Date </span>
                  <span className="text-slate-200">
                    {new Date(bet.date + 'T00:00:00').toLocaleDateString('en-AU', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Odds </span>
                  <span className="text-slate-200">{parseFloat(bet.odds).toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-slate-500">Stake </span>
                  <span className="text-slate-200">${parseFloat(bet.stake).toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-slate-500">Potential return </span>
                  <span className="text-slate-200">
                    ${(parseFloat(bet.stake) * parseFloat(bet.odds)).toFixed(2)}
                  </span>
                </div>
              </div>
              {bet.notes && (
                <div>
                  <span className="text-slate-500">Notes </span>
                  <span className="text-slate-300">{bet.notes}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
