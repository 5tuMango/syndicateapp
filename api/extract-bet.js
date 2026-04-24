// Vercel Serverless Function — keeps the Anthropic API key server-side only
// POST /api/extract-bet
// Body: { images: [{ imageBase64, mimeType }], userId? }
//   OR legacy: { imageBase64: string, mimeType: string }

import { logUsage } from './_lib/logUsage.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' })
  }

  const { imageBase64, mimeType, images, userId } = req.body

  // Normalise to array — support both legacy single-image and new multi-image format
  const imageList = images && images.length > 0
    ? images
    : imageBase64 ? [{ imageBase64, mimeType }] : []

  if (imageList.length === 0) {
    return res.status(400).json({ error: 'Missing images in request body.' })
  }

  // Inject current year so Claude never guesses a year from a screenshot that omits it
  const currentYear = new Date().getFullYear()
  const multipleScreenshots = imageList.length > 1

  const prompt = `You are reading ${multipleScreenshots ? `${imageList.length} screenshots` : 'a screenshot'} from the Sportsbet app (Australian sports betting platform) showing a bet slip or bet confirmation screen.

${multipleScreenshots ? `IMPORTANT — MULTIPLE SCREENSHOTS:
These screenshots are all from the SAME bet slip. They are scrolled views of the same screen, so some content (e.g. the bet header, odds, stake) may only appear in one screenshot while the legs are spread across multiple. Treat them as one continuous scrolled view. Combine all visible information across all screenshots to produce a single complete result — do NOT create duplicate legs if the same leg appears in more than one screenshot.
If a screenshot appears to start mid-bet (e.g. no header visible), assume it is a continuation of the same bet shown in the other screenshots.
CRITICAL — player context carries across screenshots: In Sportsbet's SGM layout, a player's name appears as a bold heading and their stat markets (e.g. "2+ Goals", "20+ Disposals") are listed below it. These stats are cut off at screenshot boundaries. If a stat line appears at the very TOP of a screenshot with no player name immediately above it, the player name is at the BOTTOM of the previous screenshot. You MUST scroll back mentally and use that player name in the selection — e.g. if "Isaac Heeney" is last visible in screenshot 1 and "2+ Goals" is first in screenshot 2, the selection is "Isaac Heeney 2+ Goals". Never output a bare stat like "2+ Goals" without the player name.

` : ''}Extract all visible bet details and return them as a single valid JSON object. Use these exact field names:

- "sport": the sport for the overall bet. Use one of these values only: AFL, NRL, Cricket, Horse Racing, Greyhounds, Tennis, Soccer, NBA, NFL, Boxing, MMA, Rugby Union, Golf, Multi, Other. Use "Multi" when the bet spans more than one sport (e.g. AFL legs AND horse racing legs in the same multi).
- "event": the main event or match name (string)
- "bet_type": either "single" or "multi"
- "odds": the total/combined decimal odds as a number (e.g. 2.50)
- "stake": the dollar amount wagered as a number (e.g. 10.00)
- "payout": the potential return amount as a number (e.g. 25.00)
- "event_time": the event start time in AEST, format "YYYY-MM-DDTHH:MM" using 24-hour time (e.g. "${currentYear}-04-11T15:35"). Use ${currentYear} as the year unless a different year is clearly visible in the screenshot. For multi bets leave this null (use event_time on each leg instead).
  CRITICAL — 24-HOUR TIME: Sportsbet displays all times in 24-hour format. A time that reads "19:50" on the slip means 7:50 PM — output it as "19:50", NOT "9:50". Do NOT drop the leading digit. Evening AFL/NRL/NBA games commonly start between 17:00–20:30 AEST. Always output a zero-padded two-digit hour (e.g. "09:50" for morning, "19:50" for evening).
- "legs": flat array of objects — ONLY include this for multi bets.
  IMPORTANT: If the multi contains a Same Game Multi (SGM) as one of its components, expand the SGM into its individual sub-selections as separate leg entries — do NOT nest them. Use leg_group to link them.

  Each leg object has:
  - "sport": the sport for this specific leg — one of: AFL, NRL, Cricket, Horse Racing, Greyhounds, Tennis, Soccer, NBA, NFL, Boxing, MMA, Rugby Union, Golf, Other
  - "event_time": the scheduled start time for this leg in AEST, format "YYYY-MM-DDTHH:MM" 24-hour (e.g. "${currentYear}-04-11T13:15"). Use ${currentYear} as the year unless a different year is clearly visible in the screenshot. IMPORTANT: times are 24-hour — "19:35" must be output as "19:35" not "9:35". Always two-digit hour.
  - "event": the match or event name for this leg (string)
  - "description": the market type e.g. "Head to Head", "Win-Draw-Win", "Pick Your Line", "Player Goals", "Player Disposals" (string)
  - "selection": the specific pick. CRITICAL FOR PLAYER PROPS: In Sportsbet's SGM layout, player props show as a player name heading (e.g. "Isaac Heeney") followed by indented stat lines (e.g. "2+ Goals", "20+ Disposals"). Each stat line is a separate leg. The "selection" for each stat leg MUST include the player name — e.g. "Isaac Heeney 2+ Goals", "Isaac Heeney 20+ Disposals". NEVER use just "2+ Goals" alone as the selection — always prepend the player name.
  - "odds": decimal odds for this leg as a number — use null if this leg is part of an SGM group (SGM sub-legs have no individual odds)
  - "leg_group": integer (1, 2, 3…) if this leg belongs to an SGM within the multi, otherwise null. All sub-legs of the same SGM share the same leg_group number.
  - "group_odds": the combined decimal odds of the SGM group (e.g. 3.20) — include on every leg that has a leg_group. Null for standalone legs.
  - "outcome": the result of this leg if visible — one of "won", "lost", "void". Omit or use "pending" if the leg has not yet been resolved.

  Example for a multi containing an SGM @ 3.20 (Essendon v Melbourne, with two player props) plus a standalone horse race @ 1.40:
  [
    { "sport": "AFL", "event_time": "${currentYear}-04-11T19:35", "event": "Essendon v Melbourne", "description": "Pick Your Line", "selection": "Essendon (+40.5)", "odds": null, "leg_group": 1, "group_odds": 3.20 },
    { "sport": "AFL", "event_time": "${currentYear}-04-11T19:35", "event": "Essendon v Melbourne", "description": "Player Goals", "selection": "Kysaiah Pickett 2+ Goals", "odds": null, "leg_group": 1, "group_odds": 3.20 },
    { "sport": "AFL", "event_time": "${currentYear}-04-11T19:35", "event": "Essendon v Melbourne", "description": "Player Disposals", "selection": "Kysaiah Pickett 20+ Disposals", "odds": null, "leg_group": 1, "group_odds": 3.20 },
    { "sport": "Horse Racing", "event_time": "${currentYear}-04-11T13:15", "event": "4. Amazake (9) — Caulfield Race 7", "description": "Place", "selection": "4. Amazake (9)", "odds": 1.40, "leg_group": null, "group_odds": null }
  ]
  Note how BOTH player prop legs include the player name "Kysaiah Pickett" in the selection field — never just "2+ Goals" or "20+ Disposals" alone.

- "outcome": the overall result of the bet if visible — one of "won", "lost", "void". Omit or use "pending" if not yet resolved.
- "is_bonus_bet": true if this bet was placed using a free/bonus bet (look for labels like "Bonus Bet", "Free Bet", "Bet Credits", stake shown as bonus/free rather than real money). Omit or set false if it's a normal cash bet.
- "bet_return_text": if the bet slip shows a "Bet Return" or "Money Back" promotion attached to this bet (e.g. "Any leg fails, get a $50.00 Bonus Bet"), extract the full description as a string. Omit if not present.
- "bet_return_value": the dollar value of the bet return offer as a number (e.g. 50.00). Omit if no bet return is shown.

Rules:
- Only include a field if you can clearly read it from the screenshot${multipleScreenshots ? 's' : ''}
- If a value is unclear or not visible in any screenshot, omit that field entirely
- Return ONLY the raw JSON object — no markdown, no code blocks, no explanation

IMPORTANT — Sportsbet Power Price:
On Sportsbet, a "Power Price" bet shows TWO odds numbers next to the bet type, e.g. "Multi @ 72.00 58.40 ⚡" or "@ 3.20 2.80 ⚡". In this format:
- The FIRST number (e.g. 72.00) is the boosted/current odds — use this as "odds"
- The SECOND number (e.g. 58.40) is the original base price — ignore it completely
- Neither number is the stake. The stake is a separate dollar amount shown elsewhere on the slip (e.g. "Stake: $10.00" or "You Bet: $10.00"). If no stake is clearly labelled, omit the "stake" field entirely.`

  // Build content array: all images first, then the prompt text
  const content = [
    ...imageList.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.imageBase64 },
    })),
    { type: 'text', text: prompt },
  ]

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content }],
      }),
    })

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}))
      throw new Error(errBody?.error?.message || `Anthropic API returned ${response.status}`)
    }

    const result = await response.json()
    logUsage({ endpoint: 'extract-bet', userId, model: 'claude-sonnet-4-6', usage: result.usage, imageCount: imageList.length })
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
