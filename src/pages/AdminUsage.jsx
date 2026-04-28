import { useState, useEffect, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

function formatUSD(n) {
  if (!Number.isFinite(n)) return '$0.00'
  return n >= 1
    ? `$${n.toFixed(2)}`
    : `$${n.toFixed(4)}`
}

function formatNum(n) {
  return (n || 0).toLocaleString()
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export default function AdminUsage() {
  const { profile } = useAuth()
  const [rows, setRows] = useState([])
  const [profiles, setProfiles] = useState({})
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(30)
  const [alerts, setAlerts] = useState([])

  if (!profile?.is_admin) return <Navigate to="/" replace />

  useEffect(() => {
    load()
    loadAlerts()
  }, [days])

  async function loadAlerts() {
    const { data } = await supabase
      .from('system_alerts')
      .select('*')
      .eq('resolved', false)
      .order('created_at', { ascending: false })
    setAlerts(data || [])
  }

  async function dismissAlert(id) {
    await supabase.from('system_alerts').update({ resolved: true }).eq('id', id)
    setAlerts(a => a.filter(x => x.id !== id))
  }

  async function load() {
    setLoading(true)
    const sinceIso = new Date(Date.now() - days * 864e5).toISOString()
    const { data: usage } = await supabase
      .from('api_usage')
      .select('*')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(2000)

    const userIds = [...new Set((usage || []).map(r => r.user_id).filter(Boolean))]
    let profileMap = {}
    if (userIds.length > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, username')
        .in('id', userIds)
      for (const p of (profs || [])) profileMap[p.id] = p.full_name || p.username || 'Unknown'
    }

    setRows(usage || [])
    setProfiles(profileMap)
    setLoading(false)
  }

  const stats = useMemo(() => {
    const now = Date.now()
    const msDay = 864e5
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const todayMs = today.getTime()

    const totals = { today: 0, last7d: 0, last30d: 0, all: 0 }
    const byEndpoint = {}
    const byUser = {}

    for (const r of rows) {
      const t = new Date(r.created_at).getTime()
      const cost = Number(r.cost_usd || 0)

      if (t >= todayMs) totals.today += cost
      if (t >= now - 7 * msDay) totals.last7d += cost
      if (t >= now - 30 * msDay) totals.last30d += cost
      totals.all += cost

      if (!byEndpoint[r.endpoint]) byEndpoint[r.endpoint] = { calls: 0, cost: 0, tokens: 0 }
      byEndpoint[r.endpoint].calls += 1
      byEndpoint[r.endpoint].cost += cost
      byEndpoint[r.endpoint].tokens += (r.input_tokens || 0) + (r.output_tokens || 0)

      const uid = r.user_id || '__unattributed'
      if (!byUser[uid]) byUser[uid] = { calls: 0, cost: 0 }
      byUser[uid].calls += 1
      byUser[uid].cost += cost
    }

    return {
      totals,
      byEndpoint: Object.entries(byEndpoint).sort((a, b) => b[1].cost - a[1].cost),
      byUser: Object.entries(byUser).sort((a, b) => b[1].cost - a[1].cost),
    }
  }, [rows])

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-6">
      {alerts.map(alert => (
        <div key={alert.id} className="flex items-start justify-between gap-4 bg-red-900/40 border border-red-500/50 rounded-xl px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-red-300 uppercase tracking-wide">
              {alert.type === 'afl_token_expired' ? 'AFL Token Expired' : 'NRL API Issue'}
            </div>
            <div className="text-sm text-red-200 mt-0.5">{alert.message}</div>
            <div className="text-xs text-red-400 mt-1">{new Date(alert.created_at).toLocaleString('en-AU')}</div>
          </div>
          <button
            onClick={() => dismissAlert(alert.id)}
            className="shrink-0 text-xs text-red-400 hover:text-red-200 border border-red-500/40 rounded px-2 py-1"
          >
            Dismiss
          </button>
        </div>
      ))}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">API Usage</h1>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="bg-slate-800 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-white"
        >
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {loading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : (
        <>
          {/* Totals */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card label="Today" value={formatUSD(stats.totals.today)} />
            <Card label="Last 7 days" value={formatUSD(stats.totals.last7d)} />
            <Card label="Last 30 days" value={formatUSD(stats.totals.last30d)} />
            <Card label={`In window (${days}d)`} value={formatUSD(stats.totals.all)} sub={`${rows.length} calls`} />
          </div>

          {/* By endpoint */}
          <Section title="By endpoint">
            <Table
              head={['Endpoint', 'Calls', 'Tokens', 'Cost']}
              rows={stats.byEndpoint.map(([ep, v]) => [
                ep,
                formatNum(v.calls),
                formatNum(v.tokens),
                formatUSD(v.cost),
              ])}
            />
          </Section>

          {/* By user */}
          <Section title="By user">
            <Table
              head={['User', 'Calls', 'Cost']}
              rows={stats.byUser.map(([uid, v]) => [
                uid === '__unattributed' ? <span className="text-slate-500 italic">Cron / unattributed</span> : (profiles[uid] || uid.substring(0, 8)),
                formatNum(v.calls),
                formatUSD(v.cost),
              ])}
            />
          </Section>

          {/* Recent calls */}
          <Section title="Recent calls">
            <Table
              head={['When', 'Endpoint', 'User', 'Model', 'Imgs', 'In / Out', 'Cost']}
              rows={rows.slice(0, 50).map(r => [
                timeAgo(r.created_at),
                r.endpoint,
                r.user_id ? (profiles[r.user_id] || r.user_id.substring(0, 6)) : <span className="text-slate-500">—</span>,
                <span className="text-xs text-slate-400">{r.model?.replace('claude-', '') || '—'}</span>,
                r.image_count || '',
                `${formatNum(r.input_tokens)} / ${formatNum(r.output_tokens)}`,
                formatUSD(Number(r.cost_usd)),
              ])}
            />
          </Section>
        </>
      )}
    </div>
  )
}

function Card({ label, value, sub }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <div className="text-xs text-slate-400 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold text-white mt-1">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">{title}</h2>
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        {children}
      </div>
    </div>
  )
}

function Table({ head, rows }) {
  if (rows.length === 0) {
    return <div className="px-4 py-6 text-slate-500 text-sm text-center">No data in this window.</div>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-900/50">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="text-left px-4 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/50">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-slate-700/20">
              {r.map((cell, j) => (
                <td key={j} className="px-4 py-2 text-slate-200 whitespace-nowrap">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
