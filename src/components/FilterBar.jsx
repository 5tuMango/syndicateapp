import { SPORTS } from '../lib/utils'

const sel =
  'bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-green-500'

export default function FilterBar({ filters, onChange, members = [] }) {
  const update = (key, value) => onChange({ ...filters, [key]: value })
  const hasFilters = Object.values(filters).some(Boolean)

  return (
    <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-3">
      <div className="flex flex-wrap gap-2 items-center">
        <select value={filters.sport || ''} onChange={(e) => update('sport', e.target.value)} className={sel}>
          <option value="">All Sports</option>
          {SPORTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select value={filters.bet_type || ''} onChange={(e) => update('bet_type', e.target.value)} className={sel}>
          <option value="">All Types</option>
          <option value="single">Single</option>
          <option value="multi">Multi</option>
        </select>

        <select value={filters.outcome || ''} onChange={(e) => update('outcome', e.target.value)} className={sel}>
          <option value="">All Outcomes</option>
          <option value="pending">Pending</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
          <option value="void">Void</option>
        </select>

        {members.length > 0 && (
          <select value={filters.member || ''} onChange={(e) => update('member', e.target.value)} className={sel}>
            <option value="">All Members</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name || m.username}
              </option>
            ))}
          </select>
        )}

        <input
          type="date"
          value={filters.date_from || ''}
          onChange={(e) => update('date_from', e.target.value)}
          title="From date"
          className={sel}
        />

        <input
          type="date"
          value={filters.date_to || ''}
          onChange={(e) => update('date_to', e.target.value)}
          title="To date"
          className={sel}
        />

        {hasFilters && (
          <button
            onClick={() => onChange({})}
            className="text-xs text-slate-400 hover:text-white px-3 py-2 rounded-lg border border-slate-600 hover:border-slate-400 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
