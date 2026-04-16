// GET  /api/create-weekly-multi  — called by Vercel cron every Monday
// POST /api/create-weekly-multi  — manual trigger (admin use)
//
// Creates the next weekly multi for the upcoming weekend.
// Week number is derived by finding the highest "Week N" label in existing multis.
// Weekend label = Friday–Sunday of that week, e.g. "Week 7 — 25-27 Apr"

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Auth: require CRON_SECRET header
  const CRON_SECRET = process.env.CRON_SECRET
  const authHeader = req.headers.authorization
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' })

  // ── 1. Fetch all existing multis to find highest week number ───────────────
  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/weekly_multis?select=id,week_label&order=created_at.desc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const existing = await existingRes.json()

  // Parse "Week N" from any label to find the current max
  let maxWeek = 0
  for (const m of (Array.isArray(existing) ? existing : [])) {
    const match = m.week_label?.match(/Week\s+(\d+)/i)
    if (match) maxWeek = Math.max(maxWeek, parseInt(match[1]))
  }
  const nextWeek = maxWeek + 1

  // ── 2. Calculate upcoming weekend dates ────────────────────────────────────
  // Cron runs Monday AEST. We want the Friday–Sunday of that same week.
  const now = new Date()
  // Find the Monday of the current week (or today if it's Monday)
  const dayOfWeek = now.getUTCDay() // 0=Sun, 1=Mon … 6=Sat
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() + daysToMonday)

  const friday = new Date(monday)
  friday.setUTCDate(monday.getUTCDate() + 4)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)

  function fmt(d) {
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  }

  // e.g. "25 Apr" → "27 Apr" — extract just the day numbers for the range
  const friDay = friday.getUTCDate()
  const sunDay = sunday.getUTCDate()
  const month = friday.toLocaleDateString('en-AU', { month: 'short', timeZone: 'UTC' })
  // If weekend spans two months, show both
  const sunMonth = sunday.toLocaleDateString('en-AU', { month: 'short', timeZone: 'UTC' })
  const dateRange = month === sunMonth
    ? `${friDay}-${sunDay} ${month}`
    : `${friDay} ${month} - ${sunDay} ${sunMonth}`

  const weekLabel = `Week ${nextWeek} — ${dateRange}`

  // ── 3. Guard: don't create a duplicate for the same week number ────────────
  const duplicate = Array.isArray(existing) && existing.some((m) => {
    const match = m.week_label?.match(/Week\s+(\d+)/i)
    return match && parseInt(match[1]) === nextWeek
  })
  if (duplicate) {
    return res.status(200).json({ message: `Week ${nextWeek} already exists — skipped`, weekLabel })
  }

  // ── 4. Create the multi ────────────────────────────────────────────────────
  const insertRes = await fetch(
    `${SUPABASE_URL}/rest/v1/weekly_multis`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ week_label: weekLabel, stake: 0 }),
    }
  )
  const inserted = await insertRes.json()
  if (!insertRes.ok || !Array.isArray(inserted) || inserted.length === 0) {
    return res.status(500).json({ error: 'Failed to create weekly multi', detail: inserted })
  }
  const multi = inserted[0]

  // ── 5. Auto-add all personas as leg slots ─────────────────────────────────
  const personasRes = await fetch(
    `${SUPABASE_URL}/rest/v1/personas?select=id,nickname,claimed_by&order=nickname`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const personas = await personasRes.json()

  if (Array.isArray(personas) && personas.length > 0) {
    const legs = personas.map((p, i) => ({
      weekly_multi_id: multi.id,
      persona_id: p.id,
      assigned_user_id: p.claimed_by || null,
      sort_order: i,
    }))
    await fetch(`${SUPABASE_URL}/rest/v1/weekly_multi_legs`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(legs),
    })
  }

  // ── 6. Send notifications to claimed members only ─────────────────────────
  const claimed = Array.isArray(personas) ? personas.filter((p) => p.claimed_by) : []
  if (claimed.length > 0) {
    const notifs = claimed.map((p) => ({
      user_id: p.claimed_by,
      title: `${weekLabel} is live!`,
      body: 'Enter your pick for this week\'s multi.',
      link: '/weekly-multi',
    }))
    await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(notifs),
    })
  }

  return res.status(200).json({
    message: `Created ${weekLabel}`,
    weekLabel,
    multiId: multi.id,
    membersAdded: Array.isArray(personas) ? personas.length : 0,
  })
}
