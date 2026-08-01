-- Records how each market actually resolved.
--
-- Without this there is no target variable: 756 markets sat at status 'closed'
-- carrying no outcome at all, because a market that leaves the feed was only
-- ever marked closed and never re-read. A training set with no label is not a
-- training set, so the settled result is now stored explicitly.
--
-- result is Kalshi's own word: 'yes' when the named player won the match, 'no'
-- when they lost. settlement_value is 1.0 or 0.0 per contract and is kept
-- alongside it so a void or oddly-settled market is visible rather than silently
-- read as a loss.

alter table public.kalshi_markets
  add column if not exists result           text,
  add column if not exists settlement_value numeric(6,4),
  add column if not exists settled_at       timestamptz;

-- The backfill walks markets that closed without a recorded outcome, so that is
-- the lookup this index has to serve.
create index if not exists kalshi_markets_unsettled_idx
  on public.kalshi_markets (status, match_date desc)
  where result is null;

-- Exports and calibration both slice by outcome and date.
create index if not exists kalshi_markets_result_idx
  on public.kalshi_markets (result, match_date desc)
  where result is not null;

comment on column public.kalshi_markets.result is
  'Kalshi settlement: yes = this player won the match, no = lost. Null = unresolved.';
