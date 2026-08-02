-- The manual alert path used stake_per_trade (default $250) and bypassed the
-- risk engine's per-bet cap. Align the setting with the ordinary per-bet size
-- on a $10k bankroll with 60% cash reserve (~$20).
update public.kalshi_settings
set stake_per_trade = 20
where id = 1 and stake_per_trade >= 100;

alter table public.kalshi_settings
  alter column stake_per_trade set default 20;
