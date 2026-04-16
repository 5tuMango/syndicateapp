-- Stage 5: Add persona_id to weekly_multi_legs
-- Run this in the Supabase SQL editor

alter table public.weekly_multi_legs
  add column if not exists persona_id uuid references public.personas(id) on delete set null;
