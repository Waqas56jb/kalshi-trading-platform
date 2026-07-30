-- Favourite or underdog, from the market's own view.
--
-- A Kalshi price is a probability, so the side trading above 50c is the one the
-- market expects to win. Worth separating because the desk's signals are heavily
-- skewed: the UTR model overwhelmingly flags underdogs as underpriced, and the
-- one position that has settled so far was exactly that shape and lost the full
-- stake. Being able to look at the two groups apart makes that visible.
alter table public.kalshi_signals
  add column if not exists side_type text
    check (side_type in ('favourite', 'underdog', 'pickem'));

alter table public.kalshi_alerts
  add column if not exists side_type text;

create index if not exists kalshi_signals_side_idx on public.kalshi_signals (side_type);
create index if not exists kalshi_alerts_side_idx on public.kalshi_alerts (side_type) where status = 'open';
