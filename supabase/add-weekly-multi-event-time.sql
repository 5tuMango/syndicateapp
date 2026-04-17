-- Add event_time to weekly_multi_legs so countdown timers work on the dashboard
alter table public.weekly_multi_legs
  add column if not exists event_time timestamptz;
