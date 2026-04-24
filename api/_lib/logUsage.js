// Fire-and-forget logger for Claude API calls.
// Inserts a row into public.api_usage via the Supabase service key.
// Never throws — logging failures must not break the actual API response.
//
// Pricing (USD per million tokens) — update here if models/prices change.
// Sonnet 4.6: $3 in / $15 out, cache reads $0.30, cache writes $3.75
// Haiku 4.5:   $1 in / $5 out (rough)
const PRICING = {
  'claude-sonnet-4-6':  { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5':  { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5':   { in: 1.00, out:  5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  // Fallback default — use Sonnet pricing
  __default:            { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
}

function calcCost(model, usage) {
  const p = PRICING[model] || PRICING.__default
  const inTok = usage?.input_tokens || 0
  const outTok = usage?.output_tokens || 0
  const cacheRead = usage?.cache_read_input_tokens || 0
  const cacheWrite = usage?.cache_creation_input_tokens || 0
  const cost =
    (inTok * p.in +
      outTok * p.out +
      cacheRead * p.cacheRead +
      cacheWrite * p.cacheWrite) / 1_000_000
  return Number(cost.toFixed(6))
}

export async function logUsage({ endpoint, userId, model, usage, imageCount = 0, success = true, note = null }) {
  const SUPABASE_URL = process.env.VITE_SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  if (!SUPABASE_URL || !SUPABASE_KEY) return // no-op if not configured

  const row = {
    endpoint,
    user_id: userId || null,
    model: model || null,
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    cache_read_tokens: usage?.cache_read_input_tokens || 0,
    cache_creation_tokens: usage?.cache_creation_input_tokens || 0,
    image_count: imageCount,
    cost_usd: calcCost(model, usage),
    success,
    note,
  }

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/api_usage`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    })
  } catch (err) {
    console.warn('[logUsage] insert failed:', err.message)
  }
}
