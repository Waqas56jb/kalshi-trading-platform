-- Play state, inferred from the order book because Kalshi publishes no start time.
--
-- Measured on live data while ITF M25 Koszalin was under way: markets in play had
-- grown 48,047 / 17,936 / 1,182 contracts of volume over three hours, while
-- markets yet to start had grown 0 / 0 / 9. Volume growth separates them cleanly,
-- far more reliably than any timestamp Kalshi provides.
alter table public.kalshi_markets
  add column if not exists volume_growth_3h numeric(16,2),
  add column if not exists play_state text
    check (play_state in ('not_started', 'in_play', 'unknown'));

create index if not exists kalshi_markets_play_state_idx on public.kalshi_markets (play_state);

alter table public.kalshi_settings
  add column if not exists inplay_volume_threshold integer not null default 150;

comment on column public.kalshi_settings.inplay_volume_threshold is
  'Contracts of volume growth over 3h above which a market is treated as in play.';
