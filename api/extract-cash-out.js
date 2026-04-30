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

  const prompt = `You are reading a Sportsbet bet-slip screenshot that shows a cash-out settlement.

Find the cash-out value — the dollar amount the bookmaker paid the punter when they cashed the bet out early. It is usually labelled "Cashed Out" with a green money-bag icon and a "+ $X.XX" amount, or appears next to "Cash Out" in the bet summary.

Return ONLY a valid JSON object:
{ "value": <number, AUD dollars, e.g. 474.20>, "confidence": "high" | "medium" | "low" }

If you cannot find a clear cash-out value, return:
{ "value": null, "confidence": "low", "reason": "<short reason>" }

Do not include the dollar sign or any other text — just the number.`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Haiku 4.5 — cheap vision; we only need to OCR a single dollar amount.
        model: 'claude-haiku-4-5',
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
    logUsage({ endpoint: 'extract-cash-out', userId, model: 'claude-haiku-4-5', usage: data.usage, imageCount: 1 })

    const textBlock = data.content.find((b) => b.type === 'text')
    if (!textBlock) return res.status(500).json({ error: 'No response from AI' })

    const cleaned = textBlock.text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return res.status(500).json({ error: 'Could not parse AI response', raw: textBlock.text.substring(0, 200) })

    const parsed = JSON.parse(match[0])
    const value = parsed.value != null ? parseFloat(parsed.value) : null
    return res.status(200).json({
      value: !isNaN(value) && value > 0 ? value : null,
      confidence: parsed.confidence || 'low',
      reason: parsed.reason || null,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
