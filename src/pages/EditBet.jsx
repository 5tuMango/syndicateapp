import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { SPORTS, LEG_SPORTS } from '../lib/utils'

const inp =
  'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:border-green-500 text-sm'
const lbl = 'block text-xs text-slate-400 mb-1 uppercase tracking-wide'

export default function EditBet() {
  const { id } = useParams()
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({})
  const [legs, setLegs] = useState([])
  const [rolloverSources, setRolloverSources] = useState([]) // available source bets for rollover

  // Void leg handling
  // null = not yet decided, 'whole' = entire bet void, 'partial' = leg removed, bet continues
  const [voidDecision, setVoidDecision] = useState(null)
  const [updatedOdds, setUpdatedOdds] = useState('')

  useEffect(() => {
    fetchBet()
  }, [id])

  async function fetchBet() {
    const { data, error } = await supabase
      .from('bets')
      .select('*, bet_legs(*)')
      .eq('id', id)
      .single()

    if (error || !data || (data.user_id !== user.id && !profile?.is_admin)) {
      navigate('/')
      return
    }

    setForm({
      date: data.date,
      sport: data.sport,
      event: data.event,
      bet_type: data.bet_type,
      odds: String(data.odds),
      stake: String(data.stake),
      outcome: data.outcome,
      notes: data.notes || '',
      event_time: data.event_time ? data.event_time.substring(0, 16) : '',
      is_rollover: data.is_rollover || false,
      rollover_source_id: data.rollover_source_id || '',
      intend_to_rollover: data.intend_to_rollover || false,
      is_bonus_bet: data.is_bonus_bet || false,
    })

    // Fetch available rollover source bets for this persona
    if (data.persona_id) {
      const { data: sources } = await supabase
        .from('bets')
        .select('id, event, stake, odds')
        .eq('persona_id', data.persona_id)
        .eq('intend_to_rollover', true)
        .eq('outcome', 'won')
        .neq('id', data.id)
      setRolloverSources(sources || [])
    }

    setLegs(
      [...(data.bet_legs || [])]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((l) => ({
          id: l.id,
          sport: l.sport || '',
          event_time: l.event_time ? l.event_time.substring(0, 16) : '',
          event: l.event,
          description: l.description || '',
          selection: l.selection || '',
          odds: l.odds != null ? String(l.odds) : '',
          leg_group: l.leg_group != null ? String(l.leg_group) : '',
          group_odds: l.group_odds != null ? String(l.group_odds) : '',
          outcome: l.outcome,
        }))
    )

    setLoading(false)
  }

  const set = (key, val) => setForm((p) => ({ ...p, [key]: val }))

  // When a leg outcome changes, reset void decision if no void legs remain
  const handleLegChange = (i, key, val) => {
    const newLegs = legs.map((leg, idx) => (idx === i ? { ...leg, [key]: val } : leg))
    setLegs(newLegs)
    if (key === 'outcome' && !newLegs.some((l) => l.outcome === 'void')) {
      setVoidDecision(null)
      setUpdatedOdds('')
    }
  }

  // Whether any leg is currently marked void
  const hasVoidLegs = form.bet_type === 'multi' && legs.some((l) => l.outcome === 'void')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    // Block save if void decision hasn't been made yet
    if (hasVoidLegs && voidDecision === null) {
      return setError('Please indicate whether the entire bet is void or not.')
    }
    if (hasVoidLegs && voidDecision === 'partial') {
      const o = parseFloat(updatedOdds)
      if (!updatedOdds || isNaN(o) || o <= 1) {
        return setError('Please enter the updated combined odds after removing the void leg.')
      }
    }

    setSaving(true)
    try {
      // Determine parent outcome for multi bets
      let finalOutcome = form.outcome
      let oddsToSave = parseFloat(form.odds)

      if (form.bet_type === 'multi' && legs.length > 0) {
        if (voidDecision === 'whole') {
          // User confirmed the whole bet is void
          finalOutcome = 'void'
        } else {
          // Partial void — remove void legs from calculation, use updated odds
          if (voidDecision === 'partial') oddsToSave = parseFloat(updatedOdds)
          const nonVoidLegs = legs.filter((l) => l.outcome !== 'void')
          if (nonVoidLegs.length === 0) {
            finalOutcome = 'void'
          } else if (nonVoidLegs.some((l) => l.outcome === 'pending')) {
            finalOutcome = 'pending'
          } else if (nonVoidLegs.some((l) => l.outcome === 'lost')) {
            finalOutcome = 'lost'
          } else {
            finalOutcome = 'won'
          }
        }
      }

      const { error: betErr } = await supabase
        .from('bets')
        .update({
          date: form.date,
          sport: form.sport,
          event: form.event.trim(),
          odds: oddsToSave,
          stake: parseFloat(form.stake),
          outcome: finalOutcome,
          notes: form.notes.trim() || null,
          event_time: form.event_time || legs.find(l => l.event_time)?.event_time || null,
          is_rollover: form.is_rollover || false,
          rollover_source_id: form.is_rollover && form.rollover_source_id ? form.rollover_source_id : null,
          intend_to_rollover: form.intend_to_rollover || false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)

      if (betErr) throw betErr

      for (const leg of legs) {
        if (leg.id) {
          const { error: legErr } = await supabase
            .from('bet_legs')
            .update({
              sport: leg.sport || null,
              event_time: leg.event_time || null,
              event: leg.event.trim(),
              description: leg.description.trim() || null,
              selection: leg.selection.trim() || null,
              odds: leg.leg_group !== '' ? null : (leg.odds !== '' ? parseFloat(leg.odds) : null),
              leg_group: leg.leg_group !== '' ? parseInt(leg.leg_group) : null,
              group_odds: leg.group_odds !== '' ? parseFloat(leg.group_odds) : null,
              outcome: leg.outcome,
            })
            .eq('id', leg.id)
          if (legErr) throw legErr
        }
      }

      navigate(-1)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="text-center text-slate-400 py-16">Loading...</div>
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Edit Bet</h1>
        <p className="text-slate-400 text-sm mt-0.5">Update details or mark the outcome</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
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
              required
              className={inp}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Odds</label>
              <input
                type="number"
                value={form.odds}
                onChange={(e) => set('odds', e.target.value)}
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
                step="0.01"
                min="0.01"
                required
                className={inp}
              />
            </div>
          </div>

          {/* Outcome — manual for singles, auto-derived for multis */}
          {form.bet_type !== 'multi' ? (
            <div>
              <label className={lbl}>Outcome</label>
              <div className="flex gap-2">
                {['pending', 'won', 'lost', 'void'].map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => set('outcome', o)}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors capitalize ${
                      form.outcome === o
                        ? o === 'won'
                          ? 'bg-green-500/20 text-green-400 border-green-500/50'
                          : o === 'lost'
                          ? 'bg-red-500/20 text-red-400 border-red-500/50'
                          : o === 'void'
                          ? 'bg-slate-500/20 text-slate-300 border-slate-500/50'
                          : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50'
                        : 'bg-slate-700 text-slate-400 border-slate-600 hover:border-slate-400'
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-xs text-slate-500 bg-slate-900/50 rounded-lg px-3 py-2">
              Outcome is set automatically from leg results — mark each leg below.
            </div>
          )}

          <div>
            <label className={lbl}>Notes (optional)</label>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
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

          {/* Rollover fields */}
          <div className="border-t border-slate-700 pt-4 space-y-3">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Rollover</p>

            {/* Intend to rollover */}
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div
                onClick={() => set('intend_to_rollover', !form.intend_to_rollover)}
                className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${form.intend_to_rollover ? 'bg-green-500' : 'bg-slate-600'}`}
              >
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${form.intend_to_rollover ? 'translate-x-5' : 'translate-x-1'}`} />
              </div>
              <span className="text-sm text-slate-300">Intend to rollover winnings <span className="text-slate-500 text-xs">(if won, profit tracked for re-betting)</span></span>
            </label>

            {/* Is rollover */}
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div
                onClick={() => set('is_rollover', !form.is_rollover)}
                className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${form.is_rollover ? 'bg-blue-500' : 'bg-slate-600'}`}
              >
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${form.is_rollover ? 'translate-x-5' : 'translate-x-1'}`} />
              </div>
              <span className="text-sm text-slate-300">Rollover stake <span className="text-slate-500 text-xs">(funded from prior winnings)</span></span>
            </label>

            {/* Source bet selector — shown when is_rollover is on */}
            {form.is_rollover && (
              <div>
                <label className={lbl}>Source bet (rollover from)</label>
                {rolloverSources.length > 0 ? (
                  <select
                    value={form.rollover_source_id}
                    onChange={(e) => set('rollover_source_id', e.target.value)}
                    className={inp}
                  >
                    <option value="">— select source bet —</option>
                    {rolloverSources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.event} (${(parseFloat(s.stake) * parseFloat(s.odds)).toFixed(2)} return)
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs text-slate-500 bg-slate-900/50 rounded-lg px-3 py-2">
                    No won rollover-intent bets found for this persona.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Legs */}
        {legs.length > 0 && (
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-4">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Legs ({legs.length})
            </p>
            {legs.map((leg, i) => (
              <div key={i} className="bg-slate-900/70 rounded-lg p-4 space-y-3">
                <span className="text-sm font-medium text-slate-300">Leg {i + 1}</span>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div>
                    <label className={lbl}>Sport</label>
                    <select
                      value={leg.sport}
                      onChange={(e) => handleLegChange(i, 'sport', e.target.value)}
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
                      onChange={(e) => handleLegChange(i, 'event_time', e.target.value)}
                      className={inp}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className={lbl}>Event / Match</label>
                    <input
                      type="text"
                      value={leg.event}
                      onChange={(e) => handleLegChange(i, 'event', e.target.value)}
                      required
                      className={inp}
                    />
                  </div>
                  <div>
                    <label className={lbl}>Market Type (optional)</label>
                    <input
                      type="text"
                      value={leg.description}
                      onChange={(e) => handleLegChange(i, 'description', e.target.value)}
                      placeholder="e.g. Win-Draw-Win"
                      className={inp}
                    />
                  </div>
                  <div>
                    <label className={lbl}>Selection (optional)</label>
                    <input
                      type="text"
                      value={leg.selection}
                      onChange={(e) => handleLegChange(i, 'selection', e.target.value)}
                      placeholder="e.g. Chelsea"
                      className={inp}
                    />
                  </div>
                  <div>
                    <label className={lbl}>SGM Group # (if in SGM)</label>
                    <input
                      type="number"
                      value={leg.leg_group}
                      onChange={(e) => handleLegChange(i, 'leg_group', e.target.value)}
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
                        onChange={(e) => handleLegChange(i, 'group_odds', e.target.value)}
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
                        onChange={(e) => handleLegChange(i, 'odds', e.target.value)}
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
                      onChange={(e) => handleLegChange(i, 'outcome', e.target.value)}
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

        {/* Void leg prompt — appears when any leg is marked void */}
        {hasVoidLegs && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-5 space-y-4">
            <div>
              <p className="text-yellow-400 text-sm font-semibold">⚠ Void leg detected</p>
              <p className="text-slate-300 text-sm mt-1">
                Is the entire bet void, or does it continue with the remaining legs?
              </p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setVoidDecision('whole'); setUpdatedOdds('') }}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                  voidDecision === 'whole'
                    ? 'bg-slate-500/30 text-slate-200 border-slate-400/50'
                    : 'bg-slate-700 text-slate-400 border-slate-600 hover:border-slate-400'
                }`}
              >
                Yes — void entire bet
              </button>
              <button
                type="button"
                onClick={() => setVoidDecision('partial')}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                  voidDecision === 'partial'
                    ? 'bg-blue-500/20 text-blue-400 border-blue-500/50'
                    : 'bg-slate-700 text-slate-400 border-slate-600 hover:border-slate-400'
                }`}
              >
                No — continue with remaining legs
              </button>
            </div>

            {voidDecision === 'partial' && (
              <div>
                <label className={lbl}>Updated combined odds (excluding void leg)</label>
                <input
                  type="number"
                  value={updatedOdds}
                  onChange={(e) => setUpdatedOdds(e.target.value)}
                  placeholder="e.g. 4.20"
                  step="0.01"
                  min="1.01"
                  className={inp}
                />
                <p className="text-xs text-slate-500 mt-1">
                  Enter the revised odds Sportsbet shows after the void leg is removed.
                </p>
              </div>
            )}
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
            disabled={saving}
            className="flex-1 py-2.5 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white font-semibold text-sm transition-colors"
          >
            {saving ? 'Saving...' : 'Update Bet'}
          </button>
        </div>
      </form>
    </div>
  )
}
