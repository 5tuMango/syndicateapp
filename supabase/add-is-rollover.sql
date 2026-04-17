-- Rollover bets: stake funded from previous winnings, excluded from real capital stats
alter table public.bets
  add column if not exists is_rollover boolean default false;
