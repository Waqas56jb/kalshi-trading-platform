-- Closing-line value.
--
-- The odds feed publishes late — often not until shortly before the off, which
-- is why using it as a permission slip stopped the desk trading. Late odds are
-- useless as a gate and ideal as a scoreboard: we do not need the books before
-- we enter, only afterwards, to ask whether the price we paid beat the price the
-- market closed at.
--
-- That comparison is worth having because it converges far faster than P&L. At
-- this desk's volume, profit and loss needs months to say anything; closing-line
-- value says it in weeks, which is the difference between finding out and
-- guessing.

create table if not exists public.kalshi_closing_line (
  ticker            text primary key,
  event_ticker      text,
  player_name       text,
  opponent_name     text,
  match_date        date,

  -- what we paid, captured at entry
  entry_cents       int,
  entry_at          timestamptz,
  stake_usd         numeric(12,2),
  source            text,                    -- 'shadow' | 'live'

  -- where the books closed, captured after the match
  close_book_cents  int,
  close_books       int,
  close_captured_at timestamptz,

  -- where Kalshi itself closed, which needs no external feed at all
  close_kalshi_cents int,

  -- entry minus close. Positive means we bought below where the market settled,
  -- which is the direction that indicates edge.
  clv_vs_book_cents  int,
  clv_vs_kalshi_cents int,

  result            text,                    -- 'won' | 'lost'
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists kalshi_closing_line_pending_idx
  on public.kalshi_closing_line (match_date desc) where close_book_cents is null;

create index if not exists kalshi_closing_line_scored_idx
  on public.kalshi_closing_line (match_date desc) where clv_vs_kalshi_cents is not null;

comment on table public.kalshi_closing_line is
  'Entry price against the closing price, per position. Measures edge faster than P&L can.';
comment on column public.kalshi_closing_line.clv_vs_kalshi_cents is
  'Entry minus Kalshi close. Needs no external feed, so it is always populated.';
