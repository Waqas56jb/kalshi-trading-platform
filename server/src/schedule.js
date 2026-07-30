import { t } from './config.js';
import { query } from './db.js';
import { normaliseName, nameScore } from './utr.js';

/**
 * Real match start times.
 *
 * Kalshi publishes none — its `occurrence_datetime` is an expiry estimate that
 * read 18:00 on a match which began at 13:27 — so start times have to come from
 * a schedule source. Sofascore is the one the trader uses.
 *
 * Sofascore has no public API and rejects requests it does not recognise as a
 * browser (403). Whether it answers a given host is an empirical question, so
 * `probe()` reports the truth rather than assuming, and the sync degrades to
 * order-book inference when it cannot be reached.
 */

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.sofascore.com/',
  Origin: 'https://www.sofascore.com',
  'sec-ch-ua': '"Chromium";v="126", "Not:A-Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
};

const HOSTS = ['https://api.sofascore.com', 'https://www.sofascore.com', 'https://api.sofascore.app'];

const todayUtc = () => new Date().toISOString().slice(0, 10);

async function fetchDay(host, date, signal) {
  const res = await fetch(`${host}/api/v1/sport/tennis/scheduled-events/${date}`,
    { headers: BROWSER_HEADERS, signal });
  if (!res.ok) {
    const e = new Error(`${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** Which hosts answer from wherever this is running. */
export async function probe(date = todayUtc()) {
  const out = [];
  for (const host of HOSTS) {
    try {
      const j = await fetchDay(host, date, AbortSignal.timeout(15_000));
      out.push({ host, ok: true, events: (j?.events ?? []).length });
    } catch (e) {
      out.push({ host, ok: false, error: e.status ? `HTTP ${e.status}` : e.message.slice(0, 60) });
    }
  }
  return out;
}

/** Every tennis match Sofascore lists for a day, flattened. */
export async function fetchSchedule(date = todayUtc()) {
  let lastErr = 'no host tried';
  for (const host of HOSTS) {
    try {
      const j = await fetchDay(host, date, AbortSignal.timeout(20_000));
      const events = (j?.events ?? []).map(e => ({
        home: e.homeTeam?.name ?? '',
        away: e.awayTeam?.name ?? '',
        startsAt: e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString() : null,
        status: e.status?.type ?? null,
        tournament: e.tournament?.name ?? '',
      })).filter(e => e.startsAt && e.home && e.away);
      return { ok: true, host, events };
    } catch (e) {
      lastErr = `${host}: ${e.status ? `HTTP ${e.status}` : e.message.slice(0, 60)}`;
    }
  }
  return { ok: false, error: lastErr, events: [] };
}

/**
 * Matches Sofascore fixtures to Kalshi markets by the two player surnames.
 *
 * Kalshi carries a matchup like "Monday vs Hance" while Sofascore has full names,
 * so both sides are compared and a fixture is only accepted when both players
 * clear the bar — one strong surname match is not enough to pin a fixture.
 */
export async function syncSchedule({ date = todayUtc(), minScore = 0.5 } = {}) {
  const feed = await fetchSchedule(date);
  if (!feed.ok) return { ok: false, error: feed.error, matched: 0, source: 'sofascore' };

  const markets = await query(
    `select m.ticker, m.event_ticker, m.player_name, e.matchup
     from ${t('markets')} m
     join ${t('events')} e using (event_ticker)
     where m.status in ('active','open','initialized') and m.match_date = $1::date`,
    [date],
  );

  const rows = [];
  for (const m of markets.rows) {
    const [a, b] = String(m.matchup ?? '').split(/\s+vs\.?\s+/i);
    if (!a || !b) continue;

    let best = null;
    for (const ev of feed.events) {
      // try both orientations; Kalshi's matchup order is not Sofascore's
      const direct = Math.min(nameScore(a, ev.home), nameScore(b, ev.away));
      const swapped = Math.min(nameScore(a, ev.away), nameScore(b, ev.home));
      const score = Math.max(direct, swapped);
      if (!best || score > best.score) best = { ev, score };
    }
    if (!best || best.score < minScore) continue;

    rows.push({
      ticker: m.ticker, event_ticker: m.event_ticker,
      starts_at: best.ev.startsAt, status: best.ev.status,
      home: best.ev.home, away: best.ev.away, score: +best.score.toFixed(3),
    });
  }

  if (rows.length) {
    const col = f => rows.map(f);
    await query(
      `insert into ${t('match_schedule')}
         (ticker, event_ticker, starts_at, source, home_name, away_name, match_status, confidence, fetched_at)
       select *, now() from unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[],
                                   $5::text[], $6::text[], $7::text[], $8::numeric[])
       on conflict (ticker) do update set
         starts_at = excluded.starts_at, match_status = excluded.match_status,
         confidence = excluded.confidence, fetched_at = now()`,
      [col(r => r.ticker), col(r => r.event_ticker), col(r => r.starts_at),
        rows.map(() => 'sofascore'), col(r => r.home), col(r => r.away),
        col(r => r.status), col(r => r.score)],
    );

    // promote to the event, where the pre-match gate reads it
    await query(
      `update ${t('events')} e set scheduled_at = s.starts_at,
         schedule_source = 'sofascore', schedule_confidence = 'exact'
       from ${t('match_schedule')} s
       where s.event_ticker = e.event_ticker and s.source = 'sofascore'`,
    );
  }

  return {
    ok: true, source: 'sofascore', host: feed.host,
    fixtures: feed.events.length, markets: markets.rowCount, matched: rows.length,
  };
}

/** Best known start for a set of tickers: a real schedule time, or nothing. */
export async function startTimes(tickers) {
  if (!tickers?.length) return new Map();
  const r = await query(
    `select ticker, starts_at, match_status from ${t('match_schedule')}
     where ticker = any($1::text[])`, [tickers]);
  return new Map(r.rows.map(x => [x.ticker, x]));
}
