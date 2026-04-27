-- Phase 1: In-house sport data tables
-- Run in Supabase SQL editor (Dashboard → SQL Editor → New query)

-- Match-level data (H2H, handicap, total, margin, HT/FT, quarter markets)
create table if not exists sport_games (
  id uuid primary key default gen_random_uuid(),
  source text not null,                 -- 'squiggle' | 'nrl.com' | 'api-sports' | 'afltables'
  sport text not null,                  -- 'AFL' | 'NRL' | 'NBA' | etc.
  game_date date not null,
  kickoff_at timestamptz,
  home text not null,
  away text not null,
  home_score int,
  away_score int,
  ht_home int,
  ht_away int,
  q1_home int, q1_away int,
  q2_home int, q2_away int,
  q3_home int, q3_away int,
  q4_home int, q4_away int,
  status text not null,                 -- 'upcoming' | 'in_progress' | 'final' | 'postponed'
  raw jsonb,
  fetched_at timestamptz default now(),
  unique(source, sport, game_date, home, away)
);

create index if not exists sport_games_sport_date_idx on sport_games(sport, game_date);

-- Player-level stats (all player props)
create table if not exists sport_player_stats (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references sport_games(id) on delete cascade,
  player_name text not null,
  player_name_normalised text not null, -- lowercase, no punctuation, for fuzzy matching
  team text,
  -- AFL
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
  -- NRL
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

create index if not exists sport_player_stats_name_idx on sport_player_stats(player_name_normalised);
create index if not exists sport_player_stats_game_idx on sport_player_stats(game_id);

-- RLS
alter table sport_games enable row level security;
alter table sport_player_stats enable row level security;

-- authenticated users: read only
create policy "sport_games_read" on sport_games
  for select to authenticated using (true);

create policy "sport_player_stats_read" on sport_player_stats
  for select to authenticated using (true);

-- service_role has full access by default (no policy needed — it bypasses RLS)
