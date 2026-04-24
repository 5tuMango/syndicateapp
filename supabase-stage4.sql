-- ─────────────────────────────────────────────────────────────────────────────
-- Stage 4 Migration — Teams, Admin, Weekly Multis, Notifications
-- Run this entire file in the Supabase SQL editor
-- ─────────────────────────────────────────────────────────────────────────────

-- STEP 1: Add columns to profiles FIRST (policies below reference these)
alter table public.profiles add column if not exists is_admin boolean default false;

-- STEP 2: Teams table (policy references profiles.is_admin — must exist first)
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text default 'blue',
  created_at timestamptz default now()
);
alter table public.teams enable row level security;
create policy "Teams readable by all" on public.teams for select using (true);
create policy "Admins manage teams" on public.teams for all using (
  exists (select 1 from public.profiles where id = auth.uid() and is_admin = true)
);

-- STEP 3: Add team_id to profiles (references teams — must exist first)
alter table public.profiles add column if not exists team_id uuid references public.teams(id);

-- Allow admins to update any profile (needed for team assignment)
create policy "Admins update any profile" on public.profiles for update using (
  exists (select 1 from public.profiles where id = auth.uid() and is_admin = true)
);

-- STEP 4: Weekly multis
create table public.weekly_multis (
  id uuid primary key default gen_random_uuid(),
  week_label text not null,
  status text default 'open' check (status in ('open', 'resulted')),
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);
alter table public.weekly_multis enable row level security;
create policy "Weekly multis readable by all" on public.weekly_multis for select using (true);
create policy "Admins manage weekly multis" on public.weekly_multis for all using (
  exists (select 1 from public.profiles where id = auth.uid() and is_admin = true)
);

-- STEP 5: Weekly multi legs
create table public.weekly_multi_legs (
  id uuid primary key default gen_random_uuid(),
  weekly_multi_id uuid references public.weekly_multis(id) on delete cascade,
  assigned_user_id uuid references public.profiles(id),
  assigned_name text,
  event text,
  description text,
  selection text,
  odds numeric,
  outcome text default 'pending' check (outcome in ('pending', 'won', 'lost', 'void')),
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.weekly_multi_legs enable row level security;
create policy "Legs readable by all" on public.weekly_multi_legs for select using (true);
create policy "Admins manage all legs" on public.weekly_multi_legs for all using (
  exists (select 1 from public.profiles where id = auth.uid() and is_admin = true)
);
create policy "Members update own leg" on public.weekly_multi_legs for update using (
  assigned_user_id = auth.uid()
) with check (assigned_user_id = auth.uid());

-- STEP 6: Notifications
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  title text not null,
  body text,
  read boolean default false,
  link text,
  created_at timestamptz default now()
);
alter table public.notifications enable row level security;
create policy "Users read own notifications" on public.notifications for select using (auth.uid() = user_id);
create policy "Admins insert notifications" on public.notifications for insert with check (
  exists (select 1 from public.profiles where id = auth.uid() and is_admin = true)
);
create policy "Users mark own read" on public.notifications for update using (auth.uid() = user_id);

-- STEP 7: Insert 2 starter teams
insert into public.teams (name, color) values
  ('Team Syndicate', 'blue'),
  ('Team Punt', 'purple');

-- ─────────────────────────────────────────────────────────────────────────────
-- TO SET YOURSELF AS ADMIN, run this separately after the above succeeds:
-- select id, email from auth.users;
-- update public.profiles set is_admin = true where id = 'YOUR_USER_ID_HERE';
-- ─────────────────────────────────────────────────────────────────────────────
