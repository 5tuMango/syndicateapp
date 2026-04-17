-- Global kitty settings (single row)
create table if not exists public.kitty_settings (
  id integer primary key default 1,
  unattributed_funds numeric default 0,
  constraint single_row check (id = 1)
);

-- Insert the single row with the $400 unattributed deposit
insert into public.kitty_settings (id, unattributed_funds)
values (1, 400)
on conflict (id) do update set unattributed_funds = 400;
