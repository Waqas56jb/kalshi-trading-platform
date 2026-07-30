-- ============================================================================
-- Schedule trust, display timezone, and bookmaker odds.
--
-- Kalshi's `occurrence_datetime` is not a start time. Across 454 live markets
-- there are 29 distinct values, every one on a :00 or :30 grid, and 4% sit at
-- exactly 00:00Z — a date placeholder with no time in it at all. The ITF M25
-- Edwardsville match Kalshi stamps 2026-07-31T00:00:00Z is scheduled for
-- 10:00 AM Pacific according to Sofascore; rendered in Pacific the Kalshi value
-- becomes "5:00 PM", which looks precise and is not.
--
-- So schedule times get a provenance column. A placeholder is recorded as
-- unreliable rather than displayed as fact, and can be overridden by a real
-- source (Sofascore, the ITF site) once one is wired in.
-- ============================================================================

alter table public.kalshi_events
  add column if not exists scheduled_at        timestamptz,
  add column if not exists schedule_source     text,     -- kalshi_placeholder | kalshi_slot | sofascore | itf | manual
  add column if not exists schedule_confidence text      -- none | slot | exact
    check (schedule_confidence in ('none', 'slot', 'exact'));

comment on column public.kalshi_events.scheduled_at is
  'Best known start time. Prefer this over the Kalshi occurrence_datetime.';
comment on column public.kalshi_events.schedule_confidence is
  'none = no usable time (placeholder); slot = half-hour bucket from Kalshi; exact = from a real schedule source.';

-- Times are shown in one fixed zone so the desk reads the same for everyone and
-- matches the schedules the trader is comparing against.
alter table public.kalshi_settings
  add column if not exists display_timezone text not null default 'America/Los_Angeles',
  add column if not exists odds_divergence_cents integer not null default 15,
  add column if not exists odds_alerts_enabled boolean not null default true;

comment on column public.kalshi_settings.display_timezone is
  'IANA zone for every timestamp rendered in the UI. Pacific by default.';
comment on column public.kalshi_settings.odds_divergence_cents is
  'Raise an odds alert when Kalshi differs from the bookmaker consensus by at least this many cents.';

-- ---------------------------------------------------------- bookmaker odds ---
-- American odds converted to an implied probability in cents, which is directly
-- comparable to a Kalshi price: +100 -> 50c, +200 -> 33c, -800 -> 89c.
create table if not exists public.kalshi_market_odds (
  id              bigserial primary key,
  ticker          text not null,
  event_ticker    text,
  player_name     text,
  source          text not null,              -- bethero | theoddsapi | manual …
  bookmaker       text,                        -- null when already an average
  american_odds   integer,
  decimal_odds    numeric(10,3),
  implied_cents   integer not null,
  vig_removed     boolean not null default false,
  fetched_at      timestamptz not null default now()
);
create index if not exists kalshi_market_odds_ticker_idx
  on public.kalshi_market_odds (ticker, fetched_at desc);
create index if not exists kalshi_market_odds_source_idx
  on public.kalshi_market_odds (source, fetched_at desc);

alter table public.kalshi_market_odds enable row level security;

/* Latest consensus per market: average the books, so one outlier cannot define
   the "market" price. */
create or replace view public.kalshi_odds_consensus as
  select ticker,
         round(avg(implied_cents))::int as consensus_cents,
         min(implied_cents)::int        as low_cents,
         max(implied_cents)::int        as high_cents,
         count(*)::int                  as books,
         max(fetched_at)                as fetched_at
  from public.kalshi_market_odds
  where fetched_at > now() - interval '6 hours'
  group by ticker;
