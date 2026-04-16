-- Stage 3: Add persona_id to bets
-- Run this in the Supabase SQL editor

alter table public.bets
  add column if not exists persona_id uuid references public.personas(id) on delete set null;
