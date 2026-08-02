-- Oversized alert-path fills (flat stake_per_trade ~$250) stay in the ledger
-- for audit, but Overview P&L charts them as if they were risk-engine ~$20 bets.
alter table public.kalshi_trades
  add column if not exists reporting_stake_usd numeric(12,2),
  add column if not exists sizing_note text;

comment on column public.kalshi_trades.reporting_stake_usd is
  'When set, desk P&L charts scale pnl_usd by reporting_stake_usd/stake_usd. Audit stake stays in stake_usd.';
comment on column public.kalshi_trades.sizing_note is
  'e.g. alert_path_flat_stake — placed via the retired Alerts button that ignored the risk engine.';

-- Tag the known oversized alert-path names and any other clear $100+ fills
-- from that era. Does not archive them; history stays visible with the tag.
update public.kalshi_trades
set reporting_stake_usd = 20,
    sizing_note = 'alert_path_flat_stake'
where archived_at is null
  and coalesce(stake_usd, 0) > 40
  and (
    player_name ilike '%slavikova%'
    or player_name ilike '%milanese%'
    or coalesce(stake_usd, 0) >= 100
  );
