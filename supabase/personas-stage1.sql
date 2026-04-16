-- Stage 1: Personas table
-- Run this in the Supabase SQL editor

-- ── 1. Create personas table ─────────────────────────────────────────────────
create table if not exists public.personas (
  id          uuid        primary key default gen_random_uuid(),
  nickname    text        not null unique,
  emoji       text        not null,
  claimed_by  uuid        references auth.users(id) on delete set null,
  created_at  timestamptz default now()
);

alter table public.personas enable row level security;

-- All authenticated users can read personas (needed for claim screen in Stage 2)
create policy "personas_select"
  on public.personas for select
  to authenticated
  using (true);

-- Admin can insert, update, delete
create policy "personas_admin"
  on public.personas for all
  to authenticated
  using (
    exists (select 1 from public.profiles where id = auth.uid() and is_admin = true)
  )
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and is_admin = true)
  );

-- ── 2. Seed the 8 personas ───────────────────────────────────────────────────
insert into public.personas (nickname, emoji) values
  ('Doctor',   '👱‍♀️'),
  ('Coiny',    '🪙'),
  ('Yoda',     '👽'),
  ('Santa',    '👲'),
  ('Mango',    '🥭'),
  ('Crockett', '🦎'),
  ('Blob',     '🦞'),
  ('Spud',     '🥔')
on conflict (nickname) do nothing;
