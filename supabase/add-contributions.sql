-- Track each persona's contribution to the punters club kitty
alter table public.personas
  add column if not exists amount_paid numeric default 0,
  add column if not exists contribution_target numeric default 400;

-- Seed initial values (update by nickname — adjust if nicknames differ)
update public.personas set amount_paid = 200 where lower(nickname) = 'doctor';
update public.personas set amount_paid = 400 where lower(nickname) = 'coiny';
update public.personas set amount_paid = 200 where lower(nickname) = 'yoda';
update public.personas set amount_paid = 400 where lower(nickname) = 'santa';
update public.personas set amount_paid = 400 where lower(nickname) = 'mango';
update public.personas set amount_paid = 100 where lower(nickname) = 'crockett';
update public.personas set amount_paid = 150 where lower(nickname) = 'blob';
update public.personas set amount_paid = 400 where lower(nickname) = 'spud';
