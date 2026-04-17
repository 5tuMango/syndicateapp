-- Track extra payments into the kitty (fines, penalties) separate from the contribution target
alter table public.personas
  add column if not exists penalties_paid numeric default 0;

-- Seed Yoda's week 5 penalty
update public.personas set penalties_paid = 80 where lower(nickname) = 'yoda';
