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

### 🚨 Result-checking cron is intentionally OFF

`vercel.json` only has the weekly-multi creation cron (`/api/create-weekly-multi`, Sunday 8pm UTC). The result-checking cron (`/api/check-results`) was disabled because it cost ~$6 per run on busy weekends.

**Do not re-enable it** without user approval. Manual checks via the app UI are fine.

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

The API-Sports Rugby API is **rugby union only**. NRL is rugby league — different sport. Confirmed from user's API-Sports account. NRL bets fall through to Claude web search until the in-house NRL collector is built (see BUILD_NOTES.md).

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

## Active project: in-house result resolvers

The next major build is replacing Claude-based result checking with in-house data collectors + deterministic resolvers for AFL and NRL. **See `BUILD_NOTES.md` at the repo root for the full plan.**

If the user opens a session about cost reduction, result checking, AFL/NRL data, Squiggle, or anything in that orbit — read BUILD_NOTES.md first.

---

## Recent significant work (uncommitted as of last session)

These files have changes that are not yet committed:

- `api/_lib/apiSports.js` (new) — shared API-Sports client for AFL/NBA/NBL/Basketball/Soccer/NFL/NCAAF
- `api/check-results.js` — wired API-Sports into both check paths
- `api/check-weekly-results.js` — same
- `api/test-api-sports.js` — health check + game-list diagnostic
- `vercel.json` — SPA rewrite changed from `/(.*)` to `/((?!api/).*)` so `/api/*` routes correctly

These will be partially superseded by the BUILD_NOTES.md project. Discuss with user whether to commit as a checkpoint or merge with the upcoming build.
