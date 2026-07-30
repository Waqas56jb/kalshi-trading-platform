import { config, t } from './config.js';
import { query, tx } from './db.js';
import {
  buildSignalsForEvent, dollarsToCents, parseMarketTitle, toNum,
} from './model.js';

/** Normalises one raw Kalshi market row into our column shape. */
function normalise(raw) {
  const parsed = parseMarketTitle(raw.title || '', raw.rules_primary || '');
  return {
    ticker: raw.ticker,
    event_ticker: raw.event_ticker,
    series_ticker: (raw.ticker || '').split('-')[0],
    competitor_id: raw.custom_strike?.tennis_competitor ?? null,
    player_name: raw.yes_sub_title || parsed.player || null,
    title: raw.title ?? null,
    status: raw.status ?? null,
    yes_bid_cents: dollarsToCents(raw.yes_bid_dollars),
    yes_ask_cents: dollarsToCents(raw.yes_ask_dollars),
    no_bid_cents: dollarsToCents(raw.no_bid_dollars),
    no_ask_cents: dollarsToCents(raw.no_ask_dollars),
    last_price_cents: dollarsToCents(raw.last_price_dollars),
    yes_bid_size: toNum(raw.yes_bid_size_fp),
    yes_ask_size: toNum(raw.yes_ask_size_fp),
    volume: toNum(raw.volume_fp),
    volume_24h: toNum(raw.volume_24h_fp),
    open_interest: toNum(raw.open_interest_fp),
    liquidity: toNum(raw.liquidity_dollars),
    close_time: raw.close_time ?? null,
    occurrence_datetime: raw.occurrence_datetime ?? null,
    parsed,
    raw,
  };
}

async function upsertPlayers(client, rows) {
  const byId = new Map();
  for (const r of rows) {
    if (r.competitor_id && r.player_name) byId.set(r.competitor_id, r.player_name);
  }
  if (!byId.size) return 0;

  const ids = [...byId.keys()];
  const names = ids.map(id => byId.get(id));
  // never overwrite an imported UTR — only the display name
  await client.query(
    `insert into ${t('players')} (competitor_id, name)
     select * from unnest($1::text[], $2::text[])
     on conflict (competitor_id) do update set name = excluded.name`,
    [ids, names],
  );
  return ids.length;
}

async function upsertEvents(client, rows) {
  const byEvent = new Map();
  for (const r of rows) {
    if (!byEvent.has(r.event_ticker)) byEvent.set(r.event_ticker, r);
  }
  const list = [...byEvent.values()];
  if (!list.length) return 0;

  await client.query(
    `insert into ${t('events')}
       (event_ticker, series_ticker, title, matchup, tournament, round, tour_level,
        occurrence_datetime, close_time, status, raw)
     select * from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
       $8::timestamptz[], $9::timestamptz[], $10::text[], $11::jsonb[])
     on conflict (event_ticker) do update set
       title = excluded.title, matchup = excluded.matchup,
       tournament = excluded.tournament, round = excluded.round,
       tour_level = excluded.tour_level,
       occurrence_datetime = excluded.occurrence_datetime,
       close_time = excluded.close_time, status = excluded.status`,
    [
      list.map(r => r.event_ticker),
      list.map(r => r.series_ticker),
      list.map(r => r.parsed.matchup ? `${r.parsed.matchup}${r.parsed.tournament ? ': ' + r.parsed.tournament : ''}` : r.title),
      list.map(r => r.parsed.matchup),
      list.map(r => r.parsed.tournament),
      list.map(r => r.parsed.round),
      list.map(r => r.parsed.tourLevel),
      list.map(r => r.occurrence_datetime),
      list.map(r => r.close_time),
      list.map(r => r.status),
      list.map(r => JSON.stringify({ event_ticker: r.event_ticker, series: r.series_ticker })),
    ],
  );
  return list.length;
}

async function upsertMarkets(client, rows) {
  if (!rows.length) return 0;
  const col = f => rows.map(f);
  await client.query(
    `insert into ${t('markets')}
       (ticker, event_ticker, series_ticker, competitor_id, player_name, title, status,
        yes_bid_cents, yes_ask_cents, no_bid_cents, no_ask_cents, last_price_cents,
        yes_bid_size, yes_ask_size, volume, volume_24h, open_interest, liquidity,
        close_time, occurrence_datetime, raw, updated_at)
     select *, now() from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
       $8::int[], $9::int[], $10::int[], $11::int[], $12::int[],
       $13::numeric[], $14::numeric[], $15::numeric[], $16::numeric[], $17::numeric[], $18::numeric[],
       $19::timestamptz[], $20::timestamptz[], $21::jsonb[])
     on conflict (ticker) do update set
       event_ticker = excluded.event_ticker, series_ticker = excluded.series_ticker,
       competitor_id = excluded.competitor_id, player_name = excluded.player_name,
       title = excluded.title, status = excluded.status,
       yes_bid_cents = excluded.yes_bid_cents, yes_ask_cents = excluded.yes_ask_cents,
       no_bid_cents = excluded.no_bid_cents, no_ask_cents = excluded.no_ask_cents,
       last_price_cents = excluded.last_price_cents,
       yes_bid_size = excluded.yes_bid_size, yes_ask_size = excluded.yes_ask_size,
       volume = excluded.volume, volume_24h = excluded.volume_24h,
       open_interest = excluded.open_interest, liquidity = excluded.liquidity,
       close_time = excluded.close_time, occurrence_datetime = excluded.occurrence_datetime,
       raw = excluded.raw, updated_at = now()`,
    [
      col(r => r.ticker), col(r => r.event_ticker), col(r => r.series_ticker),
      col(r => r.competitor_id), col(r => r.player_name), col(r => r.title), col(r => r.status),
      col(r => r.yes_bid_cents), col(r => r.yes_ask_cents), col(r => r.no_bid_cents),
      col(r => r.no_ask_cents), col(r => r.last_price_cents),
      col(r => r.yes_bid_size), col(r => r.yes_ask_size), col(r => r.volume),
      col(r => r.volume_24h), col(r => r.open_interest), col(r => r.liquidity),
      col(r => r.close_time), col(r => r.occurrence_datetime),
      col(r => JSON.stringify(r.raw)),
    ],
  );
  return rows.length;
}

/** Only records a tick when the quote actually moved, so history stays meaningful. */
async function recordPriceHistory(client, rows) {
  const withPrice = rows.filter(r => r.yes_bid_cents != null || r.yes_ask_cents != null);
  if (!withPrice.length) return 0;

  const mid = r => (r.yes_bid_cents != null && r.yes_ask_cents != null
    ? Math.round((r.yes_bid_cents + r.yes_ask_cents) / 2)
    : r.last_price_cents ?? r.yes_ask_cents ?? r.yes_bid_cents);

  const res = await client.query(
    `with incoming as (
       select * from unnest($1::text[], $2::int[], $3::int[], $4::int[], $5::int[], $6::numeric[])
         as x(ticker, yes_bid_cents, yes_ask_cents, mid_cents, last_price_cents, volume)
     ),
     latest as (
       select distinct on (ph.ticker) ph.ticker, ph.yes_bid_cents, ph.yes_ask_cents, ph.volume
       from ${t('price_history')} ph
       where ph.ticker = any($1::text[])
       order by ph.ticker, ph.captured_at desc
     )
     insert into ${t('price_history')}
       (ticker, yes_bid_cents, yes_ask_cents, mid_cents, last_price_cents, volume)
     select i.ticker, i.yes_bid_cents, i.yes_ask_cents, i.mid_cents, i.last_price_cents, i.volume
     from incoming i
     left join latest l on l.ticker = i.ticker
     where l.ticker is null
        or l.yes_bid_cents is distinct from i.yes_bid_cents
        or l.yes_ask_cents is distinct from i.yes_ask_cents
        or l.volume is distinct from i.volume`,
    [
      withPrice.map(r => r.ticker), withPrice.map(r => r.yes_bid_cents),
      withPrice.map(r => r.yes_ask_cents), withPrice.map(mid),
      withPrice.map(r => r.last_price_cents), withPrice.map(r => r.volume),
    ],
  );
  return res.rowCount ?? 0;
}

async function computeSignals(client, rows, settings) {
  const ids = [...new Set(rows.map(r => r.competitor_id).filter(Boolean))];
  const players = new Map();
  if (ids.length) {
    const p = await client.query(
      `select competitor_id, name, utr from ${t('players')} where competitor_id = any($1::text[])`, [ids]);
    for (const r of p.rows) players.set(r.competitor_id, r);
  }

  const byEvent = new Map();
  for (const r of rows) {
    if (!byEvent.has(r.event_ticker)) byEvent.set(r.event_ticker, []);
    byEvent.get(r.event_ticker).push(r);
  }

  const signals = [];
  for (const ms of byEvent.values()) signals.push(...buildSignalsForEvent(ms, players));
  const rated = signals.filter(s => s.fair_cents != null && s.market_cents != null);
  if (!rated.length) return { computed: 0, actionable: 0 };

  const minEv = Number(settings.min_ev_threshold);
  const minGap = Number(settings.min_utr_gap);
  const minBid = Number(settings.min_bid_cents ?? 5);
  const maxSpread = Number(settings.max_spread_cents ?? 12);
  const maxEdge = Number(settings.max_edge_cents ?? 25);
  const prematchOnly = settings.prematch_only !== false;
  const leadMs = Number(settings.alert_lead_minutes ?? 10) * 60_000;
  const maxAheadMs = Number(settings.alert_max_hours ?? 72) * 3_600_000;
  const now = Date.now();

  const byTicker = new Map(rows.map(r => [r.ticker, r]));

  /**
   * Decides whether a priced signal is safe to act on, and records why not.
   *
   * The market is treated as the better-informed party when it disagrees
   * violently: a ratings model cannot see a withdrawal, an injury or a
   * retirement, and those are exactly what a 0/1c quote against a strong
   * favourite looks like.
   */
  const review = s => {
    const m = byTicker.get(s.ticker);
    const bid = m?.yes_bid_cents ?? null;
    const ask = m?.yes_ask_cents ?? null;
    const edge = s.fair_cents - s.market_cents;

    if (s.ev_pct == null || s.ev_pct < minEv) return 'below_ev_threshold';
    if (Math.abs(s.utr_gap ?? 0) < minGap) return 'utr_gap_too_small';
    if (bid == null || bid < minBid) return 'no_real_bid';
    if (ask != null && bid != null && ask - bid > maxSpread) return 'spread_too_wide';
    if (edge > maxEdge) return 'market_disagrees_strongly';

    /* Pre-match window. The model prices form on paper, not what is happening on
       court, so an in-play quote is not something it can reason about. The lead
       time keeps out alerts that arrive too late to act on. */
    if (prematchOnly) {
      /* A near-certain quote is itself evidence the match is under way or already
         decided: those prices do not occur before a ball is struck. This matters
         because `occurrence_datetime` is only a half-hour scheduling slot — ITF
         start times slip — so the clock alone cannot be trusted to tell pre-match
         from in-play. */
      if (bid != null && (bid <= 2 || bid >= 97)) return 'price_implies_in_play';

      const startsAt = m?.occurrence_datetime ? new Date(m.occurrence_datetime).getTime() : null;
      if (startsAt == null) return 'no_start_time';
      if (startsAt - now < leadMs) return 'started_or_too_close';
      if (startsAt - now > maxAheadMs) return 'too_far_ahead';
    }
    return null;                                     // actionable
  };

  for (const s of rated) s.review_reason = review(s);
  const col = f => rated.map(f);

  await client.query(
    `insert into ${t('signals')}
       (ticker, event_ticker, player_name, opponent_name, player_utr, opponent_utr,
        utr_gap, fair_cents, market_cents, ev_pct, model, is_actionable, review_reason, computed_at)
     select *, now() from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[],
       $7::numeric[], $8::int[], $9::int[], $10::numeric[], $11::text[], $12::boolean[], $13::text[])
     on conflict (ticker) do update set
       event_ticker = excluded.event_ticker, player_name = excluded.player_name,
       opponent_name = excluded.opponent_name, player_utr = excluded.player_utr,
       opponent_utr = excluded.opponent_utr, utr_gap = excluded.utr_gap,
       fair_cents = excluded.fair_cents, market_cents = excluded.market_cents,
       ev_pct = excluded.ev_pct, model = excluded.model,
       is_actionable = excluded.is_actionable, review_reason = excluded.review_reason,
       computed_at = now()`,
    [
      col(s => s.ticker), col(s => s.event_ticker), col(s => s.player_name),
      col(s => s.opponent_name), col(s => s.player_utr), col(s => s.opponent_utr),
      col(s => s.utr_gap), col(s => s.fair_cents), col(s => s.market_cents),
      col(s => s.ev_pct), col(s => s.model),
      col(s => s.review_reason === null),
      col(s => s.review_reason),
    ],
  );

  /* Signals whose market was not in this batch are stale.
     The sync only fetches open markets, so a ticker that stops appearing has
     closed or settled. Leaving its old flags in place kept decided matches in the
     actionable queue indefinitely — that is how a 0/1c quote on a finished match
     survived every guard. */
  const stale = await client.query(
    `update ${t('signals')} set is_actionable = false, review_reason = 'market_no_longer_open',
       computed_at = now()
     where is_actionable and ticker <> all($1::text[])
     returning ticker`,
    [rows.map(r => r.ticker)],
  );

  const counts = {};
  for (const s of rated) {
    const k = s.review_reason ?? 'actionable';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  if (stale.rowCount) counts.market_no_longer_open = stale.rowCount;

  return {
    computed: rated.length,
    actionable: rated.filter(s => s.review_reason === null).length,
    staled: stale.rowCount ?? 0,
    reasons: counts,
  };
}

/** Opens alerts for newly actionable signals; expires ones that no longer qualify. */
async function reconcileAlerts(client, settings) {
  const created = await client.query(
    `insert into ${t('alerts')}
       (ticker, event_ticker, player_name, matchup, tournament, utr_gap,
        fair_cents, market_cents, ev_pct, volume_available, starts_at)
     select s.ticker, s.event_ticker, s.player_name, e.matchup, e.tournament, s.utr_gap,
            s.fair_cents, s.market_cents, s.ev_pct, m.yes_ask_size, m.occurrence_datetime
     from ${t('signals')} s
     join ${t('markets')} m on m.ticker = s.ticker
     left join ${t('events')} e on e.event_ticker = s.event_ticker
     where s.is_actionable
       and m.status in ('active','open','initialized')
       and not exists (
         select 1 from ${t('alerts')} a where a.ticker = s.ticker and a.status = 'open')
     on conflict do nothing
     returning id`,
  );

  /* Alerts raised before `starts_at` existed have it null. Fill it in from the
     market so the countdown works and the expiry below can judge them. */
  await client.query(
    `update ${t('alerts')} a set starts_at = m.occurrence_datetime
     from ${t('markets')} m
     where m.ticker = a.ticker and a.starts_at is null
       and m.occurrence_datetime is not null`,
  );

  /* An alert dies when its signal stops qualifying, when the match starts, or —
     under pre-match-only — when its start time cannot be established at all. A
     pre-match edge is not actionable once play is under way, and an alert whose
     timing is unknown cannot be shown to be pre-match. */
  const expired = await client.query(
    `update ${t('alerts')} a set status = 'expired', resolved_at = now()
     where a.status = 'open'
       and (
         a.starts_at <= now()
         or ($1::boolean and a.starts_at is null)
         or not exists (
           select 1 from ${t('signals')} s
           join ${t('markets')} m on m.ticker = s.ticker
           where s.ticker = a.ticker and s.is_actionable
             and m.status in ('active','open','initialized'))
       )
     returning a.id`,
    [settings.prematch_only !== false],
  );

  return { created: created.rowCount ?? 0, expired: expired.rowCount ?? 0 };
}

/**
 * One full sync pass: pull every open market for the configured tennis series,
 * persist it, recompute the model, and reconcile the alert queue.
 */
export async function runSync(kalshi, { verbose = false } = {}) {
  const t0 = Date.now();
  const run = await query(`insert into ${t('sync_runs')} (status) values ('running') returning id`);
  const runId = run.rows[0].id;

  try {
    const st = await query(`select * from ${t('settings')} where id = 1`);
    const settings = st.rows[0];
    const series = settings.series_tickers?.length ? settings.series_tickers : config.sync.seriesTickers;

    const rawMarkets = [];
    for (const s of series) {
      const rows = await kalshi.getAllMarkets({ series_ticker: s, status: 'open' }, 600);
      rawMarkets.push(...rows);
      if (verbose) console.log(`  ${s}: ${rows.length} open markets`);
    }

    const rows = rawMarkets.map(normalise).filter(r => r.ticker && r.event_ticker);

    const out = await tx(async client => {
      await upsertPlayers(client, rows);
      const events = await upsertEvents(client, rows);
      const upserted = await upsertMarkets(client, rows);
      const ticks = await recordPriceHistory(client, rows);
      const sig = await computeSignals(client, rows, settings);
      const alerts = await reconcileAlerts(client, settings);
      return { events, upserted, ticks, ...sig, ...alerts };
    });

    const latency = Date.now() - t0;
    await query(
      `update ${t('sync_runs')} set status='ok', finished_at=now(), events_seen=$2,
         markets_seen=$3, markets_upserted=$4, signals_computed=$5, alerts_created=$6, latency_ms=$7
       where id=$1`,
      [runId, out.events, rows.length, out.upserted, out.computed, out.created, latency],
    );

    if (verbose) {
      console.log(`  events=${out.events} markets=${rows.length} ticks=${out.ticks} ` +
        `signals=${out.computed} actionable=${out.actionable} alerts+${out.created}/-${out.expired} ${latency}ms`);
    }
    return { ok: true, runId, latency, marketsSeen: rows.length, ...out };
  } catch (e) {
    await query(
      `update ${t('sync_runs')} set status='error', finished_at=now(), error=$2, latency_ms=$3 where id=$1`,
      [runId, String(e.message).slice(0, 900), Date.now() - t0],
    ).catch(() => {});
    throw e;
  }
}

/**
 * Marks runs orphaned by a crash or restart as errored, so the dashboard does
 * not report a sync as permanently in flight.
 */
export async function reapStaleRuns() {
  const r = await query(
    `update ${t('sync_runs')} set status = 'error', finished_at = now(),
       error = coalesce(error, 'abandoned — process restarted mid-sync')
     where status = 'running' and started_at < now() - interval '2 minutes'
     returning id`,
  );
  return r.rowCount ?? 0;
}

/** Background poller. Never lets one failure kill the loop. */
export function startSyncLoop(kalshi, intervalMs = config.sync.intervalMs) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await runSync(kalshi);
    } catch (e) {
      console.error('[sync] failed:', e.message.slice(0, 200));
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
