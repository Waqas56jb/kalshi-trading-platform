-- ============================================================================
-- Desk accounts.
--
-- Until now the login screen accepted anything and every API route was open,
-- which meant /api/alerts/:id/execute could place a real order for anyone who
-- found the URL. These are real credentials, and the API is gated behind them.
--
-- Passwords are never stored. `password_hash` holds a self-describing scrypt
-- digest (algorithm, cost parameters, salt and hash), so the cost can be raised
-- later without invalidating existing rows.
-- ============================================================================

create table if not exists public.kalshi_users (
  id             bigserial primary key,
  email          text not null,
  password_hash  text not null,
  name           text,
  role           text not null default 'trader' check (role in ('admin', 'trader')),
  is_active      boolean not null default true,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- case-insensitive uniqueness without requiring the citext extension
create unique index if not exists kalshi_users_email_uidx
  on public.kalshi_users (lower(email));

create index if not exists kalshi_users_active_idx
  on public.kalshi_users (is_active) where is_active;

drop trigger if exists kalshi_users_touch on public.kalshi_users;
create trigger kalshi_users_touch
  before update on public.kalshi_users
  for each row execute function public.kalshi_touch_updated_at();

alter table public.kalshi_users enable row level security;

-- Audit trail for sign-ins and account changes. Useful on a trading desk, where
-- knowing who changed a threshold or placed an order matters.
create table if not exists public.kalshi_auth_events (
  id          bigserial primary key,
  user_id     bigint references public.kalshi_users(id) on delete set null,
  email       text,
  event       text not null,      -- login_ok / login_failed / created / updated / deleted
  detail      text,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists kalshi_auth_events_time_idx
  on public.kalshi_auth_events (created_at desc);
create index if not exists kalshi_auth_events_user_idx
  on public.kalshi_auth_events (user_id, created_at desc);

alter table public.kalshi_auth_events enable row level security;
