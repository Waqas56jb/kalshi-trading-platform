import { t } from './config.js';
import { query } from './db.js';

/**
 * Awaits an array of query thunks one at a time.
 *
 * Deliberately not Promise.all: the Supabase session pooler permits 15 clients
 * across the whole project, and parallel fan-out inside a request that is itself
 * fanned out exhausted it (EMAXCONNSESSION). One connection at a time per
 * request is the safe shape.
 */
async function series(thunks) {
  const out = [];
  for (const fn of thunks) out.push(await fn());
  return out;
}

/* ------------------------------------------------------------------ markets */

/**
 * Live markets joined to their model output.
 * `filter`: all | mispriced | inplay | rated
 */
export async function listMarkets({ filter = 'all', search = '', limit = 200, sort = 'edge' } = {}) {
  const r = await query(
    `select m.ticker, m.event_ticker, m.series_ticker, m.player_name, m.status,
            m.yes_bid_cents, m.yes_ask_cents, m.last_price_cents,
            m.yes_ask_size, m.volume, m.volume_24h, m.open_interest, m.liquidity,
            m.close_time, m.occurrence_datetime, m.match_date,
            m.play_state, m.volume_growth_3h,
            e.matchup, e.tournament, e.round, e.tour_level,
            e.scheduled_at, e.schedule_confidence, e.schedule_source,
            s.fair_cents, s.ev_pct, s.utr_gap, s.player_utr, s.opponent_utr,
            s.opponent_name, s.is_actionable, s.side_type,
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
       /* Default view hides days that have already passed. Kalshi keeps a market
          'active' for up to two weeks after the match while it waits to settle, so
          without this the table filled with yesterday's finished matches. The match
          day comes from the ticker, which is the only timing Kalshi gets right. */
       and case $2
             when 'mispriced' then coalesce(s.is_actionable, false)
             when 'rated'     then s.fair_cents is not null
             when 'inplay'    then m.play_state = 'in_play'
             when 'favourite' then s.side_type = 'favourite'
             when 'underdog'  then s.side_type = 'underdog'
             when 'upcoming'  then m.play_state = 'not_started'
                                    and coalesce(m.match_date, current_date)
                                        >= (now() at time zone 'America/Los_Angeles')::date
             when 'all'       then coalesce(m.match_date, current_date)
                                    >= (now() at time zone 'America/Los_Angeles')::date
             else true
           end
     order by
       case when $4 = 'starts' then m.match_date end asc nulls last,
       case when $4 = 'starts' then m.occurrence_datetime end asc nulls last,
       case when $4 = 'edge'   then (s.fair_cents - s.market_cents) end desc nulls last,
       case when $4 = 'ev'     then s.ev_pct end desc nulls last,
       m.volume desc nulls last
     limit $3`,
    [search, filter, limit, sort],
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

/**
 * Closes open alerts whose match has begun.
 *
 * Run on every read rather than only during a sync. Kalshi's
 * `occurrence_datetime` is a half-hour scheduling slot, not the first serve, and
 * on Vercel's Hobby plan cron fires once a day — so relying on the sync to expire
 * alerts left in-play matches sitting in the queue for hours. Because the slot is
 * the *earliest* a match can start, treating it as the cut-off errs towards
 * dropping a still-upcoming alert rather than showing one that is already live,
 * which is the direction the desk wants.
 */
export async function expireStartedAlerts() {
  const r = await query(
    `with cfg as (select prematch_only, alert_lead_minutes from ${t('settings')} where id = 1)
     update ${t('alerts')} a set status = 'expired', resolved_at = now()
     from cfg
     where a.status = 'open' and cfg.prematch_only
       and (
         a.starts_at is null
         or a.starts_at <= now() + make_interval(mins => cfg.alert_lead_minutes)
       )
     returning a.id`,
  );
  return r.rowCount ?? 0;
}

export async function listAlerts({ status = 'open', side = 'all', limit = 50 } = {}) {
  // never hand back an alert whose match has started, whatever the sync did
  if (status === 'open') await expireStartedAlerts().catch(() => {});

  const r = await query(
    `select a.*, m.yes_ask_size, m.volume, e.round, e.tour_level,
            e.scheduled_at, e.schedule_confidence,
            m.occurrence_datetime as market_starts_at,
            (a.fair_cents - a.market_cents) as edge_cents,
            (m.yes_ask_cents - m.yes_bid_cents) as spread_cents,
            s.player_utr, s.opponent_utr, s.opponent_name
     from ${t('alerts')} a
     left join ${t('signals')} s on s.ticker = a.ticker
     left join ${t('markets')} m on m.ticker = a.ticker
     left join ${t('events')} e on e.event_ticker = a.event_ticker
     where ($1 = 'any' or a.status = $1)
       -- belt and braces: even a row the update above missed cannot surface
       and ($1 <> 'open' or a.starts_at is null or a.starts_at > now())
       and ($3 = 'all' or a.side_type = $3)
     order by (a.fair_cents - a.market_cents) desc nulls last, a.ev_pct desc nulls last
     limit $2`,
    [status, limit, side],
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
     where archived_at is null and case $1
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
        status, error, raw, mode, filled_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     returning *`,
    [tr.kalshi_order_id ?? null, tr.client_order_id ?? null, tr.ticker, tr.event_ticker ?? null,
      tr.player_name ?? null, tr.matchup ?? null, tr.side ?? 'yes', tr.action ?? 'buy',
      tr.entry_cents ?? null, tr.fair_cents ?? null, tr.size_contracts ?? null,
      tr.stake_usd ?? null, tr.ev_pct ?? null, tr.status ?? 'pending',
      tr.error ?? null, tr.raw ? JSON.stringify(tr.raw) : null,
      tr.mode ?? 'live', tr.filled_at ?? null],
  );
  return r.rows[0];
}

/**
 * Settles filled positions whose Kalshi market has resolved.
 *
 * The outcome comes from Kalshi's own `result` on the market, so a paper P&L is
 * computed from what actually happened on court — only the order was simulated.
 * A YES contract pays $1 if it wins and $0 if it loses.
 */
export async function settleResolvedTrades(kalshi, { limit = 40 } = {}) {
  const open = await query(
    `select distinct on (tr.ticker) tr.id, tr.ticker, tr.side, tr.entry_cents, tr.size_contracts
     from ${t('trades')} tr
     where tr.archived_at is null and tr.status in ('filled','partial') and tr.result is null
     order by tr.ticker, tr.id
     limit $1`, [limit]);

  let settled = 0;
  const errors = [];

  for (const row of open.rows) {
    let market;
    try {
      const r = await kalshi.getMarket(row.ticker);
      market = r?.market ?? r;
    } catch (e) {
      errors.push(`${row.ticker}: ${e.message.slice(0, 80)}`);
      continue;
    }
    const status = market?.status;
    const result = market?.result;
    if (!result || !['settled', 'finalized', 'closed'].includes(status)) continue;   // still live

    // YES pays 100c on 'yes'; NO pays 100c on 'no'
    const won = (row.side === 'yes' && result === 'yes') || (row.side === 'no' && result === 'no');
    const payoutCents = won ? 100 : 0;
    const size = Number(row.size_contracts ?? 0);
    const pnl = ((payoutCents - Number(row.entry_cents ?? 0)) * size) / 100;

    const upd = await query(
      `update ${t('trades')} set status = 'settled', result = $2, settle_result = $3,
         settled_price_cents = $4, pnl_usd = $5, settled_at = now()
       where ticker = $1 and status in ('filled','partial') and result is null
       returning id`,
      [row.ticker, won ? 'won' : 'lost', result, payoutCents, pnl.toFixed(2)],
    );
    settled += upd.rowCount ?? 0;
  }

  return { checked: open.rowCount ?? 0, settled, errors: errors.slice(0, 5) };
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
       and tr.archived_at is null
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
     where tr.archived_at is null and tr.status = 'settled'
     group by bucket order by bucket`,
  );
  return r.rows.map(x => ({ ...x, pnl: Number(x.pnl) }));
}

export async function winRate() {
  const r = await query(
    `select count(*) filter (where result = 'won')::int  as won,
            count(*) filter (where result = 'lost')::int as lost,
            count(*) filter (where status = 'settled')::int as settled
     from ${t('trades')} where archived_at is null`,
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

/**
 * Runs its queries one after another rather than in parallel.
 *
 * Supabase's session pooler allows 15 clients in total. Fanning four queries out
 * concurrently here, under a route that itself fans out, made a single dashboard
 * load ask for eight connections and hit EMAXCONNSESSION. Sequential costs a
 * little latency and cannot exhaust the pooler.
 */
export async function overviewStats() {
  const [trades, snap, mkts, alerts] = await series([
    () => query(
      `select
         coalesce(sum(pnl_usd) filter (where status = 'settled'), 0)::numeric as realised_pnl,
         coalesce(sum(pnl_usd) filter (where status = 'settled'
           and placed_at >= current_date - interval '7 days'), 0)::numeric as pnl_7d,
         coalesce(sum(pnl_usd) filter (where status = 'settled'
           and placed_at::date = current_date), 0)::numeric as pnl_today,
         count(*) filter (where status in ('pending','filled','partial'))::int as open_positions,
         coalesce(sum(stake_usd) filter (where status in ('pending','filled','partial')), 0)::numeric as at_risk,
         -- voids are neither wins nor losses; counting them made 1 win in 47
         -- read as a 2% hit rate when the real figure is over decided trades only
         count(*) filter (where result in ('won','lost'))::int as settled,
         count(*) filter (where result = 'won')::int as won,
         count(*) filter (where result = 'void')::int as void
       from ${t('trades')} where archived_at is null`),
    () => query(`select balance_cents, open_positions, captured_at from ${t('portfolio_snapshots')}
           order by captured_at desc limit 1`),
    () => marketCount(),
    () => query(`select count(*)::int n from ${t('alerts')} where status = 'open'`),
  ]);

  /* Desk metrics that exist from the first sync, before any trade has settled.
     Without these the dashboard is four em-dashes on a brand-new install even
     though hundreds of real markets are being priced. */
  const desk = await query(
    `select
       coalesce(sum(greatest(s.fair_cents - s.market_cents, 0)) filter (where s.is_actionable), 0)::int as edge_cents_available,
       coalesce(max(s.fair_cents - s.market_cents) filter (where s.is_actionable), 0)::int as best_edge_cents,
       coalesce(round(avg(s.ev_pct) filter (where s.is_actionable), 1), 0)::numeric as avg_actionable_ev,
       count(*) filter (where s.is_actionable)::int as actionable
     from ${t('signals')} s
     join ${t('markets')} m on m.ticker = s.ticker
     where m.status in ('active','open','initialized')`);

  const tr = trades.rows[0];
  const settled = tr.settled;
  return {
    balance_cents: snap.rows[0]?.balance_cents ?? null,
    balance_at: snap.rows[0]?.captured_at ?? null,
    /* From the exchange, not our ledger: the client trades this account
       outside the desk too, so these are the figures that actually matter. */
    kalshi_exposure_cents: snap.rows[0]?.exposure_cents ?? null,
    kalshi_realised_cents: snap.rows[0]?.realized_pnl_cents ?? null,
    kalshi_open_positions: snap.rows[0]?.open_positions ?? null,
    realised_pnl: Number(tr.realised_pnl),
    pnl_7d: Number(tr.pnl_7d),
    pnl_today: Number(tr.pnl_today),
    open_positions: tr.open_positions,
    at_risk: Number(tr.at_risk),
    settled,
    won: tr.won,
    void: tr.void,
    hit_rate: settled > 0 ? Math.round((tr.won / settled) * 100) : null,
    markets: mkts,
    open_alerts: alerts.rows[0].n,
    desk: {
      edge_cents_available: desk.rows[0].edge_cents_available,
      best_edge_cents: desk.rows[0].best_edge_cents,
      avg_actionable_ev: Number(desk.rows[0].avg_actionable_ev),
      actionable: desk.rows[0].actionable,
    },
  };
}

/**
 * Signals grouped by UTR gap. Unlike the P&L-by-bucket view this needs no
 * settled trades, so the analytics page has real content from day one.
 */
export async function signalsByGapBucket() {
  const r = await query(
    `select case
              when abs(s.utr_gap) >= 2.0 then 'Δ2.0+'
              when abs(s.utr_gap) >= 1.5 then 'Δ1.5–1.9'
              when abs(s.utr_gap) >= 1.0 then 'Δ1.0–1.4'
              when abs(s.utr_gap) >= 0.5 then 'Δ0.5–0.9'
              else 'Δ0–0.4'
            end as bucket,
            count(*)::int as signals,
            count(*) filter (where s.is_actionable)::int as actionable,
            coalesce(round(avg(s.fair_cents - s.market_cents), 1), 0)::numeric as avg_edge_cents
     from ${t('signals')} s
     join ${t('markets')} m on m.ticker = s.ticker
     where m.status in ('active','open','initialized')
     group by bucket order by bucket`);
  return r.rows.map(x => ({ ...x, avg_edge_cents: Number(x.avg_edge_cents) }));
}

/** Edge the model has surfaced per day, measured from recorded signals. */
export async function edgeFoundPerDay(days = 30) {
  const r = await query(
    `with d as (
       select generate_series(
         (current_date - ($1::int - 1) * interval '1 day')::date,
         current_date, interval '1 day')::date as day
     )
     select d.day,
            count(a.id)::int as alerts,
            coalesce(sum(greatest(a.fair_cents - a.market_cents, 0)), 0)::int as edge_cents
     from d
     left join ${t('alerts')} a on a.created_at::date = d.day
     group by d.day order by d.day`, [days]);
  return r.rows;
}

/** Split of markets the model can and cannot price — explains coverage gaps. */
export async function pricingCoverage() {
  const r = await query(
    `select
       count(*)::int as total,
       count(s.ticker)::int as priced,
       count(*) filter (where s.is_actionable)::int as actionable
     from ${t('markets')} m
     left join ${t('signals')} s on s.ticker = m.ticker
     where m.status in ('active','open','initialized')`);
  return r.rows[0];
}

/* ----------------------------------------------------------------- settings */

export async function getSettings() {
  const r = await query(`select * from ${t('settings')} where id = 1`);
  return r.rows[0];
}

const SETTABLE = new Set([
  'min_ev_threshold', 'stake_per_trade', 'max_exposure_per_match', 'min_utr_gap',
  'manual_approval', 'sweep_full_volume', 'pushover_enabled', 'sms_fallback',
  'inplay_enabled', 'bot_enabled', 'paper_trading',
  'min_bid_cents', 'max_spread_cents', 'max_edge_cents', 'inplay_volume_threshold',
  'prematch_only', 'alert_lead_minutes', 'alert_max_hours', 'sound_enabled',
  'display_timezone', 'odds_divergence_cents', 'odds_alerts_enabled',
  'min_edge_cents', 'auto_sell_at_fair', 'auto_sell_buffer_cents',
  'take_profit_enabled', 'take_profit_pct', 'stop_loss_enabled', 'stop_loss_pct',
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
  const [settled, running] = await series([
    () => query(
      `select id, started_at, finished_at, status, markets_seen, signals_computed,
              alerts_created, latency_ms, error
       from ${t('sync_runs')} where finished_at is not null
       order by finished_at desc limit 1`),
    () => query(
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
