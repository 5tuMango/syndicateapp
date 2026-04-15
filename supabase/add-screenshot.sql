-- ============================================================
-- Stage 2 migration — run in Supabase SQL Editor
-- Adds screenshot_url column + sets up Storage bucket
-- ============================================================

-- 1. Add screenshot_url column to bets table
alter table public.bets
  add column if not exists screenshot_url text;

-- 2. Create the storage bucket for bet screenshots
insert into storage.buckets (id, name, public)
values ('bet-screenshots', 'bet-screenshots', true)
on conflict (id) do nothing;

-- 3. Storage policies

-- Authenticated users can upload files into their own folder
create policy "Users can upload own screenshots"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'bet-screenshots'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Authenticated users can read all screenshots (group app)
create policy "Users can read all screenshots"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'bet-screenshots');

-- Users can delete their own screenshots
create policy "Users can delete own screenshots"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'bet-screenshots'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
