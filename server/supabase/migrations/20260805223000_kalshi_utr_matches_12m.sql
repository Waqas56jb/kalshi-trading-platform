-- Singles match volume from UTR profile (current + prior calendar year buckets).
-- Desk rule (Robbie Aug 5): both players must have >15 before we bet.
alter table public.kalshi_players
  add column if not exists utr_matches_12m integer;
