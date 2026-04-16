import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { SPORTS, LEG_SPORTS } from '../lib/utils'

const newLeg = () => ({ sport: '', event_time: '', event: '', description: '', selection: '', odds: '', leg_group: '', group_odds: '', outcome: 'pending' })

const inp =
  'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:border-green-500 text-sm'
const lbl = 'block text-xs text-slate-400 mb-1 uppercase tracking-wide'

// Map whatever Claude returns to one of our known sport values
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

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })

export default function AddBet() {
  const { user, profile, persona } = useAuth()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [personas, setPersonas] = useState([])
  const [selectedPersonaId, setSelectedPersonaId] = useState('')

  // Screenshot state
  const [screenshotUrl, setScreenshotUrl] = useState(null)
  const [screenshotPreviews, setScreenshotPreviews] = useState([]) // array of object URLs
  const [extracting, setExtracting] = useState(false)
  const [extractMsg, setExtractMsg] = useState(null) // { type: 'success'|'error', text }

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
    bet_return_text: '',
    bet_return_value: '',
  })

  const [legs, setLegs] = useState([newLeg(), newLeg()])

  const set = (key, val) => setForm((p) => ({ ...p, [key]: val }))
  const addLeg = () => setLegs((p) => [...p, newLeg()])

  // Load personas for admin member selector
  useEffect(() => {
    if (!profile?.is_admin) return
    supabase.from('personas').select('*').order('nickname').then(({ data }) => {
      setPersonas(data || [])
      // Default to own persona
      if (persona) setSelectedPersonaId(persona.id)
    })
  }, [profile, persona])
  const removeLeg = (i) => setLegs((p) => p.filter((_, idx) => idx !== i))
  const setLeg = (i, key, val) =>
    setLegs((p) => p.map((leg, idx) => (idx === i ? { ...leg, [key]: val } : leg)))

  // ── Screenshot handler ────────────────────────────────────
  const handleScreenshotSelect = async (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    // Show local previews immediately
    setScreenshotPreviews(files.map((f) => URL.createObjectURL(f)))
    setExtracting(true)
    setExtractMsg(null)

    try {
      // 1. Upload first file to Supabase Storage (for record keeping)
      const file = files[0]
      const ext = file.name.split('.').pop()
      const path = `${user.id}/${Date.now()}.${ext}`
      const { error: uploadErr } = await supabase.storage
        .from('bet-screenshots')
        .upload(path, file, { upsert: true })

      if (uploadErr) throw new Error('Storage upload failed: ' + uploadErr.message)

      const { data: { publicUrl } } = supabase.storage
        .from('bet-screenshots')
        .getPublicUrl(path)

      setScreenshotUrl(publicUrl)

      // 2. Convert all files to base64 in parallel and call the API
      const images = await Promise.all(
        files.map(async (f) => ({ imageBase64: await fileToBase64(f), mimeType: f.type }))
      )
      const response = await fetch('/api/extract-bet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      })

      const result = await response.json()
      if (!result.success) throw new Error(result.error || 'Extraction failed')

      const d = result.data

      // Work out the best value for the Event / Match field:
      // - Single bet        → use the event Claude extracted
      // - Same-game multi   → Claude returns one overall event name → use it
      // - Multi-game multi  → legs have different events → fall back to "Multi"
      const autoEvent = (() => {
        if (d.bet_type !== 'multi') return d.event || ''
        // If Claude gave us a top-level event name, trust it (SGM)
        if (d.event) return d.event
        // Otherwise inspect the legs
        const legEvents = (d.legs || []).map((l) => (l.event || '').trim()).filter(Boolean)
        if (legEvents.length === 0) return 'Multi'
        const unique = [...new Set(legEvents.map((e) => e.toLowerCase()))]
        // All legs share the same event → SGM
        if (unique.length === 1) return legEvents[0]
        // Different events → multi-game multi
        return 'Multi'
      })()

      // 3. Pre-fill the form with whatever Claude extracted
      setForm((prev) => ({
        ...prev,
        sport: normalizeSport(d.sport) || prev.sport,
        event: autoEvent || prev.event,
        bet_type: d.bet_type === 'multi' ? 'multi' : d.bet_type === 'single' ? 'single' : prev.bet_type,
        odds: d.odds != null ? String(d.odds) : prev.odds,
        stake: d.stake != null ? String(d.stake) : prev.stake,
        event_time: d.event_time ? d.event_time.substring(0, 16) : prev.event_time,
      }))

      // 4. Pre-fill legs for multi bets
      if (d.bet_type === 'multi' && Array.isArray(d.legs) && d.legs.length > 0) {
        setLegs(
          d.legs.map((leg) => ({
            sport: normalizeSport(leg.sport) || '',
            event_time: leg.event_time ? leg.event_time.substring(0, 16) : '',
            event: leg.event || '',
            description: leg.description || '',
            selection: leg.selection || '',
            odds: leg.odds != null ? String(leg.odds) : '',
            leg_group: leg.leg_group != null ? String(leg.leg_group) : '',
            group_odds: leg.group_odds != null ? String(leg.group_odds) : '',
            outcome: 'pending',
          }))
        )
      }

      setExtractMsg({
        type: 'success',
        text: `✓ Form pre-filled from ${files.length > 1 ? `${files.length} screenshots` : 'screenshot'} — review everything before saving.`,
      })
    } catch (err) {
      setExtractMsg({ type: 'error', text: `Could not read screenshot: ${err.message}` })
    } finally {
      setExtracting(false)
    }
  }

  // ── Save bet ──────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!form.sport) return setError('Please select a sport.')
    const odds = parseFloat(form.odds)
    const stake = parseFloat(form.stake)
    if (isNaN(odds) || odds <= 1) return setError('Odds must be greater than 1.00.')
    if (isNaN(stake) || stake <= 0) return setError('Stake must be greater than $0.')

    if (form.bet_type === 'multi') {
      for (let i = 0; i < legs.length; i++) {
        if (!legs[i].event.trim()) return setError(`Leg ${i + 1}: event name is required.`)
        const inSgm = legs[i].leg_group !== ''
        if (!inSgm) {
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
          bet_return_text: form.bet_return_text.trim() || null,
          bet_return_value: form.bet_return_value ? parseFloat(form.bet_return_value) : null,
        })
        .select()
        .single()

      if (betErr) throw betErr

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
      }

      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Add Bet</h1>
        <p className="text-slate-400 text-sm mt-0.5">Upload a screenshot or fill in manually</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">

        {/* ── Screenshot Upload ── */}
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-4">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Screenshot (optional)
          </p>
          <p className="text-xs text-slate-500">
            Upload a Sportsbet screenshot and AI will pre-fill the form for you.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={handleScreenshotSelect}
            className="hidden"
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={extracting}
            className="w-full py-3 rounded-lg border-2 border-dashed border-slate-600 hover:border-green-500 text-slate-400 hover:text-green-400 text-sm transition-colors disabled:opacity-50"
          >
            {extracting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Reading {screenshotPreviews.length > 1 ? `${screenshotPreviews.length} screenshots` : 'screenshot'}...
              </span>
            ) : screenshotPreviews.length > 0 ? (
              '↑ Upload different screenshot(s)'
            ) : (
              '↑ Upload Sportsbet screenshot(s)'
            )}
          </button>

          {/* Image previews — thumbnail grid */}
          {screenshotPreviews.length > 0 && (
            <div className={`grid gap-2 ${screenshotPreviews.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
              {screenshotPreviews.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt={`Screenshot ${i + 1}`}
                  className="w-full max-h-64 object-contain rounded-lg border border-slate-600"
                />
              ))}
            </div>
          )}

          {/* Extract result message */}
          {extractMsg && (
            <div
              className={`text-sm rounded-lg px-4 py-3 border ${
                extractMsg.type === 'success'
                  ? 'text-green-400 bg-green-400/10 border-green-400/20'
                  : 'text-red-400 bg-red-400/10 border-red-400/20'
              }`}
            >
              {extractMsg.text}
            </div>
          )}
        </div>

        {/* ── Member selector (admin only) ── */}
        {profile?.is_admin && personas.length > 0 && (
          <div className="bg-slate-800 rounded-xl border border-purple-700/40 p-4">
            <label className={lbl}>Betting for</label>
            <select
              value={selectedPersonaId}
              onChange={(e) => setSelectedPersonaId(e.target.value)}
              className={inp}
            >
              <option value="">— select member —</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.emoji} {p.nickname}{!p.claimed_by ? ' (unclaimed)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* ── Bet Details ── */}
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-4">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Bet Details
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Date</label>
              <input
                type="date"
                value={form.date}
                onChange={(e) => set('date', e.target.value)}
                required
                className={inp}
              />
            </div>
            <div>
              <label className={lbl}>Sport</label>
              <select
                value={form.sport}
                onChange={(e) => set('sport', e.target.value)}
                required
                className={inp}
              >
                <option value="">Select sport</option>
                {SPORTS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={lbl}>Event / Match</label>
            <input
              type="text"
              value={form.event}
              onChange={(e) => set('event', e.target.value)}
              placeholder="e.g. Richmond vs Collingwood — Head to Head"
              required
              className={inp}
            />
          </div>

          {form.bet_type === 'single' && (
            <div>
              <label className={lbl}>Event Date & Time AEST (optional)</label>
              <input
                type="datetime-local"
                value={form.event_time}
                onChange={(e) => set('event_time', e.target.value)}
                className={inp}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Bet Type</label>
              <select
                value={form.bet_type}
                onChange={(e) => set('bet_type', e.target.value)}
                className={inp}
              >
                <option value="single">Single</option>
                <option value="multi">Multi</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Outcome</label>
              <select
                value={form.outcome}
                onChange={(e) => set('outcome', e.target.value)}
                className={inp}
              >
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
              <input
                type="number"
                value={form.odds}
                onChange={(e) => set('odds', e.target.value)}
                placeholder="2.50"
                step="0.01"
                min="1.01"
                required
                className={inp}
              />
            </div>
            <div>
              <label className={lbl}>Stake ($)</label>
              <input
                type="number"
                value={form.stake}
                onChange={(e) => set('stake', e.target.value)}
                placeholder="10.00"
                step="0.01"
                min="0.01"
                required
                className={inp}
              />
            </div>
          </div>

          {form.odds && form.stake && parseFloat(form.odds) > 1 && parseFloat(form.stake) > 0 && (
            <div className="text-sm text-slate-400 bg-slate-900/60 rounded-lg px-3 py-2">
              {form.is_bonus_bet ? (
                <>
                  Potential profit:{' '}
                  <span className="text-amber-400 font-medium">
                    ${(parseFloat(form.stake) * (parseFloat(form.odds) - 1)).toFixed(2)}
                  </span>{' '}
                  <span className="text-xs text-slate-500">(bonus bet — stake not returned)</span>
                </>
              ) : (
                <>
                  Potential return:{' '}
                  <span className="text-green-400 font-medium">
                    ${(parseFloat(form.stake) * parseFloat(form.odds)).toFixed(2)}
                  </span>{' '}
                  (profit: ${(parseFloat(form.stake) * (parseFloat(form.odds) - 1)).toFixed(2)})
                </>
              )}
            </div>
          )}

          <div>
            <label className={lbl}>Notes (optional)</label>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Any extra notes"
              className={inp}
            />
          </div>

          {/* Bonus bet toggle */}
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <div
              onClick={() => set('is_bonus_bet', !form.is_bonus_bet)}
              className={`w-10 h-6 rounded-full transition-colors relative ${form.is_bonus_bet ? 'bg-amber-500' : 'bg-slate-600'}`}
            >
              <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${form.is_bonus_bet ? 'translate-x-5' : 'translate-x-1'}`} />
            </div>
            <span className="text-sm text-slate-300">
              Bonus bet <span className="text-slate-500 text-xs">(free bet — no loss if it loses)</span>
            </span>
          </label>

          {/* Bet return section */}
          <div className="space-y-2">
            <label className={lbl}>Bet Return (optional)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={form.bet_return_text}
                onChange={(e) => set('bet_return_text', e.target.value)}
                placeholder="e.g. Any leg fails → $50 bonus bet"
                className={`${inp} flex-1`}
              />
              <input
                type="number"
                value={form.bet_return_value}
                onChange={(e) => set('bet_return_value', e.target.value)}
                placeholder="$value"
                step="0.01"
                min="0"
                className={`${inp} w-24`}
              />
            </div>
            <p className="text-xs text-slate-500">Only paid out if this bet loses.</p>
          </div>
        </div>

        {/* ── Multi Legs ── */}
        {form.bet_type === 'multi' && (
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Legs ({legs.length})
              </p>
              <button
                type="button"
                onClick={addLeg}
                className="text-xs text-green-400 hover:text-green-300 transition-colors"
              >
                + Add leg
              </button>
            </div>

            {legs.map((leg, i) => (
              <div key={i} className="bg-slate-900/70 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-300">Leg {i + 1}</span>
                  {legs.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeLeg(i)}
                      className="text-xs text-red-400 hover:text-red-300 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={lbl}>Sport</label>
                    <select
                      value={leg.sport}
                      onChange={(e) => setLeg(i, 'sport', e.target.value)}
                      className={inp}
                    >
                      <option value="">Select sport</option>
                      {LEG_SPORTS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Date & Time AEST</label>
                    <input
                      type="datetime-local"
                      value={leg.event_time}
                      onChange={(e) => setLeg(i, 'event_time', e.target.value)}
                      className={inp}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className={lbl}>Event / Match</label>
                    <input
                      type="text"
                      value={leg.event}
                      onChange={(e) => setLeg(i, 'event', e.target.value)}
                      placeholder="e.g. Chelsea vs Arsenal"
                      required
                      className={inp}
                    />
                  </div>
                  <div>
                    <label className={lbl}>Market Type (optional)</label>
                    <input
                      type="text"
                      value={leg.description}
                      onChange={(e) => setLeg(i, 'description', e.target.value)}
                      placeholder="e.g. Win-Draw-Win"
                      className={inp}
                    />
                  </div>
                  <div>
                    <label className={lbl}>Selection (optional)</label>
                    <input
                      type="text"
                      value={leg.selection}
                      onChange={(e) => setLeg(i, 'selection', e.target.value)}
                      placeholder="e.g. Chelsea"
                      className={inp}
                    />
                  </div>
                  {/* SGM group fields */}
                  <div>
                    <label className={lbl}>SGM Group # (if in SGM)</label>
                    <input
                      type="number"
                      value={leg.leg_group}
                      onChange={(e) => setLeg(i, 'leg_group', e.target.value)}
                      placeholder="1, 2, 3…"
                      min="1"
                      className={inp}
                    />
                  </div>
                  {leg.leg_group !== '' ? (
                    <div>
                      <label className={lbl}>SGM Combined Odds</label>
                      <input
                        type="number"
                        value={leg.group_odds}
                        onChange={(e) => setLeg(i, 'group_odds', e.target.value)}
                        placeholder="e.g. 3.20"
                        step="0.01"
                        min="1.01"
                        className={inp}
                      />
                    </div>
                  ) : (
                    <div>
                      <label className={lbl}>Odds</label>
                      <input
                        type="number"
                        value={leg.odds}
                        onChange={(e) => setLeg(i, 'odds', e.target.value)}
                        placeholder="1.80"
                        step="0.01"
                        min="1.01"
                        className={inp}
                      />
                    </div>
                  )}
                  <div>
                    <label className={lbl}>Outcome</label>
                    <select
                      value={leg.outcome}
                      onChange={(e) => setLeg(i, 'outcome', e.target.value)}
                      className={inp}
                    >
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

        {error && (
          <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        <div className="flex gap-3 pb-4">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex-1 py-2.5 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || extracting}
            className="flex-1 py-2.5 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white font-semibold text-sm transition-colors"
          >
            {saving ? 'Saving...' : 'Save Bet'}
          </button>
        </div>
      </form>
    </div>
  )
}
