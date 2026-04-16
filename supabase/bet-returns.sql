-- Bonus bets and bet returns
-- Run this in the Supabase SQL editor

alter table public.bets
  add column if not exists is_bonus_bet boolean default false,
  add column if not exists bet_return_text text,      -- e.g. "Any leg fails → $50 bonus bet"
  add column if not exists bet_return_value numeric;  -- dollar value of the return offer
