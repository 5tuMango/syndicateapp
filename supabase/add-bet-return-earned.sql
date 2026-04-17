-- Track whether a bet return was actually earned based on its terms
alter table public.bets
  add column if not exists bet_return_earned boolean default null;
