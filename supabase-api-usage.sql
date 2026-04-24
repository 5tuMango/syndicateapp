-- ─────────────────────────────────────────────────────────────────────────────
-- API usage log — tracks every Claude API call with token + cost info.
-- Admins see this in /admin/usage. Only service role writes it (from /api/*).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.api_usage (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  endpoint text not null,
  user_id uuid references auth.users(id) on delete set null,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0,
  image_count integer not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  success boolean not null default true,
  note text
);

create index if not exists api_usage_created_at_idx on public.api_usage (created_at desc);
create index if not exists api_usage_endpoint_idx on public.api_usage (endpoint);
create index if not exists api_usage_user_id_idx on public.api_usage (user_id);

alter table public.api_usage enable row level security;

-- Admins can read everything
drop policy if exists "api_usage_admin_select" on public.api_usage;
create policy "api_usage_admin_select" on public.api_usage
  for select using (
    exists (select 1 from public.profiles where id = auth.uid() and is_admin = true)
  );

-- Inserts come only from the service role (used by /api routes) — no client insert policy needed.
