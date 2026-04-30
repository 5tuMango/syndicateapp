# Syndicate — Project Context for Claude

A hobby bet-tracking app for a small group of mates. Members upload Sportsbet slips, the app extracts legs via Claude vision, tracks results, and runs a weekly group multi.

**Project value: cost-consciousness.** This is a hobby app. Long-term Claude API spend should trend toward zero. Always prefer free/in-house data over paid APIs or LLM calls when feasible.

---

## Tech stack

- **Frontend:** React + Vite, Tailwind, deployed on Vercel
- **Backend:** Vercel serverless functions in `/api` (ESM)
- **DB:** Supabase (Postgres + RLS + auth)
- **AI:** Anthropic API — Claude Sonnet 4.6 for extraction, Haiku 4.5 for cheap web-search lookups

---

## Key directories

```
api/                  Vercel serverless functions (one file = one endpoint)
api/_lib/             Shared helpers (logUsage, apiSports)
src/pages/            React pages (AddBet, WeeklyMulti, AdminUsage, etc.)
src/utils/            Frontend utilities (resizeImage, etc.)
supabase/             Migration SQL files
BUILD_NOTES.md        Plan for upcoming in-house resolver project — READ THIS if working on result checking
```

---

## Critical context — read before changing anything

### 🚨 Claude API is OFF for sport result checking — until further notice

To eliminate ongoing Claude spend on result checks, the project uses **in-house resolvers** for AFL and NRL (Squiggle / NRL.com / AFL.com.au — see BUILD_NOTES.md). Claude is **not** to be re-enabled for sport result checking without explicit user approval.

Current behaviour:
- `check-results.js` → `checkSingleLeg`: runs `resolveLeg` (in-house). If unresolved, returns `pending`. Claude is unreachable here.
- `check-results.js` → `checkBetResult` (single-bet path): **still has Claude fallback** — gate this if you want truly zero Claude.
- `check-weekly-results.js` → `checkSingleLeg`: **still has Claude fallback** — same.

If a leg can't be resolved in-house it should **stay pending** and be flagged for manual review, not handed to Claude.

### Result-checking cron is back ON

After the in-house resolver was built, result checking is live again. Schedule split:

**Vercel crons** (Hobby plan caps at 1/day per cron — do NOT add sub-daily schedules here, deploy will fail):
- `/api/collect-afl-games` — daily at 14:00 UTC
- `/api/collect-afl-stats` — daily at 15:00 UTC
- `/api/collect-nrl-games` — daily at 14:30 UTC
- `/api/collect-nrl-stats` — daily at 15:30 UTC

**External (cronjob.org)** — used for anything more frequent than daily:
- `/api/check-results` — every 30 min Thu–Sun (NRL/AFL match days). Managed in cronjob.org dashboard, NOT in `vercel.json`.

These should not regress to using Claude. If `logUsage` shows new `check-results` Anthropic calls appearing, something's gone wrong — investigate before disabling the cron.

The check-results cron only retries pending bets in the **3–9 hour window after kickoff** (`isOutsideWindow` in check-results.js). Bets older than 9h need manual review.

### 🚨 Cost monitoring is wired up

Every Anthropic call goes through `api/_lib/logUsage.js` which writes to the `api_usage` Supabase table. The `/admin/usage` page shows totals by endpoint + user. If you add a new Claude call, log it.

### 🚨 Sport labels must match exactly

Result-checking and the in-house resolvers (when built) match on the `sport` field. Canonical values:
- `AFL` `NRL` `NBA` `NBL` `Basketball` `Soccer` `NFL` `NCAAF` `Horse Racing` `Tennis` `MMA` `F1`

When editing extract-bet prompts, keep these exact strings — anything else falls through to Claude web search.

### 🚨 Time handling is a known footgun

Stored `event_time` strings are naive `YYYY-MM-DDTHH:MM` meant as **AEST (UTC+10)**. Never round-trip through `new Date()` + `.toISOString()` — that does a silent -10hr shift on dates without offsets, which previously caused the "19:40 → 9:40" bug.

When parsing for comparisons, append the offset explicitly:
```js
Date.parse(s + ':00+10:00')
```

When manipulating year strings (e.g. fixing stale years from AI extraction), use pure string replacement, never Date arithmetic.

### 🚨 NRL is NOT in API-Sports

The API-Sports Rugby API is **rugby union only**. NRL is rugby league — different sport. NRL data comes from the in-house NRL.com collectors (`collect-nrl-games.js`, `collect-nrl-stats.js`).

---

## Conventions

- **No emojis in code** unless explicitly requested
- **Comments explain *why*, not *what*** — short, focused, only where the reasoning isn't obvious
- **Fire-and-forget logging** — `logUsage()` should never block the response
- **Supabase service key only used server-side** (never expose `SUPABASE_SERVICE_KEY` to the frontend; frontend uses anon key + RLS)
- **Image uploads** are client-side resized to 1568px JPEG via `src/utils/resizeImage.js` before being sent to Claude (saves vision token cost)

---

## Environment variables

Set in Vercel for Production + Preview:

| Var | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | All Claude calls |
| `VITE_SUPABASE_URL` | Frontend + backend |
| `VITE_SUPABASE_ANON_KEY` | Frontend |
| `SUPABASE_SERVICE_KEY` | Backend writes (logUsage, cron jobs) |
| `API_SPORTS_KEY` | API-Sports integration (currently best-guess field paths) |
| `ADMIN_TEST_SECRET` | Diagnostic endpoints (e.g. `/api/test-api-sports?key=…`) |
| `CRON_SECRET` | Cron auth header |

---

## In-house resolver (built and live)

Result checking for AFL and NRL goes through the in-house resolver instead of Claude. Key files:

- `api/_lib/classifyMarket.js` — market type classifier (regex/keyword)
- `api/_lib/resolveLeg.js` — orchestrator: classify → look up game/stats → resolve
- `api/_lib/apiSports.js` — shared API-Sports client (kept for non-AU sports)
- `api/collect-afl-games.js` — Squiggle collector → `sport_games`
- `api/collect-afl-stats.js` — AFL.com.au match centre → `sport_player_stats`
- `api/collect-nrl-games.js` — NRL.com draw collector
- `api/collect-nrl-stats.js` — NRL.com match centre collector
- `scripts/test-api-sports.js` — POST mode runs legs through `resolveLeg` for backfill regression testing. Lives outside `/api/` to keep us under Vercel Hobby's 12-function limit; run locally via `vercel dev` if needed

DB tables: `sport_games`, `sport_player_stats`. See migration files under `supabase/`.

**`BUILD_NOTES.md`** has the original plan, architecture, and rationale — read it if working on the resolver, collectors, or extending to new sports.
