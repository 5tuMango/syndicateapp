// POST /api/extract-cash-out
// Body: { imageBase64, mimeType }
// Reads a Sportsbet cash-out screenshot and extracts the cash-out dollar value.
// Uses Haiku (cheap) since we only need a single number.

import { logUsage } from './_lib/logUsage.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })

  const { imageBase64, mimeType, userId } = req.body || {}
  if (!imageBase64 || !mimeType) {
    return res.status(400).json({ error: 'Missing imageBase64 or mimeType' })
  }

  const prompt = `You are reading a Sportsbet bet-slip screenshot.

Find the CASH-OUT VALUE — the dollar amount the bookmaker paid the punter when they cashed the bet out early. Possible visual cues:
  - A line saying "Cashed Out" with a green money-bag icon and "+ $XXX.XX"
  - A button or summary line labelled "Cash Out" with a dollar amount next to it
  - Text like "Cashed Out + $474.20" or similar

This value is NOT the original stake or potential return — it is the early-payout amount.

Respond with ONLY a JSON object, no prose, no markdown:
{ "value": 474.20, "confidence": "high" }

If you can't find a clear cash-out amount:
{ "value": null, "confidence": "low", "reason": "short explanation" }

The "value" must be a plain number in AUD dollars (no $ sign, no + sign, no quotes).`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Use the same Sonnet 4.6 the other extract-* endpoints use — single
        // image, single number, very few tokens, so cost stays tiny.
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      return res.status(500).json({ error: err?.error?.message || 'Anthropic API error' })
    }

    const data = await response.json()
    logUsage({ endpoint: 'extract-cash-out', userId, model: 'claude-sonnet-4-6', usage: data.usage, imageCount: 1 })

    const textBlock = data.content.find((b) => b.type === 'text')
    if (!textBlock) return res.status(500).json({ error: 'No response from AI' })

    const cleaned = textBlock.text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return res.status(500).json({ error: 'Could not parse AI response', raw: textBlock.text.substring(0, 200) })

    const parsed = JSON.parse(match[0])
    // Be lenient: model might return "$474.20", "+474.20", or "474.20".
    let value = null
    if (parsed.value != null) {
      const cleaned = String(parsed.value).replace(/[^0-9.\-]/g, '')
      const n = parseFloat(cleaned)
      if (!isNaN(n) && n > 0) value = n
    }
    return res.status(200).json({
      value,
      confidence: parsed.confidence || 'low',
      reason: parsed.reason || null,
      raw: textBlock.text.substring(0, 500),
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
