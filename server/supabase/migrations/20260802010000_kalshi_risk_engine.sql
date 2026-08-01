-- The risk engine, shadow trading, and self-recalibration.
--
-- Everything the client signed off on in the 1-2 August review lands here:
-- simulated bankroll, per-side evaluation, cross-market confirmation, the
-- edge-scaled caps, and the recalibration that replaces the hand-written UTR
-- curve with one fitted to settled results.

-- --------------------------------------------------------------- settings ---

alter table public.kalshi_settings
  -- Shadow mode. The engine evaluates and records every decision but sends no
  -- order to Kalshi. On by default: the account went to zero once already, and
  -- the backtest says the signal is not yet worth real money.
  add column if not exists shadow_mode              boolean        not null default true,
  add column if not exists shadow_auto_place        boolean        not null default true,
  add column if not exists simulated_bankroll_usd   numeric(14,2)  not null default 10000,

  -- Capital reserves. 0.60 means 60% of bankroll is held back as free cash.
  add column if not exists minimum_free_cash_fraction numeric(5,4) not null default 0.60,
  add column if not exists fixed_operating_reserve_usd numeric(12,2) not null default 0,
  add column if not exists minimum_bet_usd          numeric(10,2)  not null default 1.00,

  -- Probability shrinkage toward the market.
  add column if not exists model_weight             numeric(5,4)   not null default 0.60,
  add column if not exists uncertainty_haircut      numeric(5,4)   not null default 0.01,
  add column if not exists sub10_uncertainty_haircut numeric(5,4)  not null default 0.02,
  add column if not exists transition_band_low      numeric(5,4)   not null default 0.07,
  add column if not exists transition_band_high     numeric(5,4)   not null default 0.13,

  -- Fractional Kelly tiers.
  add column if not exists kelly_base               numeric(5,4)   not null default 0.10,
  add column if not exists kelly_well_validated     numeric(5,4)   not null default 0.15,
  add column if not exists kelly_weak_data          numeric(5,4)   not null default 0.05,
  add column if not exists kelly_extreme_underdog   numeric(5,4)   not null default 0.025,
  add column if not exists calibration_min_sample   int            not null default 200,
  add column if not exists calibration_strong_sample int           not null default 500,
  add column if not exists calibration_max_error    numeric(5,4)   not null default 0.04,
  add column if not exists calibration_strong_error numeric(5,4)   not null default 0.02,

  -- Per-position caps, as a fraction of risk bankroll.
  add column if not exists cap_ordinary             numeric(6,5)   not null default 0.005,
  add column if not exists cap_10_to_20             numeric(6,5)   not null default 0.0035,
  add column if not exists cap_sub_10               numeric(6,5)   not null default 0.002,
  add column if not exists cap_absolute_max         numeric(6,5)   not null default 0.015,

  -- Edge scaling: lets a high-conviction bet exceed the flat cap, but only on
  -- verified calibration and never past cap_absolute_max.
  add column if not exists edge_scaling_enabled     boolean        not null default true,
  add column if not exists edge_scaling_reference   numeric(5,4)   not null default 0.15,
  add column if not exists edge_scaling_max_mult    numeric(5,2)   not null default 3.0,

  -- Aggregate exposure caps. There is deliberately no surface cap: the client
  -- removed it, and Kalshi does not publish a surface for us to group on.
  add column if not exists cap_match_exposure       numeric(6,5)   not null default 0.0075,
  add column if not exists cap_player_exposure      numeric(6,5)   not null default 0.01,
  add column if not exists cap_player_daily_stake   numeric(6,5)   not null default 0.03,
  add column if not exists cap_bucket_exposure      numeric(6,5)   not null default 0.025,
  add column if not exists cap_signal_exposure      numeric(6,5)   not null default 0.03,
  add column if not exists cap_unsettled_exposure   numeric(6,5)   not null default 0.08,

  -- Entry requirements.
  add column if not exists min_net_edge             numeric(5,4)   not null default 0.04,
  add column if not exists sub10_min_net_edge       numeric(5,4)   not null default 0.05,
  add column if not exists min_roi                  numeric(6,4)   not null default 0.10,
  add column if not exists sub10_min_roi            numeric(6,4)   not null default 0.30,
  add column if not exists absolute_min_probability numeric(5,4)   not null default 0.05,

  -- Minimum executable price. The backtest showed every loss concentrated
  -- below roughly 10c, so this is the single most load-bearing filter we have.
  -- Adjustable rather than hard-coded, because the right level moves as the
  -- sample grows.
  add column if not exists min_price_cents          int            not null default 20,

  -- Cross-market confirmation against sharp sportsbooks. Off until the odds
  -- feed is actually delivering, then switched on.
  add column if not exists cross_market_enabled     boolean        not null default false,
  add column if not exists cross_market_min_edge    numeric(5,4)   not null default 0.03,
  add column if not exists cross_market_min_books   int            not null default 2,
  add column if not exists cross_market_max_spread  numeric(5,4)   not null default 0.10,

  -- Execution and staleness.
  add column if not exists max_book_participation   numeric(5,4)   not null default 0.10,
  add column if not exists max_signal_age_seconds   int            not null default 60,
  add column if not exists max_snapshot_age_seconds int            not null default 120,
  add column if not exists max_price_move           numeric(5,4)   not null default 0.02,
  add column if not exists expected_slippage        numeric(5,4)   not null default 0.003,

  -- Loss throttles.
  add column if not exists throttle_1_at            numeric(5,4)   not null default 0.01,
  add column if not exists throttle_2_at            numeric(5,4)   not null default 0.02,
  add column if not exists throttle_3_at            numeric(5,4)   not null default 0.04,
  add column if not exists daily_stop_at            numeric(5,4)   not null default 0.06,
  add column if not exists weekly_drawdown_stop     numeric(5,4)   not null default 0.05,
  add column if not exists throttle_1_mult          numeric(5,4)   not null default 0.75,
  add column if not exists throttle_2_mult          numeric(5,4)   not null default 0.50,
  add column if not exists throttle_3_mult          numeric(5,4)   not null default 0.25,

  -- Self-recalibration.
  add column if not exists recalibration_enabled    boolean        not null default true,
  add column if not exists recalibration_min_sample int            not null default 40;

-- The client turned both exit rules off. Applied here rather than left to a UI
-- toggle so the running desk matches the decision immediately.
update public.kalshi_settings
   set take_profit_enabled = false,
       stop_loss_enabled   = false,
       auto_sell_at_fair   = false,
       min_utr_gap         = 0
 where id = 1;

-- ---------------------------------------------------------- shadow trades ---

-- Every decision the engine reaches, approved or not. Held-back opportunities
-- are rows here too, with their rejection reason, because the client asked to
-- see what was filtered rather than have it silently dropped.
create table if not exists public.kalshi_shadow_trades (
  id                bigserial primary key,
  ticker            text not null,
  event_ticker      text,
  player_name       text,
  opponent_name     text,
  side              text,                       -- 'favourite' | 'underdog'

  -- what the model and the market each thought
  model_probability   numeric(6,4),
  market_reference    numeric(6,4),
  conservative_prob   numeric(6,4),
  utr_gap             numeric(6,3),
  utr_bracket         text,                     -- 0-0.1 | 0.1-0.25 | 0.25-0.5 | 0.5-1.0 | 1.0+

  -- execution as it would really have happened
  best_ask_cents      int,
  expected_vwap_cents numeric(8,3),
  fee_rate            numeric(6,4),
  slippage            numeric(6,4),
  effective_cost      numeric(6,4),
  max_price_cents     numeric(8,3),
  book_depth_levels   int,

  -- the decision
  approved            boolean not null,
  net_edge            numeric(6,4),
  expected_roi        numeric(8,4),
  full_kelly          numeric(6,4),
  kelly_multiplier    numeric(6,4),
  base_cap_fraction   numeric(8,6),
  edge_scaling_mult   numeric(6,3),
  effective_cap       numeric(8,6),
  throttle_multiplier numeric(5,3),
  stake_usd           numeric(12,2),
  contracts           numeric(12,4),
  limiting_constraint text,
  rejection_reason    text,

  -- cross-market confirmation
  book_consensus      numeric(6,4),
  book_median         numeric(6,4),
  book_count          int,
  supporting_books    int,
  consensus_range     numeric(6,4),
  cross_market_edge   numeric(6,4),
  classification      text,

  -- outcome, filled in once the match settles
  result              text,                     -- 'won' | 'lost'
  pnl_usd             numeric(12,2),
  settled_at          timestamptz,

  match_date          date,
  created_at          timestamptz not null default now()
);

-- One decision per ticker per sync; re-evaluating updates in place rather than
-- growing a row every 60 seconds for the same unchanged market.
create unique index if not exists kalshi_shadow_trades_ticker_day_idx
  on public.kalshi_shadow_trades (ticker, match_date);

create index if not exists kalshi_shadow_trades_open_idx
  on public.kalshi_shadow_trades (approved, result) where result is null;
create index if not exists kalshi_shadow_trades_bracket_idx
  on public.kalshi_shadow_trades (utr_bracket, approved);
create index if not exists kalshi_shadow_trades_date_idx
  on public.kalshi_shadow_trades (match_date desc);

-- --------------------------------------------------------- order book -------

-- Per-side depth. The client was explicit that one side's price must never be
-- inferred as 1 minus the other's, because spreads and liquidity genuinely
-- differ between the two contracts of the same match.
create table if not exists public.kalshi_order_books (
  ticker        text primary key,
  asks          jsonb not null,                 -- [{price_cents, contracts}, ...]
  bids          jsonb,
  best_ask      int,
  depth_dollars numeric(14,2),
  levels        int,
  captured_at   timestamptz not null default now()
);

create index if not exists kalshi_order_books_fresh_idx
  on public.kalshi_order_books (captured_at desc);

-- -------------------------------------------------------- calibration -------

-- Measured, out-of-sample calibration per probability bucket. The risk engine
-- refuses to grant a larger Kelly multiplier unless `verified` is true, so a
-- placeholder can never buy the same trust as a real track record.
create table if not exists public.kalshi_calibration (
  bucket            text primary key,
  sample_size       int not null,
  mean_predicted    numeric(6,4),
  actual_rate       numeric(6,4),
  calibration_error numeric(6,4),
  verified          boolean not null default false,
  computed_at       timestamptz not null default now()
);

-- The fitted UTR curve. Replaces the hand-written breakpoints once enough
-- matches have settled; until then the code falls back to the original curve.
create table if not exists public.kalshi_utr_curve (
  bracket        text primary key,              -- 0-0.1 | 0.1-0.25 | ...
  gap_low        numeric(6,3) not null,
  gap_high       numeric(6,3) not null,
  sample_size    int not null,
  win_rate       numeric(6,4) not null,
  fitted_cents   int not null,
  computed_at    timestamptz not null default now()
);

comment on table public.kalshi_shadow_trades is
  'Every risk-engine decision, approved or rejected, with the reason. Simulated only.';
comment on table public.kalshi_order_books is
  'Per-side executable depth. Never infer one side from the other.';
