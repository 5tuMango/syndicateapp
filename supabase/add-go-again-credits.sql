-- Go-Again credits: each winning bet of $250+ by an active-team member
-- earns the punter another $50 of betting allowance. Credits roll forward
-- indefinitely until consumed by stakes in a future active week.
-- Run this in the Supabase SQL editor.

create table if not exists public.go_again_credits (
  id               uuid          primary key default gen_random_uuid(),
  persona_id       uuid          not null references public.personas(id) on delete cascade,
  source_bet_id    uuid          not null references public.bets(id) on delete cascade,
  source_winnings  numeric(10,2),
  earned_at        timestamptz   default now(),
  used_at          timestamptz,
  used_in_week_start date,
  unique (source_bet_id)
);

create index if not exists go_again_credits_persona_idx
  on public.go_again_credits (persona_id, used_at);

-- RLS: anyone authenticated can read; only service role writes (dashboard
-- uses the anon key for select, mutations go via authenticated session).
alter table public.go_again_credits enable row level security;

drop policy if exists "go_again_credits_select" on public.go_again_credits;
create policy "go_again_credits_select"
  on public.go_again_credits for select
  using (auth.role() = 'authenticated');

drop policy if exists "go_again_credits_insert" on public.go_again_credits;
create policy "go_again_credits_insert"
  on public.go_again_credits for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "go_again_credits_update" on public.go_again_credits;
create policy "go_again_credits_update"
  on public.go_again_credits for update
  using (auth.role() = 'authenticated');
