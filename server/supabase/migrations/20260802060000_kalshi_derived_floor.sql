-- The price floor stops being typed in and starts being measured.
--
-- Robbie: "delete everything but the bankroll tab, the risk algorithm is
-- supposed to do what's best". He is right that a floor is not a preference —
-- there is a correct answer and the settled data holds it. Measured over 237
-- model-liked bets, everything under 25c loses: the sub-10c band is 134 bets
-- and nought wins, and the first band with positive ROI is 25-35c.
--
-- The value is recomputed on every sync and shown read-only. min_price_cents
-- survives only as an override for the case where someone needs to force it.
create table if not exists public.kalshi_derived_limits (
  name          text primary key,
  value         numeric(12,4) not null,
  unit          text,
  sample_size   int,
  evidence      jsonb,
  computed_at   timestamptz not null default now()
);

comment on table public.kalshi_derived_limits is
  'Limits the engine works out for itself. Not editable; recomputed each sync.';
