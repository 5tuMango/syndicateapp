import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatCurrency, profitLossColor } from '../lib/utils'
import { usePersonas } from '../hooks/usePersonas'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

function combinedOdds(legs) {
  const entered = legs.filter(l => l.odds != null && parseFloat(l.odds) > 0)
  if (entered.length === 0) return null
  return entered.reduce((acc, l) => acc * parseFloat(l.odds), 1)
}

function deriveOutcome(legs) {
  const nonVoid = legs.filter(l => l.outcome !== 'void')
  if (nonVoid.length === 0) return 'pending'
  if (nonVoid.some(l => l.outcome === 'pending')) return 'pending'
  if (nonVoid.some(l => l.outcome === 'lost')) return 'lost'
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

export default function WeeklyMultiCard({ multi, onUpdate }) {
  const { profile } = useAuth()
  const { byUserId, byPersonaId } = usePersonas()
  const isAdmin = profile?.is_admin

  const [expanded, setExpanded] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [msg, setMsg] = useState(null)
  const [savingLeg, setSavingLeg] = useState({})

  const legs = [...(multi.weekly_multi_legs || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  const odds = combinedOdds(legs)
  const outcome = deriveOutcome(legs)
  const stake = parseFloat(multi.stake || 0)
  const winnings = outcome === 'won' && odds != null ? stake * odds : 0
  const pl = outcome === 'won' ? winnings - stake : outcome === 'lost' ? -stake : 0
  const handleCheck = async () => {
    setChecking(true)
    setMsg(null)
    try {
      const res = await fetch('/api/check-weekly-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multiId: multi.id }),
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
      const images = await Promise.all(
        files.map(f => new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve({ imageBase64: reader.result.split(',')[1], mimeType: f.type })
          reader.onerror = reject
          reader.readAsDataURL(f)
        }))
      )
      const res = await fetch('/api/extract-weekly-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, multiId: multi.id }),
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
          {outcome === 'won' && winnings > 0 && (
            <span className="text-green-400 font-bold text-lg leading-none">
              +${winnings.toFixed(2)}
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded border ${outcomeBadgeClass(outcome)}`}>
            {outcome}
          </span>
        </div>
      </div>

      {/* Stats + actions row */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-700/60">
        <div className="flex gap-4 text-sm flex-wrap">
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

        <div className="flex items-center gap-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            {expanded ? `Hide legs ▴` : `${legs.length} legs ▾`}
          </button>

          <button
            onClick={handleCheck}
            disabled={checking || uploading}
            className="text-xs text-yellow-400 hover:text-yellow-300 disabled:opacity-50 transition-colors"
          >
            {checking ? 'Checking…' : '🔍 Check'}
          </button>

          {/* Upload results — always visible */}
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

          <Link
            to="/weekly-multi"
            className="text-xs text-slate-400 hover:text-purple-400 transition-colors"
          >
            Manage →
          </Link>
        </div>
      </div>

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
          {legs.map((leg) => {
            const persona = (leg.persona_id && byPersonaId[leg.persona_id])
              || (leg.assigned_user_id && byUserId[leg.assigned_user_id])
            const label = persona ? persona.emoji : (leg.assigned_name || '?')
            return (
              <div key={leg.id} className="bg-slate-900/80 rounded-md px-3 py-2 flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <span className="text-base mr-2">{label}</span>
                  {leg.selection || leg.event ? (
                    <>
                      <span className="text-sm text-white">{leg.event}</span>
                      {leg.description && <span className="text-slate-400 text-sm"> — {leg.description}</span>}
                      {leg.selection && <span className="text-green-400 text-sm font-medium"> · {leg.selection}</span>}
                    </>
                  ) : leg.raw_pick ? (
                    <span className="text-slate-300 text-sm italic">{leg.raw_pick}</span>
                  ) : (
                    <span className="text-slate-600 text-xs italic">No pick</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {leg.odds != null && (
                    <span className="text-slate-400 text-sm">{parseFloat(leg.odds).toFixed(2)}</span>
                  )}
                  {/* Admin: dropdown to set outcome; others: badge only */}
                  {isAdmin ? (
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
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
