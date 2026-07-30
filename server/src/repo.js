import { t } from './config.js';
import { query } from './db.js';

/* ------------------------------------------------------------------ markets */

/**
 * Live markets joined to their model output.
 * `filter`: all | mispriced | inplay | rated
 */
export async function listMarkets({ filter = 'all', search = '', limit = 200 } = {}) {
  const r = await query(
    `select m.ticker, m.event_ticker, m.series_ticker, m.player_name, m.status,
            m.yes_bid_cents, m.yes_ask_cents, m.last_price_cents,
            m.yes_ask_size, m.volume, m.volume_24h, m.open_interest, m.liquidity,
            m.close_time, m.occurrence_datetime,
            e.matchup, e.tournament, e.round, e.tour_level,
            s.fair_cents, s.ev_pct, s.utr_gap, s.player_utr, s.opponent_utr,
            s.opponent_name, s.is_actionable,
            -- absolute edge in cents. Percentage EV explodes on cheap contracts
            -- (a 1c error on a 3c ask reads as +33%), so the UI ranks on this too.
            (s.fair_cents - s.market_cents) as edge_cents,
            (m.yes_ask_cents - m.yes_bid_cents) as spread_cents
     from ${t('markets')} m
     join ${t('events')} e using (event_ticker)
     left join ${t('signals')} s on s.ticker = m.ticker
     where m.status in ('active','open','initialized')
       and ($1 = '' or m.player_name ilike '%'||$1||'%'
                    or e.matchup ilike '%'||$1||'%'
                    or e.tournament ilike '%'||$1||'%'
                    or m.ticker ilike '%'||$1||'%')
       and case $2
             when 'mispriced' then coalesce(s.is_actionable, false)
             when 'rated'     then s.fair_cents is not null
             when 'inplay'    then m.occurrence_datetime <= now()
             else true
           end
     order by s.ev_pct desc nulls last, m.volume desc nulls last
     limit $3`,
    [search, filter, limit],
  );
  return r.rows;
}

export async function marketCount() {
  const r = await query(
    `select count(*)::int total,
            count(*) filter (where s.fair_cents is not null)::int priced,
            count(*) filter (where s.is_actionable)::int actionable
     from ${t('markets')} m
     left join ${t('signals')} s on s.ticker = m.ticker
     where m.status in ('active','open','initialized')`,
  );
  return r.rows[0];
}

export async function priceHistory(ticker, limit = 200) {
  const r = await query(
    `select mid_cents, yes_bid_cents, yes_ask_cents, last_price_cents, captured_at
     from ${t('price_history')} where ticker = $1
     order by captured_at desc limit $2`,
    [ticker, limit],
  );
  return r.rows.reverse();
}

/* ------------------------------------------------------------------- alerts */

export async function listAlerts({ status = 'open', limit = 50 } = {}) {
  const r = await query(
    `select a.*, m.yes_ask_size, m.volume, e.round, e.tour_level,
            (a.fair_cents - a.market_cents) as edge_cents,
            (m.yes_ask_cents - m.yes_bid_cents) as spread_cents,
            s.player_utr, s.opponent_utr, s.opponent_name
     from ${t('alerts')} a
     left join ${t('signals')} s on s.ticker = a.ticker
     left join ${t('markets')} m on m.ticker = a.ticker
     left join ${t('events')} e on e.event_ticker = a.event_ticker
     where ($1 = 'any' or a.status = $1)
     order by a.ev_pct desc nulls last, a.created_at desc
     limit $2`,
    [status, limit],
  );
  return r.rows;
}

export async function resolveAlert(id, status) {
  const r = await query(
    `update ${t('alerts')} set status = $2, resolved_at = now()
     where id = $1 and status = 'open' returning *`,
    [id, status],
  );
  return r.rows[0] ?? null;
}

export async function dismissAllAlerts() {
  const r = await query(
    `update ${t('alerts')} set status = 'dismissed', resolved_at = now()
     where status = 'open' returning id`,
  );
  return r.rowCount ?? 0;
}

export const getAlert = async id => {
  const r = await query(`select * from ${t('alerts')} where id = $1`, [id]);
  return r.rows[0] ?? null;
};

/* ------------------------------------------------------------------- trades */

export async function listTrades({ filter = 'all', limit = 200 } = {}) {
  const r = await query(
    `select * from ${t('trades')}
     where case $1
             when 'won'  then result = 'won'
             when 'lost' then result = 'lost'
             when 'open' then status in ('pending','filled','partial')
             else true
           end
     order by placed_at desc limit $2`,
    [filter, limit],
  );
  return r.rows;
}

export async function insertTrade(tr) {
  const r = await query(
    `insert into ${t('trades')}
       (kalshi_order_id, client_order_id, ticker, event_ticker, player_name, matchup,
        side, action, entry_cents, fair_cents, size_contracts, stake_usd, ev_pct,
        status, error, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [tr.kalshi_order_id ?? null, tr.client_order_id ?? null, tr.ticker, tr.event_ticker ?? null,
      tr.player_name ?? null, tr.matchup ?? null, tr.side ?? 'yes', tr.action ?? 'buy',
      tr.entry_cents ?? null, tr.fair_cents ?? null, tr.size_contracts ?? null,
      tr.stake_usd ?? null, tr.ev_pct ?? null, tr.status ?? 'pending',
      tr.error ?? null, tr.raw ? JSON.stringify(tr.raw) : null],
  );
  return r.rows[0];
}

/* ---------------------------------------------------------------- analytics */

/** Realised P&L per day, plus a running cumulative total. */
export async function pnlSeries(days = 30) {
  const r = await query(
    `with d as (
       select generate_series(
         (current_date - ($1::int - 1) * interval '1 day')::date,
         current_date, interval '1 day')::date as day
     )
     select d.day,
            coalesce(sum(tr.pnl_usd), 0)::numeric as pnl,
            count(tr.id)::int as trades
     from d
     left join ${t('trades')} tr
       on tr.placed_at::date = d.day and tr.status = 'settled'
     group by d.day order by d.day`,
    [days],
  );
  let cum = 0;
  return r.rows.map(x => {
    cum += Number(x.pnl);
    return { day: x.day, pnl: Number(x.pnl), cumulative: +cum.toFixed(2), trades: x.trades };
  });
}

export async function pnlByGapBucket() {
  const r = await query(
    `select case
              when abs(s.utr_gap) >= 2.0 then 'Δ2.0+'
              when abs(s.utr_gap) >= 1.5 then 'Δ1.5–1.9'
              when abs(s.utr_gap) >= 1.0 then 'Δ1.0–1.4'
              else 'Δ0.5–0.9'
            end as bucket,
            coalesce(sum(tr.pnl_usd), 0)::numeric as pnl,
            count(tr.id)::int as trades
     from ${t('trades')} tr
     join ${t('signals')} s on s.ticker = tr.ticker
     where tr.status = 'settled'
     group by bucket order by bucket`,
  );
  return r.rows.map(x => ({ ...x, pnl: Number(x.pnl) }));
}

export async function winRate() {
  const r = await query(
    `select count(*) filter (where result = 'won')::int  as won,
            count(*) filter (where result = 'lost')::int as lost,
            count(*) filter (where status = 'settled')::int as settled
     from ${t('trades')}`,
  );
  return r.rows[0];
}

/** Model-EV available per day — measured from signals actually recorded. */
export async function evCapturedPerDay(days = 30) {
  const r = await query(
    `with d as (
       select generate_series(
         (current_date - ($1::int - 1) * interval '1 day')::date,
         current_date, interval '1 day')::date as day
     )
     select d.day,
            coalesce(sum(tr.ev_pct * tr.stake_usd / 100.0), 0)::numeric as ev_usd,
            count(tr.id)::int as trades
     from d
     left join ${t('trades')} tr on tr.placed_at::date = d.day
     group by d.day order by d.day`,
    [days],
  );
  return r.rows.map(x => ({ day: x.day, ev_usd: Number(x.ev_usd), trades: x.trades }));
}

/* --------------------------------------------------------------- dashboard */

export async function overviewStats() {
  const [trades, snap, mkts, alerts] = await Promise.all([
    query(
      `select
         coalesce(sum(pnl_usd) filter (where status = 'settled'), 0)::numeric as realised_pnl,
         coalesce(sum(pnl_usd) filter (where status = 'settled'
           and placed_at >= current_date - interval '7 days'), 0)::numeric as pnl_7d,
         coalesce(sum(pnl_usd) filter (where status = 'settled'
           and placed_at::date = current_date), 0)::numeric as pnl_today,
         count(*) filter (where status in ('pending','filled','partial'))::int as open_positions,
         coalesce(sum(stake_usd) filter (where status in ('pending','filled','partial')), 0)::numeric as at_risk,
         count(*) filter (where status = 'settled')::int as settled,
         count(*) filter (where result = 'won')::int as won
       from ${t('trades')}`),
    query(`select balance_cents, open_positions from ${t('portfolio_snapshots')}
           order by captured_at desc limit 1`),
    marketCount(),
    query(`select count(*)::int n from ${t('alerts')} where status = 'open'`),
  ]);

  const tr = trades.rows[0];
  const settled = tr.settled;
  return {
    balance_cents: snap.rows[0]?.balance_cents ?? null,
    realised_pnl: Number(tr.realised_pnl),
    pnl_7d: Number(tr.pnl_7d),
    pnl_today: Number(tr.pnl_today),
    open_positions: tr.open_positions,
    at_risk: Number(tr.at_risk),
    settled,
    won: tr.won,
    hit_rate: settled > 0 ? Math.round((tr.won / settled) * 100) : null,
    markets: mkts,
    open_alerts: alerts.rows[0].n,
  };
}

/* ----------------------------------------------------------------- settings */

export async function getSettings() {
  const r = await query(`select * from ${t('settings')} where id = 1`);
  return r.rows[0];
}

const SETTABLE = new Set([
  'min_ev_threshold', 'stake_per_trade', 'max_exposure_per_match', 'min_utr_gap',
  'manual_approval', 'sweep_full_volume', 'pushover_enabled', 'sms_fallback',
  'inplay_enabled', 'bot_enabled',
]);

export async function updateSettings(patch) {
  const keys = Object.keys(patch).filter(k => SETTABLE.has(k));
  if (!keys.length) return getSettings();

  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const r = await query(
    `update ${t('settings')} set ${sets}, updated_at = now() where id = 1 returning *`,
    keys.map(k => patch[k]),
  );
  return r.rows[0];
}

/* --------------------------------------------------------------- sync state */

/**
 * The last *settled* sync run, plus whether one is in flight.
 *
 * A run is inserted with status 'running' and zeroed counters before it does any
 * work, so reporting the newest row would make the UI flip to "sync pending ·
 * 0 markets" on every poll. The desk should show the last known good state.
 */
export async function lastSync() {
  const [settled, running] = await Promise.all([
    query(
      `select id, started_at, finished_at, status, markets_seen, signals_computed,
              alerts_created, latency_ms, error
       from ${t('sync_runs')} where finished_at is not null
       order by finished_at desc limit 1`),
    query(
      `select count(*)::int n from ${t('sync_runs')}
       where status = 'running' and started_at > now() - interval '5 minutes'`),
  ]);

  const row = settled.rows[0] ?? null;
  return row ? { ...row, syncing: running.rows[0].n > 0 } : { syncing: running.rows[0].n > 0, status: null };
}

export async function ratingsSummary() {
  const r = await query(
    `select count(*)::int total,
            count(*) filter (where utr is not null and utr_status = 'Rated')::int usable,
            count(*) filter (where lookup_attempted_at is null)::int pending
     from ${t('players')}`,
  );
  return r.rows[0];
}
