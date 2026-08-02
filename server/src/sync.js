import { config, t } from './config.js';
import { syncSchedule } from './schedule.js';
import { snapshotPortfolio, autoSellAtFair } from './orders.js';
import { importKalshiHistory } from './importer.js';
import { backfillRatings } from './ratings.js';
import { syncSettlements } from './settlements.js';
import { runShadowCycle, settleShadowTrades } from './shadow.js';
import { settleResolvedTrades } from './repo.js';
import {
  recomputeCalibration, refitUtrCurve, loadUtrCurve, loadUtrSlope, deriveMinimumPrice,
} from './calibration.js';
import { query, tx } from './db.js';
import { assessQuote } from './quote.js';
import {
  buildSignalsForEvent, classifySchedule, dayIn, dollarsToCents, looksInPlay,
  matchDateFromTicker, parseMarketTitle, sideType, toNum,
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
    match_date: matchDateFromTicker(raw.ticker),
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
        occurrence_datetime, close_time, status, raw,
        scheduled_at, schedule_source, schedule_confidence)
     select * from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
       $8::timestamptz[], $9::timestamptz[], $10::text[], $11::jsonb[],
       $12::timestamptz[], $13::text[], $14::text[])
     on conflict (event_ticker) do update set
       title = excluded.title, matchup = excluded.matchup,
       tournament = excluded.tournament, round = excluded.round,
       tour_level = excluded.tour_level,
       occurrence_datetime = excluded.occurrence_datetime,
       close_time = excluded.close_time, status = excluded.status,
       -- never downgrade a time that came from a real schedule source
       scheduled_at = case when public.kalshi_events.schedule_confidence = 'exact'
                          then public.kalshi_events.scheduled_at else excluded.scheduled_at end,
       schedule_source = case when public.kalshi_events.schedule_confidence = 'exact'
                          then public.kalshi_events.schedule_source else excluded.schedule_source end,
       schedule_confidence = case when public.kalshi_events.schedule_confidence = 'exact'
                          then 'exact' else excluded.schedule_confidence end`,
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
      list.map(r => (classifySchedule(r.occurrence_datetime).confidence === 'none'
        ? null : r.occurrence_datetime)),
      list.map(r => classifySchedule(r.occurrence_datetime).source),
      list.map(r => classifySchedule(r.occurrence_datetime).confidence),
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
        close_time, occurrence_datetime, match_date, raw, updated_at)
     select *, now() from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
       $8::int[], $9::int[], $10::int[], $11::int[], $12::int[],
       $13::numeric[], $14::numeric[], $15::numeric[], $16::numeric[], $17::numeric[], $18::numeric[],
       $19::timestamptz[], $20::timestamptz[], $21::date[], $22::jsonb[])
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
       match_date = excluded.match_date,
       raw = excluded.raw, updated_at = now()`,
    [
      col(r => r.ticker), col(r => r.event_ticker), col(r => r.series_ticker),
      col(r => r.competitor_id), col(r => r.player_name), col(r => r.title), col(r => r.status),
      col(r => r.yes_bid_cents), col(r => r.yes_ask_cents), col(r => r.no_bid_cents),
      col(r => r.no_ask_cents), col(r => r.last_price_cents),
      col(r => r.yes_bid_size), col(r => r.yes_ask_size), col(r => r.volume),
      col(r => r.volume_24h), col(r => r.open_interest), col(r => r.liquidity),
      col(r => r.close_time), col(r => r.occurrence_datetime), col(r => r.match_date),
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

/** Largest mid-price swing per ticker in the recent past, in cents. */
async function bookActivity(client, tickers) {
  if (!tickers.length) return new Map();
  const r = await client.query(
    `select ticker,
            (max(mid_cents) filter (where captured_at > now() - interval '90 minutes')
             - min(mid_cents) filter (where captured_at > now() - interval '90 minutes'))::int as move,
            (max(volume) - min(volume)) as vol_growth
     from ${t('price_history')}
     where ticker = any($1::text[]) and captured_at > now() - interval '3 hours'
     group by ticker`,
    [tickers],
  );
  return new Map(r.rows.map(x => [x.ticker, { move: x.move, volGrowth: Number(x.vol_growth ?? 0) }]));
}

async function computeSignals(client, rows, settings) {
  /* The fit from settled matches, when one exists. Loaded per sync rather
     than cached in module scope so a refit takes effect on the next cycle
     instead of the next deploy. The logistic slope is the pricing curve; the
     brackets are the fallback until a slope has been fitted. */
  const curve = await loadUtrCurve().catch(() => []);
  const slope = await loadUtrSlope().catch(() => null);

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
  for (const ms of byEvent.values()) {
    signals.push(...buildSignalsForEvent(ms, players, curve, slope?.k ?? null));
  }
  const rated = signals.filter(s => s.fair_cents != null && s.market_cents != null);
  if (!rated.length) return { computed: 0, actionable: 0 };

  const minEv = Number(settings.min_ev_threshold);
  const minGap = Number(settings.min_utr_gap);
  const minBid = Number(settings.min_bid_cents ?? 5);
  const maxSpread = Number(settings.max_spread_cents ?? 12);
  const maxEdge = Number(settings.max_edge_cents ?? 25);
  const minEdge = Number(settings.min_edge_cents ?? 15);
  const leadMs = Number(settings.alert_lead_minutes ?? 10) * 60_000;
  const maxAheadMs = Number(settings.alert_max_hours ?? 72) * 3_600_000;
  const now = Date.now();

  const byTicker = new Map(rows.map(r => [r.ticker, r]));
  const activity = await bookActivity(client, rows.map(r => r.ticker));
  const volThreshold = Number(settings.inplay_volume_threshold ?? 150);
  const todayPT = dayIn(new Date());

  /**
   * Decides whether a priced signal is safe to act on, and records why not.
   *
   * The market is treated as the better-informed party when it disagrees
   * violently: a ratings model cannot see a withdrawal, an injury or a
   * retirement, and those are exactly what a 0/1c quote against a strong
   * favourite looks like.
   */
  /* Opponent asks, so a quote can be judged against the only test that cannot be
     argued with: the two sides of one match must sum to about 100. */
  const opponentAsk = new Map();
  for (const r of rows) {
    const other = rows.find(o => o.event_ticker === r.event_ticker && o.ticker !== r.ticker);
    if (other) opponentAsk.set(r.ticker, other.yes_ask_cents ?? null);
  }

  const review = s => {
    const m = byTicker.get(s.ticker);
    const bid = m?.yes_bid_cents ?? null;
    const ask = m?.yes_ask_cents ?? null;

    /* Is this a price at all? Across a live sample 64 of 108 markets quoted both
       sides at 95c against 2c bids, which is Kalshi showing the widest possible
       spread because nobody is making a market. Computing an edge against that
       produced the "94% ask on Kalshi" the client asked about, on a player the
       model had at 14%. There was no 94c. */
    const quote = assessQuote({ bid, ask, opponentAsk: opponentAsk.get(s.ticker) ?? null });
    if (!quote.tradable) return quote.reason === 'book_is_empty'
      ? 'no_real_market' : quote.reason;
    const edge = s.fair_cents - s.market_cents;

    /* Absolute edge first. Percentage EV inflates on cheap contracts — a 3c edge
       on a 1c ask reads as +300% — so the cents floor is the meaningful filter. */
    if (edge < minEdge) return 'edge_too_small';
    if (s.ev_pct == null || s.ev_pct < minEv) return 'below_ev_threshold';
    if (Math.abs(s.utr_gap ?? 0) < minGap) return 'utr_gap_too_small';
    if (bid == null || bid < minBid) return 'no_real_bid';
    if (ask != null && bid != null && ask - bid > maxSpread) return 'spread_too_wide';
    if (edge > maxEdge) return 'market_disagrees_strongly';

    /* Pre-match window. The model prices form on paper, not what is happening on
       court, so an in-play quote is not something it can reason about. The lead
       time keeps out alerts that arrive too late to act on.

       This gate is not a setting. The desk's rule is that every entry happens
       before the match starts, so it cannot be switched off.

       Kalshi publishes no start time — `occurrence_datetime` is its expiry
       estimate and ran 4h33m late on a checked match — so the pre-match test is
       built from the ticker's match date plus what the book is doing, not from a
       clock we do not have. */
    const matchDay = matchDateFromTicker(s.ticker);   // plain YYYY-MM-DD
    if (!matchDay) return 'no_match_date';
    if (matchDay < todayPT) return 'match_day_passed';
    if (matchDay > dayIn(new Date(now + maxAheadMs))) return 'too_far_ahead';

    const act = activity.get(s.ticker);
    const inPlay = looksInPlay({
      bid, ask,
      recentMoveCents: act?.move,
      volumeGrowth3h: act?.volGrowth,
      volumeThreshold: volThreshold,
    });
    if (inPlay) return inPlay;

    return null;                                     // actionable
  };

  for (const s of rated) {
    s.review_reason = review(s);
    s.side_type = sideType(s.market_cents);
  }
  const col = f => rated.map(f);

  await client.query(
    `insert into ${t('signals')}
       (ticker, event_ticker, player_name, opponent_name, player_utr, opponent_utr,
        utr_gap, fair_cents, market_cents, ev_pct, model, is_actionable, review_reason,
        side_type, computed_at)
     select *, now() from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[],
       $7::numeric[], $8::int[], $9::int[], $10::numeric[], $11::text[], $12::boolean[], $13::text[],
       $14::text[])
     on conflict (ticker) do update set
       event_ticker = excluded.event_ticker, player_name = excluded.player_name,
       opponent_name = excluded.opponent_name, player_utr = excluded.player_utr,
       opponent_utr = excluded.opponent_utr, utr_gap = excluded.utr_gap,
       fair_cents = excluded.fair_cents, market_cents = excluded.market_cents,
       ev_pct = excluded.ev_pct, model = excluded.model,
       is_actionable = excluded.is_actionable, review_reason = excluded.review_reason,
       side_type = excluded.side_type, computed_at = now()`,
    [
      col(s => s.ticker), col(s => s.event_ticker), col(s => s.player_name),
      col(s => s.opponent_name), col(s => s.player_utr), col(s => s.opponent_utr),
      col(s => s.utr_gap), col(s => s.fair_cents), col(s => s.market_cents),
      col(s => s.ev_pct), col(s => s.model),
      col(s => s.review_reason === null),
      col(s => s.review_reason),
      col(s => s.side_type),
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
/**
 * Marks markets that dropped out of the feed as closed.
 *
 * The sync asks Kalshi only for open markets, so a ticker that stops appearing
 * has closed. Without this their status stayed 'active' forever and the desk
 * counted 482 "live ITF markets" when Kalshi was returning 96.
 */
async function markUnseenClosed(client, rows) {
  const r = await client.query(
    `update ${t('markets')} set status = 'closed', updated_at = now()
     where status in ('active','open','initialized')
       and ticker <> all($1::text[])
       and updated_at < now() - interval '30 minutes'
     returning ticker`,
    [rows.map(x => x.ticker)],
  );
  return r.rowCount ?? 0;
}

/** Persists the inferred play state so the desk can label each market. */
async function recordPlayState(client, rows, settings) {
  if (!rows.length) return 0;
  const act = await bookActivity(client, rows.map(r => r.ticker));
  const threshold = Number(settings.inplay_volume_threshold ?? 150);

  const states = rows.map(r => {
    const a = act.get(r.ticker);
    const verdict = looksInPlay({
      bid: r.yes_bid_cents, ask: r.yes_ask_cents,
      recentMoveCents: a?.move, volumeGrowth3h: a?.volGrowth, volumeThreshold: threshold,
    });
    // with no history yet there is nothing to judge, so say so rather than guess
    if (!a && verdict === null) return 'unknown';
    return verdict ? 'in_play' : 'not_started';
  });

  await client.query(
    `update ${t('markets')} m set play_state = x.state, volume_growth_3h = x.grow
     from (select * from unnest($1::text[], $2::text[], $3::numeric[])
             as u(ticker, state, grow)) x
     where m.ticker = x.ticker`,
    [rows.map(r => r.ticker), states, rows.map(r => act.get(r.ticker)?.volGrowth ?? null)],
  );
  return rows.length;
}

async function reconcileAlerts(client) {
  const created = await client.query(
    `insert into ${t('alerts')}
       (ticker, event_ticker, player_name, matchup, tournament, utr_gap,
        fair_cents, market_cents, ev_pct, volume_available, starts_at, side_type)
     select s.ticker, s.event_ticker, s.player_name, e.matchup, e.tournament, s.utr_gap,
            s.fair_cents, s.market_cents, s.ev_pct, m.yes_ask_size, m.occurrence_datetime, s.side_type
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

  /* Alerts raised before side_type existed have it null; take it from the signal. */
  await client.query(
    `update ${t('alerts')} a set side_type = s.side_type
     from ${t('signals')} s
     where s.ticker = a.ticker and a.side_type is null and s.side_type is not null`,
  );

  /* Alerts raised before `starts_at` existed have it null. Fill it in from the
     market so the countdown works and the expiry below can judge them. */
  await client.query(
    `update ${t('alerts')} a set starts_at = m.occurrence_datetime
     from ${t('markets')} m
     where m.ticker = a.ticker and a.starts_at is null
       and m.occurrence_datetime is not null`,
  );

  /* An alert dies when its signal stops qualifying, when the match starts, or
     when its start time cannot be established at all. A pre-match edge is not
     actionable once play is under way, and an alert whose timing is unknown
     cannot be shown to be pre-match. Entries are pre-match only, always. */
  const expired = await client.query(
    `update ${t('alerts')} a set status = 'expired', resolved_at = now()
     where a.status = 'open'
       and (
         a.starts_at <= now()
         or a.starts_at is null
         or not exists (
           select 1 from ${t('signals')} s
           join ${t('markets')} m on m.ticker = s.ticker
           where s.ticker = a.ticker and s.is_actionable
             and m.status in ('active','open','initialized'))
       )
     returning a.id`,
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
    /* Refresh real start times first so the pre-match gate can use them. Failure
       is not fatal: the desk falls back to order-book inference. */
    await syncSchedule().catch(() => null);

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

    /* Rate players seen for the first time. New matches bring new competitors and
       nothing else looks them up, which is why only 42 of 92 markets could be
       priced — 29 of the 38 unrated players had never been tried. A match needs
       both sides rated, so every unrated player costs a market. */
    await backfillRatings({ limit: 24, delayMs: 120 }).catch(() => null);

    const out = await tx(async client => {
      await upsertPlayers(client, rows);
      const events = await upsertEvents(client, rows);
      const upserted = await upsertMarkets(client, rows);
      const ticks = await recordPriceHistory(client, rows);
      const sig = await computeSignals(client, rows, settings);
      await recordPlayState(client, rows, settings);
      await markUnseenClosed(client, rows);
      const alerts = await reconcileAlerts(client);
      return { events, upserted, ticks, ...sig, ...alerts };
    });

    /* Refresh the balance so the dashboard is not quoting a stale snapshot. It
       was showing a six-hour-old $2,979 while the account actually held $39. */
    await snapshotPortfolio(kalshi).catch(() => null);
    /* Keep the ledger in step with what the account actually did, including
       trades placed outside this desk. */
    await importKalshiHistory(kalshi).catch(() => null);

    /* Record how finished matches resolved. This is the dataset's target
       variable: without it a market that leaves the feed is only ever marked
       closed, and 756 rows sat labelled with nothing at all. One page per series
       is enough to catch the day's settlements on a 60-second tick. */
    const settled = await syncSettlements(kalshi, { maxPages: 1 })
      .catch(() => ({ updated: 0 }));

    /* Shadow trading, run here rather than on its own timer so the risk engine
       sees signals seconds old rather than a minute old. Its staleness gate is
       there to stop us acting on a quote the market has moved past, and running
       it out of band would have it rejecting everything on age alone. */
    const shadow = await runShadowCycle(kalshi).catch(e => ({
      error: String(e.message).slice(0, 160),
    }));
    await settleShadowTrades().catch(() => null);

    /* Paper and live fills settle themselves once Kalshi has a result — no
       manual Close needed for a finished match. This used to live only behind
       the admin "Settle now" button, so FILLED rows sat with Result/P&L blank
       until someone clicked. */
    await settleResolvedTrades(kalshi).catch(() => null);

    /* Re-measure the model against everything that has settled, and re-fit the
       UTR curve. Cheap, and it means the curve improves on its own instead of
       waiting for someone to notice it has drifted. */
    await recomputeCalibration({ minSample: 40 }).catch(() => null);
    await refitUtrCurve({ minSample: 40 }).catch(() => null);
    await deriveMinimumPrice().catch(() => null);

    /* Run the exit rules — take-profit, stop-loss and sell-at-fair.
       These used to be reached only from the reconcile cron, which has never run
       because its repository secrets were never set, so positions sailed past
       +20% and nothing sold. They belong here: the rules compare the live bid
       against entry, and the bid was refreshed moments ago in the block above.
       A failure must not fail the sync — market data still needs to land. */
    const exits = await autoSellAtFair(kalshi).catch(e => ({
      enabled: true, closed: 0, error: String(e.message).slice(0, 160),
    }));

    const latency = Date.now() - t0;
    await query(
      `update ${t('sync_runs')} set status='ok', finished_at=now(), events_seen=$2,
         markets_seen=$3, markets_upserted=$4, signals_computed=$5, alerts_created=$6, latency_ms=$7
       where id=$1`,
      [runId, out.events, rows.length, out.upserted, out.computed, out.created, latency],
    );

    if (verbose) {
      console.log(`  events=${out.events} markets=${rows.length} ticks=${out.ticks} ` +
        `signals=${out.computed} actionable=${out.actionable} alerts+${out.created}/-${out.expired} ` +
        `exits=${exits.closed ?? 0} settled+${settled.updated ?? 0} ` +
        `shadow=${shadow.approved ?? 0}/${shadow.evaluated ?? 0} ${latency}ms`);
    }
    return { ok: true, runId, latency, marketsSeen: rows.length, ...out, exits, settled, shadow };
  } catch (e) {
    await query(
      `update ${t('sync_runs')} set status='error', finished_at=now(), error=$2, latency_ms=$3 where id=$1`,
      [runId, String(e.message).slice(0, 900), Date.now() - t0],
    ).catch(() => {});
    throw e;
  }
}

/**
 * Runs a sync if the data is stale and none is already in flight.
 *
 * Called from the dashboard's own polling, which removes the need for a manual
 * button and for cron: as long as someone has the desk open the data keeps
 * itself current. The lock is the sync_runs table rather than a variable,
 * because on serverless each request may land in a different container and a
 * process-local flag would let them all sync at once.
 */
export async function maybeAutoSync(kalshi, { maxAgeSeconds = 60 } = {}) {
  const r = await query(
    `select
       (select count(*) from ${t('sync_runs')}
         where status = 'running' and started_at > now() - interval '3 minutes')::int as running,
       (select extract(epoch from (now() - max(finished_at)))
          from ${t('sync_runs')} where status = 'ok')::int as age_seconds`,
  );
  const { running, age_seconds: age } = r.rows[0];

  if (running > 0) return { skipped: 'already_running' };
  if (age != null && age < maxAgeSeconds) return { skipped: 'fresh', age_seconds: age };

  try {
    const out = await runSync(kalshi);
    return { ran: true, ...out };
  } catch (e) {
    // a failed auto-sync must never break the request that triggered it
    return { skipped: 'failed', error: String(e.message).slice(0, 160) };
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
