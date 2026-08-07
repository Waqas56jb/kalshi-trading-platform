-- Does the odds feed ever publish for our matches, and how late?
--
-- The client's account is that odds appear too close to the off to be useful.
-- Nobody has measured it, and the answer decides whether cross-market is
-- possible on this feed at all, so every attempt is now logged rather than
-- inferred: which match, when we asked, how long before the match, and what came
-- back. A day of this replaces the impression with a number.
--
-- Absence is recorded as loudly as presence. A row with books = 0 is the finding
-- when the feed is empty, and without it a quiet failure looks the same as never
-- having asked.

create table if not exists public.kalshi_odds_probe (
  id            bigserial primary key,
  ticker        text not null,
  event_ticker  text,
  player_name   text,
  opponent_name text,
  match_date    date,

  probed_at     timestamptz not null default now(),
  -- negative once the match has started, so lateness is directly readable
  hours_to_match numeric(8,2),

  fixture_found boolean not null default false,
  books         int not null default 0,
  consensus_cents int,
  kalshi_ask_cents int,
  -- what the books said minus what Kalshi was asking, at the same instant
  divergence_cents int,
  error         text
);

create index if not exists kalshi_odds_probe_time_idx
  on public.kalshi_odds_probe (probed_at desc);
create index if not exists kalshi_odds_probe_hit_idx
  on public.kalshi_odds_probe (books) where books > 0;
create index if not exists kalshi_odds_probe_ticker_idx
  on public.kalshi_odds_probe (ticker, probed_at desc);

comment on table public.kalshi_odds_probe is
  'Every attempt to fetch book odds, hit or miss, with how long before the match it was made.';
