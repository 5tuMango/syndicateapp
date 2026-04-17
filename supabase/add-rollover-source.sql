-- Rollover intent and source tracking
alter table public.bets
  add column if not exists intend_to_rollover boolean default false,
  add column if not exists rollover_source_id uuid references public.bets(id) on delete set null;
