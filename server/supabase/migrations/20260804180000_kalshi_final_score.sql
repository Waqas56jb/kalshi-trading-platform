-- Match scores for settled tickets (display on Trade history).
alter table public.kalshi_markets
  add column if not exists final_score  text,
  add column if not exists score_source text;

comment on column public.kalshi_markets.final_score is
  'Set score after the match, e.g. 6-4 6-3. Enrichment — Kalshi only gives yes/no.';

alter table public.kalshi_match_schedule
  add column if not exists final_score text;
