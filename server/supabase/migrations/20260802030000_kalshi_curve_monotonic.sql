-- The fitted curve needs the observed mean gap, not the arithmetic midpoint of
-- the bracket. The top bracket spans 1.0 to 3.0, so anchoring it at 2.0 put the
-- curve's last point far beyond where any real match sits and flattened
-- everything above a 0.75 gap into the same price.
alter table public.kalshi_utr_curve
  add column if not exists mean_gap      numeric(6,3),
  add column if not exists raw_win_rate  numeric(6,4),
  add column if not exists shrunk_cents  int;
