-- ============================================================================
-- Pre-match-only alerting.
--
-- An alert is worth acting on before a ball is struck. Once a match is under way
-- the price moves on what is happening on court, which a pre-match ratings model
-- knows nothing about — and the desk's first settled position lost the full stake
-- on exactly that kind of market.
--
-- `prematch_only` restricts alerting to matches that have not started.
-- `alert_lead_minutes` additionally requires the match to be far enough away to
-- act on: an alert 30 seconds before the first serve is noise.
-- ============================================================================

alter table public.kalshi_settings
  add column if not exists prematch_only       boolean not null default true,
  add column if not exists alert_lead_minutes  integer not null default 10,
  add column if not exists alert_max_hours     integer not null default 72,
  add column if not exists sound_enabled       boolean not null default true;

comment on column public.kalshi_settings.prematch_only is
  'Only alert on matches that have not started yet.';
comment on column public.kalshi_settings.alert_lead_minutes is
  'A match must be at least this many minutes away to raise an alert, so there is time to act.';
comment on column public.kalshi_settings.alert_max_hours is
  'Ignore matches further out than this — quotes that far ahead are stale and thin.';
comment on column public.kalshi_settings.sound_enabled is
  'Play a chime in the browser when a new alert arrives.';

-- Alerts carry the match start time so the UI can show a countdown and the
-- client can tell a fresh pre-match alert from a stale one.
alter table public.kalshi_alerts
  add column if not exists starts_at timestamptz;

create index if not exists kalshi_alerts_starts_idx
  on public.kalshi_alerts (starts_at) where status = 'open';
