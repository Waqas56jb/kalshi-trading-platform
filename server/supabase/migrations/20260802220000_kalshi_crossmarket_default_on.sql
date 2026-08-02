-- The client's explicit instruction (2 Aug 2026): sportsbook confirmation is
-- ON by default. Every entry must be confirmed by the book consensus; matches
-- the books have not priced are declined rather than assumed fine.
alter table public.kalshi_settings
  alter column cross_market_enabled set default true;

update public.kalshi_settings set cross_market_enabled = true where id = 1;
