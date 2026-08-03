-- Early-round volume: soften books differential + risk floors.
-- Desk era: exclude pre-new-formula shadow P&L (the old 6) via archived_at.

alter table public.kalshi_settings
  alter column cross_market_min_edge set default 0.015,
  alter column cross_market_min_books set default 1,
  alter column min_net_edge set default 0.03,
  alter column min_roi set default 0.08,
  alter column sub10_min_roi set default 0.20,
  alter column max_signal_age_seconds set default 120,
  alter column max_snapshot_age_seconds set default 180;

update public.kalshi_settings set
  cross_market_min_edge = 0.015,
  cross_market_min_books = 1,
  min_net_edge = 0.03,
  min_roi = 0.08,
  sub10_min_roi = 0.20,
  max_signal_age_seconds = 120,
  max_snapshot_age_seconds = 180,
  updated_at = now()
where id = 1;

alter table public.kalshi_shadow_trades
  add column if not exists archived_at timestamptz;

create index if not exists kalshi_shadow_trades_active_idx
  on public.kalshi_shadow_trades (approved, created_at desc)
  where archived_at is null;

comment on column public.kalshi_shadow_trades.archived_at is
  'Excluded from desk P&L / Placed / Settled. Used to zero the pre-new-formula era.';
