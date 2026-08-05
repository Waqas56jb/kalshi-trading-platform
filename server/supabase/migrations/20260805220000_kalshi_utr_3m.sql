-- 3-month / 90-day rolling UTR from utrsports search (threeMonthRating).
-- Desk formula (Robbie/Max Aug 5): fair gap uses 50% singles + 50% this field.
alter table public.kalshi_players
  add column if not exists utr_3m numeric(5,2);
