-- Minimum edge, position exits, and a place to keep real schedule times.
--
-- The trader's own words on a +6c alert: "This edge is small. Too small." An edge
-- floor in cents is a better filter than percentage EV, which inflates on cheap
-- contracts and lets 3c edges through at +300%.
alter table public.kalshi_settings
  add column if not exists min_edge_cents        integer not null default 15,
  add column if not exists auto_sell_at_fair     boolean not null default false,
  add column if not exists auto_sell_buffer_cents integer not null default 0;

comment on column public.kalshi_settings.min_edge_cents is
  'Alerts require at least this much absolute edge (fair - ask). Cents, not percent.';
comment on column public.kalshi_settings.auto_sell_at_fair is
  'Close a position automatically once the bid reaches its modelled fair value.';

-- Exit tracking on a position.
alter table public.kalshi_trades
  add column if not exists exit_cents     integer,
  add column if not exists exit_reason    text,   -- manual | auto_fair_value | settled
  add column if not exists closed_at      timestamptz;

create index if not exists kalshi_trades_open_idx
  on public.kalshi_trades (status) where status in ('filled', 'partial');

-- Real start times, keyed to a Kalshi market, from whichever source can supply them.
create table if not exists public.kalshi_match_schedule (
  ticker        text primary key,
  event_ticker  text,
  starts_at     timestamptz not null,
  source        text not null,           -- sofascore | oddsapi | manual
  home_name     text,
  away_name     text,
  match_status  text,                    -- notstarted | inprogress | finished
  confidence    numeric(4,3),            -- name-match score
  fetched_at    timestamptz not null default now()
);
create index if not exists kalshi_match_schedule_starts_idx
  on public.kalshi_match_schedule (starts_at);

alter table public.kalshi_match_schedule enable row level security;
