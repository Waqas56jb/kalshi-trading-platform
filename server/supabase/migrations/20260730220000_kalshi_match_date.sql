-- Match date, parsed from the Kalshi ticker (KXITFMATCH-26JUL30... -> 2026-07-30).
-- The only timing Kalshi gets right: occurrence_datetime is its expiry estimate and
-- ran 4h33m past the real start on a checked match, but the ticker's date agreed
-- with it on 366 of 400 sampled markets.
alter table public.kalshi_markets add column if not exists match_date date;
create index if not exists kalshi_markets_match_date_idx on public.kalshi_markets (match_date);
