-- "Wipe the slate clean, this should start again at 0".
--
-- Archived rather than deleted. The old rows are the account's real trading
-- history imported from Kalshi, and destroying them would lose the only record
-- of what actually happened on a real-money account. Metrics exclude anything
-- archived, so the desk reads zero exactly as asked, and the history is still
-- there if anyone needs to look back.
alter table public.kalshi_trades
  add column if not exists archived_at timestamptz;

create index if not exists kalshi_trades_active_idx
  on public.kalshi_trades (status, placed_at desc) where archived_at is null;

comment on column public.kalshi_trades.archived_at is
  'Set to exclude a trade from all metrics. Never delete real account history.';
