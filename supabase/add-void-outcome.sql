-- ============================================================
-- Add 'void' as a valid outcome for bets and bet_legs
-- Run in Supabase SQL Editor
-- ============================================================

-- Bets table
alter table public.bets
  drop constraint if exists bets_outcome_check;

alter table public.bets
  add constraint bets_outcome_check
  check (outcome in ('pending', 'won', 'lost', 'void'));

-- Bet legs table
alter table public.bet_legs
  drop constraint if exists bet_legs_outcome_check;

alter table public.bet_legs
  add constraint bet_legs_outcome_check
  check (outcome in ('pending', 'won', 'lost', 'void'));
