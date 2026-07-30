-- ============================================================================
-- CourtEdge — UTR-driven Kalshi tennis trading desk
--
-- Every object created here is prefixed `kalshi_` so it can never collide with
-- the 21 pre-existing tables in this project's public schema.
--
-- RLS is enabled with no permissive policies: the anon/publishable key cannot
-- read or write any of it. The backend connects as the `postgres` role, which
-- bypasses RLS. The browser never talks to Supabase directly — it goes through
-- the Express API.
-- ============================================================================

-- ---------------------------------------------------------------- players ---
create table if not exists public.kalshi_players (
  competitor_id     text primary key,              -- Kalshi custom_strike.tennis_competitor
  name              text not null,
  utr               numeric(4,2),                  -- Universal Tennis Rating, null until imported
  utr_source        text,
  utr_updated_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists kalshi_players_name_idx on public.kalshi_players (lower(name));
create index if not exists kalshi_players_utr_idx  on public.kalshi_players (utr) where utr is not null;

-- ----------------------------------------------------------------- events ---
-- One Kalshi event == one tennis match (which carries two markets, one per player).
create table if not exists public.kalshi_events (
  event_ticker         text primary key,
  series_ticker        text not null,
  title                text,
  matchup              text,                       -- "Monday vs Hance"
  tournament           text,                       -- "M25 Edwardsville IL"
  round                text,                       -- "Round of 16"
  tour_level           text,                       -- M15/M25/W35/W75/ATP/WTA…
  occurrence_datetime  timestamptz,
  close_time           timestamptz,
  status               text,
  raw                  jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists kalshi_events_series_idx on public.kalshi_events (series_ticker);
create index if not exists kalshi_events_occ_idx    on public.kalshi_events (occurrence_datetime desc);
create index if not exists kalshi_events_status_idx on public.kalshi_events (status);

-- ---------------------------------------------------------------- markets ---
create table if not exists public.kalshi_markets (
  ticker               text primary key,
  event_ticker         text not null references public.kalshi_events(event_ticker) on delete cascade,
  series_ticker        text not null,
  competitor_id        text references public.kalshi_players(competitor_id) on delete set null,
  player_name          text,
  title                text,
  status               text,
  -- prices stored as integer cents; the API returns decimal dollar strings
  yes_bid_cents        integer,
  yes_ask_cents        integer,
  no_bid_cents         integer,
  no_ask_cents         integer,
  last_price_cents     integer,
  yes_bid_size         numeric(14,2),
  yes_ask_size         numeric(14,2),
  volume               numeric(16,2),
  volume_24h           numeric(16,2),
  open_interest        numeric(16,2),
  liquidity            numeric(16,2),
  close_time           timestamptz,
  occurrence_datetime  timestamptz,
  raw                  jsonb,
  first_seen_at        timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists kalshi_markets_event_idx  on public.kalshi_markets (event_ticker);
create index if not exists kalshi_markets_series_idx on public.kalshi_markets (series_ticker);
create index if not exists kalshi_markets_status_idx on public.kalshi_markets (status);
create index if not exists kalshi_markets_comp_idx   on public.kalshi_markets (competitor_id);

-- ---------------------------------------------------------- price history ---
create table if not exists public.kalshi_price_history (
  id                bigserial primary key,
  ticker            text not null,
  yes_bid_cents     integer,
  yes_ask_cents     integer,
  mid_cents         integer,
  last_price_cents  integer,
  volume            numeric(16,2),
  captured_at       timestamptz not null default now()
);
create index if not exists kalshi_price_history_ticker_time_idx
  on public.kalshi_price_history (ticker, captured_at desc);

-- ---------------------------------------------------------------- signals ---
-- Model output: fair value vs market, recomputed on every sync.
create table if not exists public.kalshi_signals (
  ticker            text primary key references public.kalshi_markets(ticker) on delete cascade,
  event_ticker      text not null,
  player_name       text,
  opponent_name     text,
  player_utr        numeric(4,2),
  opponent_utr      numeric(4,2),
  utr_gap           numeric(5,2),
  fair_cents        integer,
  market_cents      integer,
  ev_pct            numeric(8,2),
  model             text not null default 'utr_gap_v1',
  is_actionable     boolean not null default false,
  computed_at       timestamptz not null default now()
);
create index if not exists kalshi_signals_ev_idx    on public.kalshi_signals (ev_pct desc nulls last);
create index if not exists kalshi_signals_act_idx   on public.kalshi_signals (is_actionable) where is_actionable;
create index if not exists kalshi_signals_event_idx on public.kalshi_signals (event_ticker);

-- ----------------------------------------------------------------- alerts ---
create table if not exists public.kalshi_alerts (
  id                bigserial primary key,
  ticker            text not null,
  event_ticker      text not null,
  player_name       text,
  matchup           text,
  tournament        text,
  utr_gap           numeric(5,2),
  fair_cents        integer,
  market_cents      integer,
  ev_pct            numeric(8,2),
  volume_available  numeric(16,2),
  status            text not null default 'open'
                      check (status in ('open','dismissed','executed','expired')),
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);
-- at most one live alert per market
create unique index if not exists kalshi_alerts_open_ticker_uidx
  on public.kalshi_alerts (ticker) where status = 'open';
create index if not exists kalshi_alerts_status_idx on public.kalshi_alerts (status, created_at desc);

-- ----------------------------------------------------------------- trades ---
create table if not exists public.kalshi_trades (
  id                bigserial primary key,
  kalshi_order_id   text unique,
  client_order_id   text unique,
  ticker            text not null,
  event_ticker      text,
  player_name       text,
  matchup           text,
  side              text not null default 'yes' check (side in ('yes','no')),
  action            text not null default 'buy' check (action in ('buy','sell')),
  entry_cents       integer,
  fair_cents        integer,
  size_contracts    integer,
  stake_usd         numeric(12,2),
  ev_pct            numeric(8,2),
  status            text not null default 'pending'
                      check (status in ('pending','filled','partial','cancelled','settled','failed')),
  result            text check (result in ('won','lost','void')),
  pnl_usd           numeric(12,2) default 0,
  fees_usd          numeric(12,2) default 0,
  error             text,
  raw               jsonb,
  placed_at         timestamptz not null default now(),
  filled_at         timestamptz,
  settled_at        timestamptz
);
create index if not exists kalshi_trades_status_idx on public.kalshi_trades (status, placed_at desc);
create index if not exists kalshi_trades_ticker_idx on public.kalshi_trades (ticker);
create index if not exists kalshi_trades_placed_idx on public.kalshi_trades (placed_at desc);

-- --------------------------------------------------------------- settings ---
create table if not exists public.kalshi_settings (
  id                      smallint primary key default 1 check (id = 1),
  min_ev_threshold        numeric(6,2) not null default 8,
  stake_per_trade         numeric(12,2) not null default 250,
  max_exposure_per_match  numeric(12,2) not null default 600,
  min_utr_gap             numeric(4,2) not null default 0.5,
  manual_approval         boolean not null default true,
  sweep_full_volume       boolean not null default true,
  pushover_enabled        boolean not null default false,
  sms_fallback            boolean not null default false,
  inplay_enabled          boolean not null default true,
  bot_enabled             boolean not null default true,
  series_tickers          text[] not null default array['KXITFMATCH','KXITFWMATCH'],
  updated_at              timestamptz not null default now()
);
insert into public.kalshi_settings (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------- sync audit ---
create table if not exists public.kalshi_sync_runs (
  id                bigserial primary key,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            text not null default 'running'
                      check (status in ('running','ok','error')),
  events_seen       integer default 0,
  markets_seen      integer default 0,
  markets_upserted  integer default 0,
  signals_computed  integer default 0,
  alerts_created    integer default 0,
  latency_ms        integer,
  error             text
);
create index if not exists kalshi_sync_runs_started_idx on public.kalshi_sync_runs (started_at desc);

-- ------------------------------------------------- portfolio (Kalshi auth) ---
create table if not exists public.kalshi_portfolio_snapshots (
  id                bigserial primary key,
  balance_cents     bigint,
  exposure_cents    bigint,
  realized_pnl_cents bigint,
  open_positions    integer,
  captured_at       timestamptz not null default now()
);
create index if not exists kalshi_portfolio_captured_idx
  on public.kalshi_portfolio_snapshots (captured_at desc);

-- ------------------------------------------------------------ updated_at ----
create or replace function public.kalshi_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['kalshi_players','kalshi_events','kalshi_markets','kalshi_settings']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.kalshi_touch_updated_at()',
      t || '_touch', t);
  end loop;
end $$;

-- ------------------------------------------------------------------- RLS ----
-- Enabled with no policies: anon/publishable key gets nothing. The backend
-- connects as `postgres` and is not subject to RLS.
alter table public.kalshi_players              enable row level security;
alter table public.kalshi_events               enable row level security;
alter table public.kalshi_markets              enable row level security;
alter table public.kalshi_price_history        enable row level security;
alter table public.kalshi_signals              enable row level security;
alter table public.kalshi_alerts               enable row level security;
alter table public.kalshi_trades               enable row level security;
alter table public.kalshi_settings             enable row level security;
alter table public.kalshi_sync_runs            enable row level security;
alter table public.kalshi_portfolio_snapshots  enable row level security;
