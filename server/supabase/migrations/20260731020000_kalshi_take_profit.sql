-- Take profit at a return threshold, alongside the existing exit at fair value.
--
-- Fair value is the model's exit; a return target is the trader's. They are not
-- the same trade: a position can be up 30% while still short of fair, and on a
-- book this thin the return in hand is often worth more than the last few cents
-- of theoretical edge.
alter table public.kalshi_settings
  add column if not exists take_profit_enabled boolean not null default false,
  add column if not exists take_profit_pct     numeric(6,2) not null default 25,
  add column if not exists stop_loss_enabled   boolean not null default false,
  add column if not exists stop_loss_pct       numeric(6,2) not null default 50;

comment on column public.kalshi_settings.take_profit_pct is
  'Close a position once its bid is this many percent above the entry price.';
comment on column public.kalshi_settings.stop_loss_pct is
  'Close a position once its bid is this many percent below the entry price.';
