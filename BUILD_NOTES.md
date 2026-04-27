# Build Notes — In-House Sports Data + Resolver System

> **Purpose:** Eliminate ongoing Claude API costs for AFL and NRL result checking. The Syndicate app is a hobby project; long-term cost target is **$0/month** for result resolution.
>
> **Status:** Plan agreed, not yet started. API-Sports work from a previous session is sitting uncommitted (see "Current state" below) and will be partially superseded by this build.
>
> **How to use this doc:** Open a new Claude Code conversation, say *"read BUILD_NOTES.md and let's start phase 1"*. Each phase is independently shippable.

---

## 1. Goal

For every AFL or NRL bet leg, resolve the outcome **without calling Claude** unless absolutely necessary. Claude becomes a "break glass" fallback for genuinely fuzzy markets, not the default engine.

Concrete target: **>95% of AFL/NRL legs resolved for $0**. Remaining ≤5% either flagged for manual review or sent to Claude as a last resort.

---

## 2. Why we're not just using API-Sports

API-Sports was wired up in a previous session (uncommitted changes). Two problems:

1. **API-Sports Rugby API is rugby union only** — does not cover NRL (rugby league). Confirmed by the user from their API-Sports account. Wave 1 fix already removed NRL from the API-Sports endpoint map.
2. **Even where it works (AFL, NBA, soccer, NFL), it's match-level only** — no player stats, which is the bulk of bet legs. Player props would still need Claude.

Decision: skip API-Sports for AFL/NRL entirely. Use free public Australian sources instead. Keep the API-Sports lib around for NBA/soccer/NFL where Australian sources don't exist.

---

## 3. Data sources (the foundation)

### AFL
| Layer | Source | URL pattern | Notes |
|---|---|---|---|
| Games + scores | **Squiggle** | `https://api.squiggle.com.au/?q=games;year=YYYY;round=N` | Free, public, hobbyist API. Polite User-Agent expected. Quarter scores included. Goes back to 1897. |
| Player stats | **AFL.com.au match centre** | TBD — needs DevTools discovery | Goals, behinds, disposals, kicks, handballs, marks, tackles, hitouts, clearances, contested possessions, inside 50s, fantasy points |
| Backup / historical | **afltables.com** | Scrape (cheerio) | Defensive — only used if AFL.com.au gaps a game |

### NRL
| Layer | Source | URL pattern | Notes |
|---|---|---|---|
| Games + scores | **NRL.com draw JSON** | `https://www.nrl.com/draw/data?competition=111&season=YYYY&round=N` | Public JSON endpoint that powers nrl.com. Confirm exact URL via DevTools. |
| Player stats | **NRL.com match centre** | TBD — needs DevTools discovery | Try scorers, goal kickers, tackles, runs, run metres, line breaks, etc. |
| Backup | None planned initially | | Add later if NRL.com proves unreliable |

### Other sports (not in scope for this build)
- NBA, A-League/EPL soccer, NFL → keep using API-Sports (already wired)
- Horse racing, tennis, MMA, F1, NBL → keep using Claude until volume justifies more work

---

## 4. Database schema

Two new tables, both in Supabase (same project as everything else).

```sql
-- Match-level data (covers H2H, handicap, total, margin, HT/FT, quarter markets)
create table sport_games (
  id uuid primary key default gen_random_uuid(),
  source text not null,                    -- 'squiggle' | 'nrl.com' | 'api-sports' | 'afltables'
  sport text not null,                     -- 'AFL' | 'NRL' | 'NBA' | etc.
  game_date date not null,
  kickoff_at timestamptz,
  home text not null,
  away text not null,
  home_score int,
  away_score int,
  ht_home int,                             -- half-time scores
  ht_away int,
  q1_home int, q1_away int,                -- quarter-by-quarter (AFL only)
  q2_home int, q2_away int,
  q3_home int, q3_away int,
  q4_home int, q4_away int,
  status text not null,                    -- 'upcoming' | 'in_progress' | 'final' | 'postponed'
  raw jsonb,                               -- full source payload for debugging
  fetched_at timestamptz default now(),
  unique(source, sport, game_date, home, away)
);

create index on sport_games(sport, game_date);

-- Player-level stats (covers all player props)
create table sport_player_stats (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references sport_games(id) on delete cascade,
  player_name text not null,
  player_name_normalised text not null,    -- lowercase, no punctuation, for fuzzy matching
  team text,
  -- AFL stats
  goals int default 0,
  behinds int default 0,
  disposals int default 0,
  kicks int default 0,
  handballs int default 0,
  marks int default 0,
  tackles int default 0,
  hitouts int default 0,
  clearances int default 0,
  contested_possessions int default 0,
  inside_50s int default 0,
  goal_assists int default 0,
  fantasy_points int,
  -- NRL stats
  tries int default 0,
  try_assists int default 0,
  line_breaks int default 0,
  tackle_breaks int default 0,
  run_metres int default 0,
  offloads int default 0,
  raw jsonb,
  fetched_at timestamptz default now(),
  unique(game_id, player_name_normalised)
);

create index on sport_player_stats(player_name_normalised);
create index on sport_player_stats(game_id);
```

RLS: read-only for `authenticated`, full access for `service_role`. Admin-only writes via Vercel functions using `SUPABASE_SERVICE_KEY`.

---

## 5. Resolver architecture

```
api/
  _lib/
    sources/
      squiggle.js          ← AFL game collector
      aflMatchCentre.js    ← AFL player stats collector
      nrl.js               ← NRL game + player collector
      apiSports.js         ← KEEP (NBA/soccer/NFL fallback)
    resolvers/
      h2h.js               ← team X to win
      handicap.js          ← team X +/- N points
      total.js             ← over/under total points
      margin.js            ← exact margin / Big Win Little Win / margin buckets
      htft.js              ← half-time / full-time double
      quarterWinner.js     ← AFL quarter markets
      goalScorer.js        ← AFL anytime/first/N+ goals
      tryScorer.js         ← NRL anytime/first/N+ tries
      playerStat.js        ← X+ disposals / tackles / runs / etc.
    classifyMarket.js      ← regex → resolver name
    nameMatch.js           ← exact → last-name → initial+last → Levenshtein
    resolveLeg.js          ← orchestrator: classify → look up game → look up stats → resolve
  collect-afl-games.js     ← cron, every 2hr Thu–Mon during season
  collect-afl-stats.js     ← cron, every 2hr Thu–Mon during season
  collect-nrl-games.js     ← cron
  collect-nrl-stats.js     ← cron
```

### Market classifier
Regex/keyword based. Examples:
- `/\bdisposals?\b/i` + `/\b(\d+)\+?\b/` → `playerStat:disposals`
- `/anytime (try|tryscorer)/i` → `tryScorer:anytime`
- `/big win|little win/i` → `margin:bigWinLittleWin`
- `/winning margin (\d+)-(\d+)/i` → `margin:bucket`

### Name matching strategy (in order)
1. Exact case-insensitive match on `player_name_normalised`
2. Last-name match if unique within the game
3. Initial + last-name match (e.g. "C. Petracca")
4. Levenshtein distance ≤ 2 (catches OCR typos)
5. Multiple matches → return `needs_review` (do not guess)

---

## 6. Polling schedule

Cron should not fire blindly every 2 hours. Smart schedule per leg:
- First check: `event_time + 3 hours` (gives game time to actually finish)
- Retries: every 1 hour after that
- Stop after 6 attempts (~9 hours after kickoff)
- Beyond that → flag for manual review

**Implementation choice (decide at phase 8):**
- Lightweight: query `event_time + 3h <= now() AND event_time + 9h >= now()` in cron — no schema change
- Proper: add `next_check_at` + `check_attempts` columns to `bet_legs` and `weekly_multi_legs`

Recommendation: lightweight first. Upgrade only if logs show waste.

---

## 7. Build phases (in order)

Each phase is independently shippable. Stop at any phase and the previous ones still work.

| # | Phase | Hands-off? | What user provides |
|---|---|---|---|
| 1 | Schema migrations | ❌ | Paste SQL into Supabase SQL editor |
| 2 | Name matcher utility (`nameMatch.js`) | ✅ | Nothing |
| 3 | Squiggle AFL game collector + cron | Mostly ✅ | Deploy + verify a real game appears in `sport_games` |
| 4 | Core resolvers (`h2h`, `total`, `margin`) | ✅ | Nothing |
| 5 | Wire `resolveLeg` into `checkSingleLeg` (AFL only path) | ✅ | Nothing |
| 6 | AFL.com.au player stats collector | ❌ | Open afl.com.au match centre in Chrome → DevTools → Network → find the JSON request → paste URL + sample response |
| 7 | `playerStat` + `goalScorer` resolvers | ✅ | Nothing |
| 8 | Polling schedule (lightweight) | ✅ | Nothing |
| 9 | NRL.com game collector | ❌ | Same DevTools discovery for nrl.com |
| 10 | NRL.com player stats collector | ❌ | Same DevTools discovery for match centre |
| 11 | NRL resolvers (`tryScorer`, `playerStat` extended) | ✅ | Nothing |
| 12 | Edge resolvers (`htft`, `quarterWinner`) | ✅ | Nothing |
| 13 | Backfill regression test | Mixed | User reviews 5–10 historical bets to confirm resolver agrees with recorded outcomes |
| 14 | Re-enable cron | ❌ | User decision |

**Realistic timing:** ~20–25 hours of focused build time, ~2–3 hours of user time spread across short check-ins. Calendar time depends on user availability — could be one long weekend or a couple of weeks of evenings.

---

## 8. Current state (uncommitted from previous session)

These files were modified in a previous session and **are not yet committed**:

- `api/_lib/apiSports.js` — NEW. Shared client for AFL/NBA/NBL/Basketball/Soccer/NFL/NCAAF. Will be kept for non-AU sports but **NOT** used for AFL once Squiggle collector is live.
- `api/check-results.js` — Wired API-Sports into both `checkSingleLeg` and `checkBetResult`. Will need re-wiring to call `resolveLeg` (in-house) before falling back to API-Sports/Claude.
- `api/check-weekly-results.js` — Same.
- `api/test-api-sports.js` — Health check + game-list diagnostic. Keep as-is.
- `vercel.json` — SPA rewrite changed to `/((?!api/).*)` so `/api/*` actually routes. Keep.

**The result-checking cron is currently OFF** in `vercel.json` (only the weekly-multi creation cron remains). Do not turn it back on until phase 14.

**Field paths in `apiSports.js` are best-guess** because the API-Sports docs returned 403 to WebFetch. If we end up using it for NBA/soccer/NFL, those paths will need verification against real responses (the test endpoint can probe this).

**Decision needed at start of phase 1:** commit the existing API-Sports work first (so it's preserved), or leave uncommitted and let it merge with phase 5? Recommend: commit first as a clean checkpoint.

---

## 9. Decisions already made (don't relitigate)

- **NRL is NOT in API-Sports** — the rugby API is union only. Confirmed by user.
- **AFL primary source: Squiggle** — not API-Sports, not afl.com.au. Squiggle is purpose-built for hobbyists, free, no rate limits in practice.
- **Player stats fall back to Claude only when name matching fails** — never silently guess on ambiguous matches.
- **Polling: lightweight first** (query-based), upgrade to schema-based only if needed.
- **Sport labels** must match exactly: `AFL`, `NRL`, `NBA`, `NBL`, `Basketball`, `Soccer`, `NFL`, `NCAAF`. Bet extraction (`extract-bet.js`) writes these — keep them consistent.
- **Cron stays OFF** until phase 14 verification passes. Manual checks via app UI are fine in the meantime.

---

## 10. Open questions for next session

- Exact AFL.com.au match centre JSON endpoint URL + response shape (DevTools task)
- Exact NRL.com draw + match centre JSON endpoint URLs + response shapes (DevTools task)
- A-League / EPL match-level data: stick with API-Sports or find a free source? (defer until non-AFL/NRL becomes a meaningful cost)
- How to handle player name aliases over time (e.g. trades, hyphenated names) — punt on this until first real failure

---

## 11. Reference: cost economics

For context on why this is worth building:

| Approach | Per-week cost (busy weekend) | Notes |
|---|---|---|
| Pure Claude web search (the original setup) | ~$120/wk | What blew up to $21/day at peak |
| Claude on Haiku + iteration caps | ~$30/wk | What we have now (cron off) |
| API-Sports tier 1 (current uncommitted state) | ~$10/wk | Saves the score-finding tokens but Claude still in loop |
| **In-house resolvers (this build)** | **~$0/wk** | Claude only on `needs_review` flagged legs |

Squiggle, NRL.com, AFL.com.au are all free. Vercel function execution stays well within the free tier. Supabase storage for a full season is single-digit MB.
