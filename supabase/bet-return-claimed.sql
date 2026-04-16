-- Mark a bet return as claimed/used
-- Run this in the Supabase SQL editor

alter table public.bets
  add column if not exists bet_return_claimed boolean default false;
