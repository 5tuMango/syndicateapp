-- Cash-out support for bets and weekly multis.
-- A bet/multi is "cashed out" when the punter accepted an early payout from the
-- bookmaker before all legs resolved. The original odds × stake is no longer
-- relevant — only `cash_out_value` matters for winnings/P&L.
--
-- When `cashed_out = true`:
--   - calcWinnings(bet)    = cash_out_value
--   - calcProfitLoss(bet)  = cash_out_value − stake (or just cash_out_value for bonus bets)
--   - The bet is treated as 'won' across the app, regardless of how legs end up.
--   - Legs continue to be resolved normally — they're factual, separate from settlement.

alter table public.bets
  add column if not exists cashed_out      boolean       not null default false,
  add column if not exists cash_out_value  numeric(10,2),
  add column if not exists cash_out_image  text;

alter table public.weekly_multis
  add column if not exists cashed_out      boolean       not null default false,
  add column if not exists cash_out_value  numeric(10,2),
  add column if not exists cash_out_image  text;
