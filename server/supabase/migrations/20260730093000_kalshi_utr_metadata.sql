-- ============================================================================
-- Provenance for imported UTR ratings.
--
-- Every rating must be traceable to the exact UTR profile it came from and the
-- name it was matched against, so a bad fuzzy match can be found and corrected
-- rather than silently poisoning the fair-value model.
-- ============================================================================

alter table public.kalshi_players
  add column if not exists utr_player_id     text,
  add column if not exists utr_status        text,     -- "Rated" / "Unrated" / "Projected"
  add column if not exists utr_matched_name  text,     -- displayName on the UTR profile
  add column if not exists utr_match_score   numeric(4,3),
  add column if not exists utr_doubles       numeric(4,2),
  add column if not exists utr_nationality   text,
  add column if not exists lookup_attempted_at timestamptz,
  add column if not exists lookup_failed     boolean not null default false;

create index if not exists kalshi_players_lookup_idx
  on public.kalshi_players (lookup_attempted_at nulls first)
  where utr is null;

create index if not exists kalshi_players_utr_player_idx
  on public.kalshi_players (utr_player_id) where utr_player_id is not null;

-- Only ratings UTR itself considers reliable feed the model. A "Projected" or
-- "Unrated" profile is recorded for audit but must not price a market.
create or replace view public.kalshi_rated_players as
  select competitor_id, name, utr, utr_status, utr_matched_name, utr_match_score,
         utr_player_id, utr_updated_at
  from public.kalshi_players
  where utr is not null and utr_status = 'Rated';
