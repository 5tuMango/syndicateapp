import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { fileToResizedBase64 } from '../utils/resizeImage'

// Shared modal for marking a bet (or weekly multi) as cashed out.
// `table` is 'bets' or 'weekly_multis'. `row` is the existing record — fields
// we read: id, stake, cashed_out, cash_out_value, cash_out_image.
//
// Behaviour:
//   - Saving with a value sets cashed_out=true, cash_out_value=val, outcome='won'
//     (so the bet lands in won filters across the app — calcWinnings then uses
//     cash_out_value, not stake×odds).
//   - Saving with value cleared (or "Remove cash-out") reverts cashed_out=false
//     and clears the value/image. The leg-derived outcome is left alone — the
//     resolver / manual edits will set it normally.
//   - Screenshot is optional; stored as base64 data URL on cash_out_image.
export default function CashOutModal({ open, onClose, table, row, onSaved }) {
  const [value, setValue] = useState(
    row?.cash_out_value != null ? String(row.cash_out_value) : ''
  )
  const [image, setImage] = useState(row?.cash_out_image || null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [extracting, setExtracting] = useState(false)
  const [extractMsg, setExtractMsg] = useState(null)

  if (!open) return null

  const stake = parseFloat(row?.stake || 0)
  const numericValue = parseFloat(value)
  const profit = !isNaN(numericValue) ? numericValue - stake : null

  async function handleImage(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setExtractMsg(null)
    try {
      // fileToResizedBase64 returns { imageBase64, mimeType } — wrap it back
      // into a data URL so we can both preview <img src=…> and store it.
      const { imageBase64, mimeType } = await fileToResizedBase64(file)
      setImage(`data:${mimeType};base64,${imageBase64}`)

      // Try to OCR the cash-out value out of the screenshot. Cheap Haiku call.
      // User can override if it gets it wrong, or we leave the field empty.
      setExtracting(true)
      try {
        const res = await fetch('/api/extract-cash-out', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64, mimeType }),
        })
        const data = await res.json()
        if (res.ok && data.value != null) {
          setValue(String(data.value))
          setExtractMsg({ ok: true, text: `Read $${data.value.toFixed(2)} from screenshot — adjust if needed.` })
        } else {
          // Surface the actual server error so we can debug failed reads.
          const detail = data.error || data.reason || 'no value found'
          setExtractMsg({ ok: false, text: `Auto-read failed (${detail}) — enter the value manually.` })
        }
      } catch (err) {
        setExtractMsg({ ok: false, text: `Auto-read failed: ${err.message} — enter the value manually.` })
      } finally {
        setExtracting(false)
      }
    } catch (err) {
      setError('Could not read image: ' + err.message)
    }
    e.target.value = ''
  }

  async function handleSave() {
    if (!numericValue || numericValue <= 0) {
      setError('Enter a cash-out value greater than $0.')
      return
    }
    setSaving(true)
    setError(null)
    const update = {
      cashed_out: true,
      cash_out_value: numericValue,
      cash_out_image: image || null,
      // Cashed-out bets are settled wins regardless of leg outcomes — flip the
      // top-level outcome so won-bet filters / sections include them.
      outcome: 'won',
      updated_at: new Date().toISOString(),
    }
    const { error: err } = await supabase.from(table).update(update).eq('id', row.id)
    setSaving(false)
    if (err) {
      setError(err.message)
      return
    }
    onSaved?.()
    onClose?.()
  }

  async function handleRemove() {
    if (!confirm('Remove cash-out from this bet? It will revert to using leg outcomes for settlement.')) return
    setSaving(true)
    setError(null)
    const { error: err } = await supabase
      .from(table)
      .update({
        cashed_out: false,
        cash_out_value: null,
        cash_out_image: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
    setSaving(false)
    if (err) {
      setError(err.message)
      return
    }
    onSaved?.()
    onClose?.()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 w-full max-w-sm space-y-4">
        <div>
          <h3 className="text-white font-semibold text-base">Cash-Out Settlement</h3>
          <p className="text-slate-400 text-xs mt-1">
            Bookmaker paid this out early. The cash-out value replaces the
            stake × odds calculation for winnings and P&amp;L.
          </p>
        </div>

        <div className="space-y-2">
          <label className="block text-xs text-slate-400 uppercase tracking-wide">
            Cash-Out Value (AUD)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-slate-400">$</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
              placeholder="474.20"
            />
          </div>
          {extracting && (
            <p className="text-xs text-slate-400">📖 Reading value from screenshot…</p>
          )}
          {extractMsg && !extracting && (
            <p className={`text-xs ${extractMsg.ok ? 'text-emerald-400' : 'text-yellow-400'}`}>
              {extractMsg.text}
            </p>
          )}
          {profit != null && !isNaN(profit) && (
            <p className="text-xs text-slate-500">
              Stake ${stake.toFixed(2)} · Profit{' '}
              <span className={profit >= 0 ? 'text-green-400' : 'text-red-400'}>
                {profit >= 0 ? '+' : ''}${profit.toFixed(2)}
              </span>
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label className="block text-xs text-slate-400 uppercase tracking-wide">
            Screenshot (optional)
          </label>
          {image ? (
            <div className="space-y-2">
              <img src={image} alt="cash out screenshot" className="rounded-lg border border-slate-700 max-h-40 object-contain w-full" />
              <button
                onClick={() => setImage(null)}
                className="text-xs text-slate-400 hover:text-red-400"
              >
                Remove screenshot
              </button>
            </div>
          ) : (
            <label className="block bg-slate-900 border border-dashed border-slate-600 rounded-lg px-3 py-3 text-center text-xs text-slate-400 cursor-pointer hover:border-slate-500 transition-colors">
              📷 Upload screenshot
              <input type="file" accept="image/*" className="hidden" onChange={handleImage} />
            </label>
          )}
        </div>

        {error && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          {row?.cashed_out ? (
            <button
              onClick={handleRemove}
              disabled={saving}
              className="text-xs text-slate-500 hover:text-red-400 disabled:opacity-50"
            >
              Remove cash-out
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded-lg bg-green-500/20 border border-green-500/40 text-green-400 hover:bg-green-500/30 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save cash-out'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
