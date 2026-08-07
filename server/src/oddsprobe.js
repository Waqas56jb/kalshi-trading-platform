import { t } from './config.js';
import { query } from './db.js';
import { oddsFeedConfigured, quotesForMatch } from './oddsfeed.js';
import { bookConsensus } from './crossmarket.js';

/**
 * Logs every attempt to fetch book odds, hit or miss.
 *
 * The client's account is that odds appear too close to the off to be useful.
 * That is plausible and nobody has measured it, and the answer decides whether
 * cross-market is worth building on this feed at all — so rather than argue
 * about it, every attempt is recorded with how long before the match it was
 * made. After a day of syncing the question answers itself.
 *
 * A miss is written as deliberately as a hit. Without the empty rows, a feed
 * that never returns anything looks identical to one nobody ever asked.
 */
export async function probeOdds({ limit = 8, budgetMs = 12000 } = {}) {
  const deadline = Date.now() + budgetMs;
  if (!oddsFeedConfigured()) return { skipped: 'odds_feed_not_configured' };

  /* Upcoming and in-flight markets, most imminent first, one side per event so a
     match is not probed twice for the same prices. */
  const { rows } = await query(
    `select distinct on (m.event_ticker)
            m.ticker, m.event_ticker, m.player_name, m.match_date,
            m.yes_ask_cents, m.close_time,
            s.opponent_name
     from ${t('markets')} m
     join ${t('signals')} s on s.ticker = m.ticker
     where m.status in ('active','open','initialized')
       and s.opponent_name is not null
       and m.match_date >= current_date - 1
     order by m.event_ticker, m.close_time nulls last
     limit $1`, [limit]);

  if (!rows.length) return { probed: 0, hits: 0 };

  const out = [];
  let hits = 0;

  for (const r of rows) {
    /* Hard time budget. The sync has a 60-second ceiling on Vercel and market
       data matters more than a probe, so the loop stops rather than risk the
       whole run. Whatever was gathered is still written. */
    if (Date.now() > deadline) break;

    let books = 0;
    let consensusCents = null;
    let fixtureFound = false;
    let error = null;

    try {
      const quotes = await quotesForMatch(r.player_name, r.opponent_name);
      fixtureFound = quotes != null;
      const agg = quotes?.length ? bookConsensus(quotes) : null;
      if (agg?.consensus != null) {
        books = agg.books;
        consensusCents = Math.round(agg.consensus * 100);
        hits += 1;
      }
    } catch (e) {
      error = String(e.message).slice(0, 150);
    }

    /* close_time is when Kalshi settles, which for tennis is roughly the end of
       the match rather than the start. It is the only timing Kalshi gives us, so
       it is what "hours to match" is measured against — approximate, and
       consistent, which is what matters for comparing one probe with another. */
    const hoursTo = r.close_time
      ? +((new Date(r.close_time).getTime() - Date.now()) / 3_600_000).toFixed(2)
      : null;

    out.push({
      ticker: r.ticker,
      eventTicker: r.event_ticker,
      player: r.player_name,
      opponent: r.opponent_name,
      matchDate: r.match_date,
      hoursTo,
      fixtureFound,
      books,
      consensusCents,
      kalshiAsk: r.yes_ask_cents,
      divergence: consensusCents != null && r.yes_ask_cents != null
        ? consensusCents - r.yes_ask_cents : null,
      error,
    });
  }

  if (!out.length) return { probed: 0, hits: 0, fixturesFound: 0 };

  const col = f => out.map(f);
  await query(
    `insert into ${t('odds_probe')}
       (ticker, event_ticker, player_name, opponent_name, match_date,
        hours_to_match, fixture_found, books, consensus_cents,
        kalshi_ask_cents, divergence_cents, error)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::date[],
                          $6::numeric[], $7::boolean[], $8::int[], $9::int[],
                          $10::int[], $11::int[], $12::text[])`,
    [col(o => o.ticker), col(o => o.eventTicker), col(o => o.player), col(o => o.opponent),
      col(o => o.matchDate), col(o => o.hoursTo), col(o => o.fixtureFound), col(o => o.books),
      col(o => o.consensusCents), col(o => o.kalshiAsk), col(o => o.divergence), col(o => o.error)],
  );

  return { probed: out.length, hits, fixturesFound: out.filter(o => o.fixtureFound).length };
}

/** What the probing has established so far. */
export async function probeSummary({ hours = 24 } = {}) {
  const overall = await query(
    `select count(*)::int attempts,
            count(*) filter (where fixture_found)::int fixtures_matched,
            count(*) filter (where books > 0)::int with_odds,
            count(distinct ticker)::int markets,
            min(probed_at) since
     from ${t('odds_probe')} where probed_at > now() - make_interval(hours => $1)`,
    [hours]);

  /* The question the client actually asked: if odds arrive at all, how close to
     the match is it? Bucketed by time remaining, so lateness is visible rather
     than averaged away. */
  const byWindow = await query(
    `select case when hours_to_match is null then 'z. no close time'
                 when hours_to_match > 24 then 'a. more than 24h before'
                 when hours_to_match > 6  then 'b. 6-24h before'
                 when hours_to_match > 2  then 'c. 2-6h before'
                 when hours_to_match > 0  then 'd. under 2h before'
                 else 'e. after close' end as lead_window,
            count(*)::int attempts,
            count(*) filter (where books > 0)::int with_odds,
            round(100.0 * count(*) filter (where books > 0) / count(*), 1) hit_pct,
            round(avg(divergence_cents) filter (where divergence_cents is not null), 1) avg_divergence
     from ${t('odds_probe')}
     where probed_at > now() - make_interval(hours => $1)
     group by 1 order by 1`, [hours]);

  const o = overall.rows[0] ?? {};
  const attempts = Number(o.attempts ?? 0);
  const withOdds = Number(o.with_odds ?? 0);

  return {
    windowHours: hours,
    attempts,
    markets: Number(o.markets ?? 0),
    fixturesMatched: Number(o.fixtures_matched ?? 0),
    withOdds,
    hitRatePct: attempts ? +((withOdds / attempts) * 100).toFixed(1) : null,
    since: o.since ?? null,
    byWindow: byWindow.rows,
    verdict: attempts === 0 ? 'no probes recorded yet'
      : withOdds === 0
        ? `no odds on any of ${attempts} attempts — the feed is not returning ITF prices at any lead time`
        : `odds returned on ${withOdds} of ${attempts} attempts`,
  };
}
