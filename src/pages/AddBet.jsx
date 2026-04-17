import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { SPORTS, LEG_SPORTS, evaluateBetReturn } from '../lib/utils'

const newLeg = () => ({ sport: '', event_time: '', event: '', description: '', selection: '', odds: '', leg_group: '', group_odds: '', outcome: 'pending' })

const inp = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:border-green-500 text-sm'
const inpMissing = 'w-full bg-amber-900/30 border border-amber-500/60 rounded-lg px-3 py-2 text-white placeholder-amber-400/60 focus:outline-none focus:border-amber-400 text-sm'
const lbl = 'block text-xs text-slate-400 mb-1 uppercase tracking-wide'

const normalizeSport = (raw) => {
  if (!raw) return ''
  const s = raw.toLowerCase().trim()
  if (s === 'multi' || s.includes('multi')) return 'Multi'
  if (s.includes('afl') || s.includes('aussie rules')) return 'AFL'
  if (s.includes('nrl') || s.includes('rugby league')) return 'NRL'
  if (s.includes('cricket')) return 'Cricket'
  if (s.includes('grey')) return 'Greyhounds'
  if (s.includes('horse') || s.includes('racing')) return 'Horse Racing'
  if (s.includes('tennis')) return 'Tennis'
  if (s.includes('nba') || s.includes('basketball')) return 'NBA'
  if (s.includes('nfl') || s.includes('american football')) return 'NFL'
  if (s.includes('box')) return 'Boxing'
  if (s.includes('mma') || s.includes('ufc')) return 'MMA'
  if (s.includes('rugby union')) return 'Rugby Union'
  if (s.includes('golf')) return 'Golf'
  if (s.includes('soccer') || s.includes('football')) return 'Soccer'
  const match = SPORTS.find((sp) => sp.toLowerCase() === s)
  return match || 'Other'
}

// Correct dates where the AI extracted the wrong year (e.g. 2025 instead of 2026)
const fixYear = (dateStr) => {
  if (!dateStr) return dateStr
  const currentYear = new Date().getFullYear()
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  if (d.getFullYear() < currentYear) {
    d.setFullYear(currentYear)
    return d.toISOString().substring(0, dateStr.length <= 10 ? 10 : 16)
  }
  return dateStr
}

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })

function outcomeBadgeClass(outcome) {
  switch (outcome) {
    case 'won':  return 'bg-green-500/20 text-green-400 border-green-500/30'
    case 'lost': return 'bg-red-500/20 text-red-400 border-red-500/30'
    case 'void': return 'bg-slate-500/20 text-slate-400 border-slate-500/30'
    default:     return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  }
}

export default function AddBet() {
  const { user, profile, persona } = useAuth()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  // 'landing' | 'screenshot' | 'manual'
  const [mode, setMode] = useState('landing')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [personas, setPersonas] = useState([])
  const [selectedPersonaId, setSelectedPersonaId] = useState('')
  const [rolloverPool, setRolloverPool] = useState(null) // { sourceId, sourceName, totalReturn, remaining }

  // Screenshot state
  const [screenshotUrl, setScreenshotUrl] = useState(null)
  const [screenshotPreviews, setScreenshotPreviews] = useState([])
  const [extracting, setExtracting] = useState(false)
  const [extracted, setExtracted] = useState(false) // true once AI has filled the form
  const [extractError, setExtractError] = useState(null)

  const [form, setForm] = useState({
    date: new Date().toISOString().split('T')[0],
    sport: '',
    event: '',
    bet_type: 'single',
    odds: '',
    stake: '',
    outcome: 'pending',
    notes: '',
    event_time: '',
    is_bonus_bet: false,
    is_rollover: false,
    intend_to_rollover: false,
    bet_return_text: '',
    bet_return_value: '',
  })

  const [legs, setLegs] = useState([newLeg(), newLeg()])

  const set = (key, val) => setForm((p) => ({ ...p, [key]: val }))
  const addLeg = () => setLegs((p) => [...p, newLeg()])
  const removeLeg = (i) => setLegs((p) => p.filter((_, idx) => idx !== i))
  const setLeg = (i, key, val) => {
    setLegs((p) => p.map((leg, idx) => (idx === i ? { ...leg, [key]: val } : leg)))
    // Keep bet date in sync with first leg's event_time on multis
    if (i === 0 && key === 'event_time' && form.bet_type === 'multi' && val) {
      set('date', val.substring(0, 10))
    }
  }

  useEffect(() => {
    if (!profile?.is_admin) return
    supabase.from('personas').select('*').order('nickname').then(({ data }) => {
      setPersonas(data || [])
      if (persona) setSelectedPersonaId(persona.id)
    })
  }, [profile, persona])

  // Check for active rollover pool when persona changes
  const activePersonaId = profile?.is_admin ? selectedPersonaId : persona?.id
  useEffect(() => {
    if (!activePersonaId) return setRolloverPool(null)
    checkRolloverPool(activePersonaId)
  }, [activePersonaId])

  async function checkRolloverPool(personaId) {
    // Find won bets flagged as intend_to_rollover for this persona
    const { data: sources } = await supabase
      .from('bets')
      .select('id, event, stake, odds')
      .eq('persona_id', personaId)
      .eq('intend_to_rollover', true)
      .eq('outcome', 'won')
    if (!sources || sources.length === 0) return setRolloverPool(null)

    // Find all rollover bets already drawn from these sources
    const sourceIds = sources.map(s => s.id)
    const { data: rollovers } = await supabase
      .from('bets')
      .select('rollover_source_id, stake')
      .in('rollover_source_id', sourceIds)

    // Find the first source with remaining balance
    for (const src of sources) {
      const totalReturn = parseFloat(src.stake) * parseFloat(src.odds)
      const used = (rollovers || [])
        .filter(r => r.rollover_source_id === src.id)
        .reduce((sum, r) => sum + parseFloat(r.stake), 0)
      const remaining = Math.round((totalReturn - used) * 100) / 100
      if (remaining > 0.01) {
        setRolloverPool({ sourceId: src.id, sourceName: src.event, totalReturn, used, remaining })
        return
      }
    }
    setRolloverPool(null)
  }

  // ── Screenshot extraction ──────────────────────────────────
  const handleScreenshotSelect = async (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    setScreenshotPreviews(files.map((f) => URL.createObjectURL(f)))
    setExtracting(true)
    setExtractError(null)
    setExtracted(false)

    try {
      const file = files[0]
      const ext = file.name.split('.').pop()
      const path = `${user.id}/${Date.now()}.${ext}`
      const { error: uploadErr } = await supabase.storage.from('bet-screenshots').upload(path, file, { upsert: true })
      if (uploadErr) throw new Error('Storage upload failed: ' + uploadErr.message)
      const { data: { publicUrl } } = supabase.storage.from('bet-screenshots').getPublicUrl(path)
      setScreenshotUrl(publicUrl)

      const images = await Promise.all(files.map(async (f) => ({ imageBase64: await fileToBase64(f), mimeType: f.type })))
      const response = await fetch('/api/extract-bet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      })
      const result = await response.json()
      if (!result.success) throw new Error(result.error || 'Extraction failed')
      const d = result.data

      const autoEvent = (() => {
        if (d.bet_type !== 'multi') return d.event || ''
        if (d.event) return d.event
        const legEvents = (d.legs || []).map((l) => (l.event || '').trim()).filter(Boolean)
        if (legEvents.length === 0) return 'Multi'
        const unique = [...new Set(legEvents.map((e) => e.toLowerCase()))]
        return unique.length === 1 ? legEvents[0] : 'Multi'
      })()

      setForm((prev) => ({
        ...prev,
        sport: normalizeSport(d.sport) || prev.sport,
        event: autoEvent || prev.event,
        bet_type: d.bet_type === 'multi' ? 'multi' : d.bet_type === 'single' ? 'single' : prev.bet_type,
        odds: d.odds != null ? String(d.odds) : prev.odds,
        stake: d.stake != null ? String(d.stake) : prev.stake,
        event_time: d.event_time ? fixYear(d.event_time.substring(0, 16)) : prev.event_time,
        is_bonus_bet: d.is_bonus_bet === true ? true : prev.is_bonus_bet,
        bet_return_text: d.bet_return_text || prev.bet_return_text,
        bet_return_value: d.bet_return_value != null ? String(d.bet_return_value) : prev.bet_return_value,
      }))

      if (d.bet_type === 'multi' && Array.isArray(d.legs) && d.legs.length > 0) {
        const mappedLegs = d.legs.map((leg) => ({
          sport: normalizeSport(leg.sport) || '',
          event_time: leg.event_time ? fixYear(leg.event_time.substring(0, 16)) : '',
          event: leg.event || '',
          description: leg.description || '',
          selection: leg.selection || '',
          odds: leg.odds != null ? String(leg.odds) : '',
          leg_group: leg.leg_group != null ? String(leg.leg_group) : '',
          group_odds: leg.group_odds != null ? String(leg.group_odds) : '',
          outcome: leg.outcome && ['won','lost','void'].includes(leg.outcome) ? leg.outcome : 'pending',
        }))
        setLegs(mappedLegs)
        // Default bet date to first leg's event_time date
        const firstLegTime = mappedLegs.find((l) => l.event_time)?.event_time
        if (firstLegTime) {
          setForm((prev) => ({ ...prev, date: firstLegTime.substring(0, 10) }))
        }
      }

      if (d.outcome && ['won','lost','void'].includes(d.outcome)) {
        setForm((prev) => ({ ...prev, outcome: d.outcome }))
      } else if (d.bet_type === 'multi' && Array.isArray(d.legs) && d.legs.length > 0) {
        const legOutcomes = d.legs.map((l) => l.outcome || 'pending')
        if (legOutcomes.every((o) => o !== 'pending')) {
          const derived = legOutcomes.some((o) => o === 'lost') ? 'lost'
            : legOutcomes.every((o) => o === 'void') ? 'void'
            : legOutcomes.some((o) => o === 'won') ? 'won' : 'pending'
          setForm((prev) => ({ ...prev, outcome: derived }))
        }
      }

      setExtracted(true)
    } catch (err) {
      setExtractError(err.message)
    } finally {
      setExtracting(false)
    }
  }

  // ── Save ───────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    if (e) e.preventDefault()
    setError('')

    if (!form.sport) return setError('Please select a sport.')
    const odds = parseFloat(form.odds)
    const stake = parseFloat(form.stake)
    if (isNaN(odds) || odds <= 1) return setError('Odds must be greater than 1.00.')
    if (isNaN(stake) || stake <= 0) return setError('Stake must be greater than $0.')

    if (form.bet_type === 'multi') {
      for (let i = 0; i < legs.length; i++) {
        if (!legs[i].event.trim()) return setError(`Leg ${i + 1}: event name is required.`)
        if (legs[i].leg_group === '') {
          const lo = parseFloat(legs[i].odds)
          if (isNaN(lo) || lo <= 1) return setError(`Leg ${i + 1}: odds required (or mark as part of an SGM group).`)
        }
      }
    }

    setSaving(true)
    try {
      const betPersonaId = profile?.is_admin
        ? (selectedPersonaId || persona?.id || null)
        : (persona?.id || null)

      const { data: bet, error: betErr } = await supabase
        .from('bets')
        .insert({
          user_id: user.id,
          persona_id: betPersonaId,
          date: form.date,
          sport: form.sport,
          event: form.event.trim(),
          bet_type: form.bet_type,
          odds,
          stake,
          outcome: form.outcome,
          notes: form.notes.trim() || null,
          screenshot_url: screenshotUrl || null,
          event_time: form.event_time || null,
          is_bonus_bet: form.is_bonus_bet || false,
          is_rollover: form.is_rollover || false,
          rollover_source_id: form.is_rollover && rolloverPool ? rolloverPool.sourceId : null,
          intend_to_rollover: form.intend_to_rollover || false,
          bet_return_text: form.bet_return_text.trim() || null,
          bet_return_value: form.bet_return_value ? parseFloat(form.bet_return_value) : null,
          bet_return_earned: (() => {
            if (!form.bet_return_text.trim() || !form.bet_return_value || form.outcome === 'pending') return null
            return evaluateBetReturn(form.bet_return_text, form.outcome, form.bet_type === 'multi' ? legs : [])
          })(),
        })
        .select()
        .single()

      if (betErr) throw betErr

      if (form.is_bonus_bet) {
        const targetPersonaId = (profile?.is_admin && selectedPersonaId) ? selectedPersonaId : (persona?.id || null)
        const targetUserId = targetPersonaId
          ? personas.find((p) => p.id === targetPersonaId)?.claimed_by || user.id
          : user.id
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - 21)
        const { data: byPersona } = await supabase.from('bets').select('id')
          .eq('persona_id', targetPersonaId).eq('outcome', 'lost').eq('bet_return_claimed', false)
          .gt('bet_return_value', 0).gte('date', cutoff.toISOString().slice(0, 10))
          .order('date', { ascending: false }).limit(1)
        const { data: byUser } = await supabase.from('bets').select('id')
          .eq('user_id', targetUserId).is('persona_id', null).eq('outcome', 'lost').eq('bet_return_claimed', false)
          .gt('bet_return_value', 0).gte('date', cutoff.toISOString().slice(0, 10))
          .order('date', { ascending: false }).limit(1)
        const claimTarget = byPersona?.[0] || byUser?.[0]
        if (claimTarget) await supabase.from('bets').update({ bet_return_claimed: true }).eq('id', claimTarget.id)
      }

      if (form.bet_type === 'multi') {
        const { error: legsErr } = await supabase.from('bet_legs').insert(
          legs.map((leg, i) => ({
            bet_id: bet.id,
            sport: leg.sport || null,
            event_time: leg.event_time || null,
            event: leg.event.trim(),
            description: leg.description.trim() || null,
            selection: leg.selection.trim() || null,
            odds: leg.leg_group !== '' ? null : parseFloat(leg.odds),
            leg_group: leg.leg_group !== '' ? parseInt(leg.leg_group) : null,
            group_odds: leg.group_odds !== '' ? parseFloat(leg.group_odds) : null,
            outcome: leg.outcome,
            sort_order: i,
          }))
        )
        if (legsErr) throw legsErr

        if (form.outcome === 'pending') {
          const allSettled = legs.every((l) => l.outcome !== 'pending')
          if (allSettled) {
            const derived = legs.some((l) => l.outcome === 'lost') ? 'lost'
              : legs.every((l) => l.outcome === 'void') ? 'void' : 'won'
            await supabase.from('bets').update({ outcome: derived }).eq('id', bet.id)
          }
        }
      }

      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Critical field check ───────────────────────────────────
  const missingOdds  = !form.odds  || isNaN(parseFloat(form.odds))  || parseFloat(form.odds)  <= 1
  const missingStake = !form.stake || isNaN(parseFloat(form.stake)) || parseFloat(form.stake) <= 0
  const missingSport = !form.sport

  // "Intend to rollover" only visible when potential profit ≤ $150 and bet is pending
  const potentialProfit = (!missingOdds && !missingStake)
    ? parseFloat(form.stake) * (parseFloat(form.odds) - 1)
    : null
  const showIntendToRollover = potentialProfit !== null && potentialProfit <= 150 && form.outcome === 'pending'

  // ── LANDING ────────────────────────────────────────────────
  if (mode === 'landing') {
    return (
      <div className="max-w-2xl mx-auto space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Add Bet</h1>
          <p className="text-slate-400 text-sm mt-0.5">How would you like to add this bet?</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <button
            onClick={() => { setMode('screenshot'); setTimeout(() => fileInputRef.current?.click(), 50) }}
            className="group bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-green-500/50 rounded-xl p-8 text-left transition-all space-y-3"
          >
            <div className="text-4xl">📷</div>
            <div>
              <p className="text-white font-semibold text-lg">Upload Screenshot</p>
              <p className="text-slate-400 text-sm mt-1">AI reads your Sportsbet screenshot and fills in everything automatically.</p>
            </div>
            <p className="text-green-400 text-sm font-medium group-hover:text-green-300">Recommended →</p>
          </button>

          <button
            onClick={() => setMode('manual')}
            className="group bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-slate-500 rounded-xl p-8 text-left transition-all space-y-3"
          >
            <div className="text-4xl">✏️</div>
            <div>
              <p className="text-white font-semibold text-lg">Manual Entry</p>
              <p className="text-slate-400 text-sm mt-1">Enter all bet details by hand.</p>
            </div>
            <p className="text-slate-500 text-sm group-hover:text-slate-300">Fill in form →</p>
          </button>
        </div>
      </div>
    )
  }

  // ── MANUAL ─────────────────────────────────────────────────
  if (mode === 'manual') {
    return (
      <div className="max-w-2xl mx-auto space-y-5">
        <div className="flex items-center gap-3">
          <button onClick={() => setMode('landing')} className="text-slate-400 hover:text-white transition-colors text-sm">← Back</button>
          <div>
            <h1 className="text-2xl font-bold text-white">Manual Bet Entry</h1>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Member selector (admin only) */}
          {profile?.is_admin && personas.length > 0 && (
            <div className="bg-slate-800 rounded-xl border border-purple-700/40 p-4">
              <label className={lbl}>Betting for</label>
              <select value={selectedPersonaId} onChange={(e) => setSelectedPersonaId(e.target.value)} className={inp}>
                <option value="">— select member —</option>
                {personas.map((p) => <option key={p.id} value={p.id}>{p.emoji} {p.nickname}{!p.claimed_by ? ' (unclaimed)' : ''}</option>)}
              </select>
            </div>
          )}

          <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-4">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Bet Details</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={lbl}>Date</label>
                <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} required className={inp} />
              </div>
              <div>
                <label className={lbl}>Sport</label>
                <select value={form.sport} onChange={(e) => set('sport', e.target.value)} required className={inp}>
                  <option value="">Select sport</option>
                  {SPORTS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className={lbl}>Event / Match</label>
              <input type="text" value={form.event} onChange={(e) => set('event', e.target.value)} placeholder="e.g. Richmond vs Collingwood — Head to Head" required className={inp} />
            </div>
            {form.bet_type === 'single' && (
              <div>
                <label className={lbl}>Event Date & Time AEST (optional)</label>
                <input type="datetime-local" value={form.event_time} onChange={(e) => set('event_time', e.target.value)} className={inp} />
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={lbl}>Bet Type</label>
                <select value={form.bet_type} onChange={(e) => set('bet_type', e.target.value)} className={inp}>
                  <option value="single">Single</option>
                  <option value="multi">Multi</option>
                </select>
              </div>
              <div>
                <label className={lbl}>Outcome</label>
                <select value={form.outcome} onChange={(e) => set('outcome', e.target.value)} className={inp}>
                  <option value="pending">Pending</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                  <option value="void">Void</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={lbl}>{form.bet_type === 'multi' ? 'Combined Odds' : 'Odds'}</label>
                <input type="number" value={form.odds} onChange={(e) => set('odds', e.target.value)} placeholder="2.50" step="0.01" min="1.01" required className={inp} />
              </div>
              <div>
                <label className={lbl}>Stake ($)</label>
                <input type="number" value={form.stake} onChange={(e) => set('stake', e.target.value)} placeholder="10.00" step="0.01" min="0.01" required className={inp} />
              </div>
            </div>
            {form.odds && form.stake && parseFloat(form.odds) > 1 && parseFloat(form.stake) > 0 && (
              <div className="text-sm text-slate-400 bg-slate-900/60 rounded-lg px-3 py-2">
                Potential return: <span className="text-green-400 font-medium">${(parseFloat(form.stake) * parseFloat(form.odds)).toFixed(2)}</span>
              </div>
            )}
            <div>
              <label className={lbl}>Notes (optional)</label>
              <input type="text" value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Any extra notes" className={inp} />
            </div>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div onClick={() => set('is_bonus_bet', !form.is_bonus_bet)} className={`w-10 h-6 rounded-full transition-colors relative ${form.is_bonus_bet ? 'bg-amber-500' : 'bg-slate-600'}`}>
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${form.is_bonus_bet ? 'translate-x-5' : 'translate-x-1'}`} />
              </div>
              <span className="text-sm text-slate-300">Bonus bet <span className="text-slate-500 text-xs">(free bet)</span></span>
            </label>
            <div className="space-y-2">
              <label className={lbl}>Bet Return (optional)</label>
              <div className="flex gap-2">
                <input type="text" value={form.bet_return_text} onChange={(e) => set('bet_return_text', e.target.value)} placeholder="e.g. Any leg fails → $50 bonus bet" className={`${inp} flex-1`} />
                <input type="number" value={form.bet_return_value} onChange={(e) => set('bet_return_value', e.target.value)} placeholder="$value" step="0.01" min="0" className={`${inp} w-24`} />
              </div>
            </div>
          </div>

          {form.bet_type === 'multi' && (
            <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Legs ({legs.length})</p>
                <button type="button" onClick={addLeg} className="text-xs text-green-400 hover:text-green-300 transition-colors">+ Add leg</button>
              </div>
              {legs.map((leg, i) => (
                <div key={i} className="bg-slate-900/70 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-300">Leg {i + 1}</span>
                    {legs.length > 2 && <button type="button" onClick={() => removeLeg(i)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={lbl}>Sport</label>
                      <select value={leg.sport} onChange={(e) => setLeg(i, 'sport', e.target.value)} className={inp}>
                        <option value="">Select sport</option>
                        {LEG_SPORTS.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={lbl}>Date & Time AEST</label>
                      <input type="datetime-local" value={leg.event_time} onChange={(e) => setLeg(i, 'event_time', e.target.value)} className={inp} />
                    </div>
                    <div className="col-span-2">
                      <label className={lbl}>Event / Match</label>
                      <input type="text" value={leg.event} onChange={(e) => setLeg(i, 'event', e.target.value)} placeholder="e.g. Chelsea vs Arsenal" required className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Market Type</label>
                      <input type="text" value={leg.description} onChange={(e) => setLeg(i, 'description', e.target.value)} placeholder="e.g. Win-Draw-Win" className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Selection</label>
                      <input type="text" value={leg.selection} onChange={(e) => setLeg(i, 'selection', e.target.value)} placeholder="e.g. Chelsea" className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>SGM Group #</label>
                      <input type="number" value={leg.leg_group} onChange={(e) => setLeg(i, 'leg_group', e.target.value)} placeholder="1, 2, 3…" min="1" className={inp} />
                    </div>
                    {leg.leg_group !== '' ? (
                      <div>
                        <label className={lbl}>SGM Combined Odds</label>
                        <input type="number" value={leg.group_odds} onChange={(e) => setLeg(i, 'group_odds', e.target.value)} placeholder="e.g. 3.20" step="0.01" min="1.01" className={inp} />
                      </div>
                    ) : (
                      <div>
                        <label className={lbl}>Odds</label>
                        <input type="number" value={leg.odds} onChange={(e) => setLeg(i, 'odds', e.target.value)} placeholder="1.80" step="0.01" min="1.01" className={inp} />
                      </div>
                    )}
                    <div>
                      <label className={lbl}>Outcome</label>
                      <select value={leg.outcome} onChange={(e) => setLeg(i, 'outcome', e.target.value)} className={inp}>
                        <option value="pending">Pending</option>
                        <option value="won">Won</option>
                        <option value="lost">Lost</option>
                        <option value="void">Void</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Rollover pool banner — shown when this persona has winnings to re-invest */}
          {rolloverPool && (
            <div className="bg-blue-900/20 border border-blue-600/40 rounded-xl px-4 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-blue-400 font-semibold text-sm">💰 Rollover available</span>
                <span className="text-blue-300 font-bold text-sm">${rolloverPool.remaining.toFixed(2)} remaining</span>
                <span className="text-slate-500 text-xs">from "{rolloverPool.sourceName}"</span>
              </div>
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <div onClick={() => set('is_rollover', !form.is_rollover)} className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${form.is_rollover ? 'bg-blue-500' : 'bg-slate-600'}`}>
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${form.is_rollover ? 'translate-x-5' : 'translate-x-1'}`} />
                </div>
                <span className="text-sm text-slate-300">Use rollover stake <span className="text-slate-500 text-xs">(stake excluded from your capital stats)</span></span>
              </label>
            </div>
          )}

          {/* Intend to rollover — only shown when potential profit ≤ $150 and outcome pending */}
          {showIntendToRollover && (
            <label className="flex items-center gap-3 cursor-pointer select-none bg-slate-800 rounded-xl border border-slate-700 px-5 py-4">
              <div onClick={() => set('intend_to_rollover', !form.intend_to_rollover)} className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${form.intend_to_rollover ? 'bg-green-500' : 'bg-slate-600'}`}>
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${form.intend_to_rollover ? 'translate-x-5' : 'translate-x-1'}`} />
              </div>
              <span className="text-sm text-slate-300">Intend to rollover winnings <span className="text-slate-500 text-xs">(if this wins, ${potentialProfit?.toFixed(2)} profit will be tracked for re-betting)</span></span>
            </label>
          )}

          {error && <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">{error}</div>}
          <div className="flex gap-3 pb-4">
            <button type="button" onClick={() => setMode('landing')} className="flex-1 py-2.5 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 text-sm transition-colors">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white font-semibold text-sm transition-colors">{saving ? 'Saving...' : 'Save Bet'}</button>
          </div>
        </form>
      </div>
    )
  }

  // ── SCREENSHOT MODE ────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => setMode('landing')} className="text-slate-400 hover:text-white transition-colors text-sm">← Back</button>
        <h1 className="text-2xl font-bold text-white">Add Bet</h1>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        onChange={handleScreenshotSelect}
        className="hidden"
      />

      {/* ── Before extraction: just the upload area ── */}
      {!extracting && !extracted && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-16 rounded-xl border-2 border-dashed border-slate-600 hover:border-green-500 text-slate-400 hover:text-green-400 transition-colors space-y-3 flex flex-col items-center justify-center"
          >
            <span className="text-5xl">📷</span>
            <span className="text-base font-medium">Tap to upload Sportsbet screenshot(s)</span>
            <span className="text-xs text-slate-500">PNG, JPG, WEBP — multiple files supported</span>
          </button>
          {extractError && (
            <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">
              Could not read screenshot: {extractError}
              <button onClick={() => fileInputRef.current?.click()} className="ml-2 underline text-red-300 hover:text-red-200">Try again</button>
            </div>
          )}
        </div>
      )}

      {/* ── Extracting spinner ── */}
      {extracting && (
        <div className="flex flex-col items-center justify-center py-20 space-y-4">
          <svg className="animate-spin h-10 w-10 text-green-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          <p className="text-slate-400 text-sm">Reading {screenshotPreviews.length > 1 ? `${screenshotPreviews.length} screenshots` : 'screenshot'}…</p>
        </div>
      )}

      {/* ── Extracted: bet slip preview ── */}
      {extracted && !extracting && (
        <div className="space-y-4">
          {/* Re-upload option */}
          <div className="flex items-center justify-between">
            <p className="text-slate-400 text-xs">Review your bet — edit any field before saving.</p>
            <button type="button" onClick={() => fileInputRef.current?.click()} className="text-xs text-slate-400 hover:text-blue-400 transition-colors">↑ Re-upload</button>
          </div>

          {/* Missing fields warning */}
          {(missingOdds || missingStake || missingSport) && (
            <div className="flex items-center gap-2 bg-amber-900/20 border border-amber-500/30 rounded-lg px-4 py-3">
              <span className="text-amber-400 text-sm">⚠</span>
              <span className="text-amber-400 text-sm">
                Missing required info — please fill in:
                {[missingSport && 'Sport', missingOdds && 'Odds', missingStake && 'Stake'].filter(Boolean).join(', ')}
              </span>
            </div>
          )}

          {/* Member selector (admin only) */}
          {profile?.is_admin && personas.length > 0 && (
            <div className="bg-slate-800 rounded-xl border border-purple-700/40 p-4">
              <label className={lbl}>Betting for</label>
              <select value={selectedPersonaId} onChange={(e) => setSelectedPersonaId(e.target.value)} className={inp}>
                <option value="">— select member —</option>
                {personas.map((p) => <option key={p.id} value={p.id}>{p.emoji} {p.nickname}{!p.claimed_by ? ' (unclaimed)' : ''}</option>)}
              </select>
            </div>
          )}

          {/* The slip card */}
          <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
            {/* Slip header */}
            <div className="bg-slate-900/60 px-5 py-4 flex items-center justify-between gap-3 flex-wrap border-b border-slate-700">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Sport — dropdown if missing */}
                {missingSport ? (
                  <select value={form.sport} onChange={(e) => set('sport', e.target.value)} className="text-xs bg-amber-900/30 border border-amber-500/60 rounded px-2 py-1 text-amber-300 focus:outline-none focus:border-amber-400">
                    <option value="">⚠ Select sport</option>
                    {SPORTS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300">{form.sport}</span>
                )}
                <span className={`text-xs px-2 py-0.5 rounded border ${form.bet_type === 'multi' ? 'bg-purple-500/20 text-purple-400 border-purple-500/30' : 'bg-blue-500/20 text-blue-400 border-blue-500/30'}`}>
                  {form.bet_type}
                </span>
                {form.is_bonus_bet && (
                  <span className="text-xs px-2 py-0.5 rounded border bg-amber-500/20 text-amber-400 border-amber-500/30 font-semibold">BONUS</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Date */}
                <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} className="text-xs bg-transparent border-0 text-slate-400 focus:outline-none" />
                {/* Outcome */}
                <select value={form.outcome} onChange={(e) => set('outcome', e.target.value)} className={`text-xs px-2 py-0.5 rounded border focus:outline-none ${outcomeBadgeClass(form.outcome)}`} style={{ background: 'transparent' }}>
                  <option value="pending">pending</option>
                  <option value="won">won</option>
                  <option value="lost">lost</option>
                  <option value="void">void</option>
                </select>
              </div>
            </div>

            {/* Event name */}
            <div className="px-5 py-4 border-b border-slate-700/60">
              <input
                type="text"
                value={form.event}
                onChange={(e) => set('event', e.target.value)}
                placeholder="Event / Match name"
                className="w-full bg-transparent text-white font-semibold text-base focus:outline-none placeholder-slate-600"
              />
              {form.bet_type === 'single' && (
                <input type="datetime-local" value={form.event_time} onChange={(e) => set('event_time', e.target.value)} className="mt-1 text-xs bg-transparent border-0 text-slate-500 focus:outline-none w-full" />
              )}
            </div>

            {/* Multi legs */}
            {form.bet_type === 'multi' && legs.length > 0 && (
              <div className="divide-y divide-slate-700/40 border-b border-slate-700/60">
                {legs.map((leg, i) => (
                  <div key={i} className="px-5 py-3 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {leg.sport && <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">{leg.sport}</span>}
                          <input
                            type="text"
                            value={leg.event}
                            onChange={(e) => setLeg(i, 'event', e.target.value)}
                            placeholder="Event"
                            className="text-sm text-white bg-transparent focus:outline-none min-w-0 flex-1"
                          />
                        </div>
                        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                          {leg.description && <span className="text-slate-500 text-xs">{leg.description}</span>}
                          <input
                            type="text"
                            value={leg.selection}
                            onChange={(e) => setLeg(i, 'selection', e.target.value)}
                            placeholder="Selection"
                            className="text-xs text-green-400 bg-transparent focus:outline-none"
                          />
                        </div>
                        {leg.event_time && <p className="text-slate-600 text-xs mt-0.5">{leg.event_time.replace('T', ' ')}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {leg.leg_group === '' && (
                          <span className="text-slate-300 text-sm">{leg.odds ? parseFloat(leg.odds).toFixed(2) : '—'}</span>
                        )}
                        <select
                          value={leg.outcome || 'pending'}
                          onChange={(e) => setLeg(i, 'outcome', e.target.value)}
                          className={`text-xs px-1.5 py-0.5 rounded border focus:outline-none ${outcomeBadgeClass(leg.outcome)}`}
                          style={{ background: 'transparent' }}
                        >
                          <option value="pending">pending</option>
                          <option value="won">won</option>
                          <option value="lost">lost</option>
                          <option value="void">void</option>
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Odds / Stake / Return row */}
            <div className="px-5 py-4 grid grid-cols-3 gap-4 border-b border-slate-700/60">
              <div>
                <p className="text-slate-500 text-xs mb-1">Odds</p>
                <input
                  type="number"
                  value={form.odds}
                  onChange={(e) => set('odds', e.target.value)}
                  placeholder="—"
                  step="0.01"
                  min="1.01"
                  className={`text-base font-bold w-full bg-transparent focus:outline-none ${missingOdds ? 'text-amber-400 border-b border-amber-500/60' : 'text-white border-b border-transparent'}`}
                />
                {missingOdds && <p className="text-amber-500 text-xs mt-0.5">Required</p>}
              </div>
              <div>
                <p className="text-slate-500 text-xs mb-1">Stake</p>
                <div className="flex items-baseline gap-0.5">
                  <span className={`text-base font-bold ${missingStake ? 'text-amber-400' : 'text-white'}`}>$</span>
                  <input
                    type="number"
                    value={form.stake}
                    onChange={(e) => set('stake', e.target.value)}
                    placeholder="—"
                    step="0.01"
                    min="0.01"
                    className={`text-base font-bold w-full bg-transparent focus:outline-none ${missingStake ? 'text-amber-400 border-b border-amber-500/60' : 'text-white border-b border-transparent'}`}
                  />
                </div>
                {missingStake && <p className="text-amber-500 text-xs mt-0.5">Required</p>}
              </div>
              <div>
                <p className="text-slate-500 text-xs mb-1">Potential return</p>
                <p className="text-base font-bold text-green-400">
                  {!missingOdds && !missingStake
                    ? `$${(parseFloat(form.stake) * parseFloat(form.odds)).toFixed(2)}`
                    : <span className="text-slate-600">—</span>
                  }
                </p>
              </div>
            </div>

            {/* Bet return / bonus */}
            {(form.bet_return_text || form.bet_return_value) && (
              <div className="px-5 py-3 flex items-center gap-2 border-b border-slate-700/60">
                <span className="text-emerald-400 text-xs">🎁 Bet Return:</span>
                <input type="text" value={form.bet_return_text} onChange={(e) => set('bet_return_text', e.target.value)} className="text-xs text-slate-400 bg-transparent focus:outline-none flex-1" placeholder="description" />
                <div className="flex items-baseline gap-0.5">
                  <span className="text-emerald-400 text-xs">$</span>
                  <input type="number" value={form.bet_return_value} onChange={(e) => set('bet_return_value', e.target.value)} className="text-xs text-emerald-400 font-semibold bg-transparent focus:outline-none w-16" placeholder="0" step="0.01" min="0" />
                </div>
              </div>
            )}

            {/* Notes */}
            <div className="px-5 py-3">
              <input type="text" value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Notes (optional)" className="w-full text-sm text-slate-400 bg-transparent focus:outline-none placeholder-slate-600" />
            </div>
          </div>

          {/* Rollover pool banner — shown when this persona has winnings to re-invest */}
          {rolloverPool && (
            <div className="bg-blue-900/20 border border-blue-600/40 rounded-xl px-4 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-blue-400 font-semibold text-sm">💰 Rollover available</span>
                <span className="text-blue-300 font-bold text-sm">${rolloverPool.remaining.toFixed(2)} remaining</span>
                <span className="text-slate-500 text-xs">from "{rolloverPool.sourceName}"</span>
              </div>
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <div onClick={() => set('is_rollover', !form.is_rollover)} className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${form.is_rollover ? 'bg-blue-500' : 'bg-slate-600'}`}>
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${form.is_rollover ? 'translate-x-5' : 'translate-x-1'}`} />
                </div>
                <span className="text-sm text-slate-300">Use rollover stake <span className="text-slate-500 text-xs">(stake excluded from your capital stats)</span></span>
              </label>
            </div>
          )}

          {/* Bonus bet toggle */}
          <label className="flex items-center gap-3 cursor-pointer select-none bg-slate-800 rounded-xl border border-slate-700 px-5 py-4">
            <div onClick={() => set('is_bonus_bet', !form.is_bonus_bet)} className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${form.is_bonus_bet ? 'bg-amber-500' : 'bg-slate-600'}`}>
              <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${form.is_bonus_bet ? 'translate-x-5' : 'translate-x-1'}`} />
            </div>
            <span className="text-sm text-slate-300">Bonus bet <span className="text-slate-500 text-xs">(free bet — stake not returned if won)</span></span>
          </label>

          {/* Intend to rollover — only shown when potential profit ≤ $150 and outcome pending */}
          {showIntendToRollover && (
            <label className="flex items-center gap-3 cursor-pointer select-none bg-slate-800 rounded-xl border border-slate-700 px-5 py-4">
              <div onClick={() => set('intend_to_rollover', !form.intend_to_rollover)} className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${form.intend_to_rollover ? 'bg-green-500' : 'bg-slate-600'}`}>
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${form.intend_to_rollover ? 'translate-x-5' : 'translate-x-1'}`} />
              </div>
              <span className="text-sm text-slate-300">Intend to rollover winnings <span className="text-slate-500 text-xs">(if this wins, ${potentialProfit?.toFixed(2)} profit will be tracked for re-betting)</span></span>
            </label>
          )}

          {error && <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">{error}</div>}

          <div className="flex gap-3 pb-4">
            <button type="button" onClick={() => setMode('landing')} className="flex-1 py-3 rounded-xl border border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 text-sm transition-colors">Cancel</button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving || missingOdds || missingStake || missingSport}
              className="flex-1 py-3 rounded-xl bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white font-semibold text-sm transition-colors"
            >
              {saving ? 'Saving…' : 'Save Bet'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
