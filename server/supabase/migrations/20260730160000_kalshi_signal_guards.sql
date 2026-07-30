-- ============================================================================
-- Liquidity and sanity guards on what counts as actionable.
--
-- Live data showed the model's largest disagreements with the market are where
-- it is most likely wrong, not most right. Example from a real sync:
--
--   Oriol Roca Batalla  UTR 14.36   market bid/ask   0/  1c   model 87c
--   Niklas Guttau       UTR 13.20   market bid/ask  99/100c   model 13c
--
-- Both sides sum to ~100c, both names matched their UTR profile at score 1.000,
-- and the model is internally consistent — so nothing is broken. The market is
-- simply certain (on 18,576 contracts) that the higher-rated player loses, which
-- is what a withdrawal, retirement or injury looks like. A ratings model cannot
-- see any of those, so a naive UTR desk would buy into precisely those matches.
--
-- These guards keep such rows visible for review but out of the actionable queue:
--   * a real two-sided book is required (a 0/1c quote is not a market)
--   * an implausibly large disagreement defers to the market
-- ============================================================================

alter table public.kalshi_settings
  add column if not exists min_bid_cents     integer not null default 5,
  add column if not exists max_spread_cents  integer not null default 12,
  add column if not exists max_edge_cents    integer not null default 25;

comment on column public.kalshi_settings.min_bid_cents is
  'Minimum yes_bid for a market to be tradeable. Below this nobody is really making a market.';
comment on column public.kalshi_settings.max_spread_cents is
  'Maximum bid-ask spread. A wide book means the fill price is not what the model assumed.';
comment on column public.kalshi_settings.max_edge_cents is
  'Largest model-vs-market disagreement still treated as an edge. Beyond it the market almost certainly holds information the ratings do not (withdrawal, injury, retirement), so the signal is kept for review instead.';

-- Why a signal did not qualify, so the UI can explain itself rather than just
-- hiding rows.
alter table public.kalshi_signals
  add column if not exists review_reason text;

create index if not exists kalshi_signals_review_idx
  on public.kalshi_signals (review_reason) where review_reason is not null;
