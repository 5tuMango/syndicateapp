-- ============================================================
-- The Syndicate — Supabase Schema
-- Run this entire file in the Supabase SQL Editor
-- Safe to re-run: drops everything first
-- ============================================================

-- ── Clean slate ──────────────────────────────────────────────
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists public.bet_legs cascade;
drop table if exists public.bets cascade;
drop table if exists public.profiles cascade;

-- ── Profiles ────────────────────────────────────────────────
-- Extends auth.users; auto-created via trigger on sign-up.

create table public.profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  username    text        unique not null,
  full_name   text,
  updated_at  timestamptz default now()
);

-- ── Bets ────────────────────────────────────────────────────

create table public.bets (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  date       date        not null,
  sport      text        not null,
  event      text        not null,
  bet_type   text        not null check (bet_type in ('single', 'multi')),
  odds       numeric(10,2) not null check (odds > 1),
  stake      numeric(10,2) not null check (stake > 0),
  outcome    text        not null default 'pending'
                         check (outcome in ('pending', 'won', 'lost')),
  notes      text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── Bet Legs ─────────────────────────────────────────────────
-- Individual selections within a multi bet.

create table public.bet_legs (
  id          uuid        primary key default gen_random_uuid(),
  bet_id      uuid        not null references public.bets(id) on delete cascade,
  event       text        not null,
  description text,
  odds        numeric(10,2) not null check (odds > 1),
  outcome     text        not null default 'pending'
                          check (outcome in ('pending', 'won', 'lost')),
  sort_order  integer     not null default 0,
  created_at  timestamptz default now()
);

-- ── Row Level Security ───────────────────────────────────────

alter table public.profiles  enable row level security;
alter table public.bets      enable row level security;
alter table public.bet_legs  enable row level security;

-- profiles: all authenticated users can read; only own row can be written
create policy "profiles_select" on public.profiles
  for select to authenticated using (true);

create policy "profiles_insert" on public.profiles
  for insert with check (auth.uid() = id);

create policy "profiles_update" on public.profiles
  for update using (auth.uid() = id);

-- bets: all authenticated users can read all bets (group app)
create policy "bets_select" on public.bets
  for select to authenticated using (true);

create policy "bets_insert" on public.bets
  for insert with check (auth.uid() = user_id);

create policy "bets_update" on public.bets
  for update using (auth.uid() = user_id);

create policy "bets_delete" on public.bets
  for delete using (auth.uid() = user_id);

-- bet_legs: readable by all; writable only if you own the parent bet
create policy "bet_legs_select" on public.bet_legs
  for select to authenticated using (true);

create policy "bet_legs_insert" on public.bet_legs
  for insert with check (
    auth.uid() = (select user_id from public.bets where id = bet_id)
  );

create policy "bet_legs_update" on public.bet_legs
  for update using (
    auth.uid() = (select user_id from public.bets where id = bet_id)
  );

create policy "bet_legs_delete" on public.bet_legs
  for delete using (
    auth.uid() = (select user_id from public.bets where id = bet_id)
  );

-- ── Auto-create Profile on Sign-up ──────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, full_name)
  values (
    new.id,
    -- use provided username meta, else derive from email
    coalesce(
      new.raw_user_meta_data->>'username',
      split_part(new.email, '@', 1)
    ),
    coalesce(
      new.raw_user_meta_data->>'full_name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
