-- ============================================================================
-- Paper trading.
--
-- Orders cannot reach Kalshi until the API key pair is fixed, so the desk needs
-- a way to exercise the full workflow — approve, fill, hold, settle — without
-- pretending an order was placed.
--
-- A paper fill is NOT invented data: it uses the real ask, is capped by the real
-- volume available at that ask, and settles against the *actual* Kalshi result
-- once the match resolves. What makes it paper is only that no order was sent.
-- Every row is labelled, and the UI never shows a paper position as live.
-- ============================================================================

alter table public.kalshi_trades
  add column if not exists mode text not null default 'live'
    check (mode in ('live', 'paper')),
  add column if not exists settle_result text,      -- Kalshi's own 'yes' / 'no'
  add column if not exists settled_price_cents integer;

create index if not exists kalshi_trades_mode_idx on public.kalshi_trades (mode, status);

-- Existing rows were real attempts against the exchange.
update public.kalshi_trades set mode = 'live' where mode is null;

alter table public.kalshi_settings
  add column if not exists paper_trading boolean not null default true;

comment on column public.kalshi_settings.paper_trading is
  'When true, approving an alert records a paper fill at the real ask instead of sending an order to Kalshi. Forced on while Kalshi credentials are rejected.';
