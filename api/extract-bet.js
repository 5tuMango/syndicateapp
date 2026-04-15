// Vercel Serverless Function — keeps the Anthropic API key server-side only
// POST /api/extract-bet
// Body: { imageBase64: string, mimeType: string }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' })
  }

  const { imageBase64, mimeType } = req.body
  if (!imageBase64 || !mimeType) {
    return res.status(400).json({ error: 'Missing imageBase64 or mimeType in request body.' })
  }

  // Inject current year so Claude never guesses a year from a screenshot that omits it
  const currentYear = new Date().getFullYear()

  const prompt = `You are reading a screenshot from the Sportsbet app (Australian sports betting platform) showing a bet slip or bet confirmation screen.

Extract all visible bet details and return them as a single valid JSON object. Use these exact field names:

- "sport": the sport for the overall bet. Use one of these values only: AFL, NRL, Cricket, Horse Racing, Greyhounds, Tennis, Soccer, NBA, NFL, Boxing, MMA, Rugby Union, Golf, Multi, Other. Use "Multi" when the bet spans more than one sport (e.g. AFL legs AND horse racing legs in the same multi).
- "event": the main event or match name (string)
- "bet_type": either "single" or "multi"
- "odds": the total/combined decimal odds as a number (e.g. 2.50)
- "stake": the dollar amount wagered as a number (e.g. 10.00)
- "payout": the potential return amount as a number (e.g. 25.00)
- "event_time": the event start time in AEST, format "YYYY-MM-DDTHH:MM" using 24-hour time (e.g. "${currentYear}-04-11T15:35"). Use ${currentYear} as the year unless a different year is clearly visible in the screenshot. For multi bets leave this null (use event_time on each leg instead).
- "legs": flat array of objects — ONLY include this for multi bets.
  IMPORTANT: If the multi contains a Same Game Multi (SGM) as one of its components, expand the SGM into its individual sub-selections as separate leg entries — do NOT nest them. Use leg_group to link them.

  Each leg object has:
  - "sport": the sport for this specific leg — one of: AFL, NRL, Cricket, Horse Racing, Greyhounds, Tennis, Soccer, NBA, NFL, Boxing, MMA, Rugby Union, Golf, Other
  - "event_time": the scheduled start time for this leg in AEST, format "YYYY-MM-DDTHH:MM" 24-hour (e.g. "${currentYear}-04-11T13:15"). Use ${currentYear} as the year unless a different year is clearly visible in the screenshot.
  - "event": the match or event name for this leg (string)
  - "description": the market type e.g. "Head to Head", "Win-Draw-Win", "Pick Your Line", "Player Goals" (string)
  - "selection": the specific pick e.g. "Chelsea", "Essendon (+40.5)", "Kysaiah Pickett 2+ Goals" (string)
  - "odds": decimal odds for this leg as a number — use null if this leg is part of an SGM group (SGM sub-legs have no individual odds)
  - "leg_group": integer (1, 2, 3…) if this leg belongs to an SGM within the multi, otherwise null. All sub-legs of the same SGM share the same leg_group number.
  - "group_odds": the combined decimal odds of the SGM group (e.g. 3.20) — include on every leg that has a leg_group. Null for standalone legs.

  Example for a multi containing an SGM @ 3.20 (Essendon v Melbourne) plus a standalone horse race @ 1.40:
  [
    { "sport": "AFL", "event_time": "${currentYear}-04-11T19:35", "event": "Essendon v Melbourne", "description": "Pick Your Line", "selection": "Essendon (+40.5)", "odds": null, "leg_group": 1, "group_odds": 3.20 },
    { "sport": "AFL", "event_time": "${currentYear}-04-11T19:35", "event": "Essendon v Melbourne", "description": "Player Goals", "selection": "Kysaiah Pickett 2+ Goals", "odds": null, "leg_group": 1, "group_odds": 3.20 },
    { "sport": "Horse Racing", "event_time": "${currentYear}-04-11T13:15", "event": "4. Amazake (9) — Caulfield Race 7", "description": "Place", "selection": "4. Amazake (9)", "odds": 1.40, "leg_group": null, "group_odds": null }
  ]

Rules:
- Only include a field if you can clearly read it from the screenshot
- If a value is unclear or not visible, omit that field entirely
- Return ONLY the raw JSON object — no markdown, no code blocks, no explanation

IMPORTANT — Sportsbet Power Price:
On Sportsbet, a "Power Price" bet shows TWO odds numbers next to the bet type, e.g. "Multi @ 72.00 58.40 ⚡" or "@ 3.20 2.80 ⚡". In this format:
- The FIRST number (e.g. 72.00) is the boosted/current odds — use this as "odds"
- The SECOND number (e.g. 58.40) is the original base price — ignore it completely
- Neither number is the stake. The stake is a separate dollar amount shown elsewhere on the slip (e.g. "Stake: $10.00" or "You Bet: $10.00"). If no stake is clearly labelled, omit the "stake" field entirely.`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: imageBase64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      }),
    })

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}))
      throw new Error(errBody?.error?.message || `Anthropic API returned ${response.status}`)
    }

    const result = await response.json()
    const text = result.content?.[0]?.text ?? ''

    // Strip any accidental markdown code fences
    const cleaned = text.replace(/```(?:json)?/gi, '').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('Claude did not return valid JSON.')

    const data = JSON.parse(jsonMatch[0])
    return res.json({ success: true, data })
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message })
  }
}
