import { t } from './config.js';
import { query } from './db.js';
import { oddsFeedConfigured, quotesForMatch } from './oddsfeed.js';
import { bookConsensus } from './crossmarket.js';

/**
 * Closing-line value: what we paid against where the market closed.
 *
 * This exists because the odds feed publishes late. Used as a gate that was
 * fatal — no odds meant no bet, and the desk stopped trading. Used as a
 * scoreboard the same lateness is harmless, because we are comparing against the
 * books rather than waiting on them.
 *
 * It is measured two ways, deliberately. Against the sportsbook consensus, which
 * is the standard benchmark but depends on a feed that may never carry ITF. And
 * against Kalshi's own closing price, which needs no external feed at all and so
 * is always available. If the books never materialise we still learn whether our
 * entries beat the market we actually trade on.
 *
 * Beating the close is the fastest honest read on whether a strategy has edge.
 * At this desk's volume P&L needs months to separate skill from variance; CLV
 * needs weeks, because every settled match contributes a measurement rather than
 * a coin flip.
 */

/** Records the entry price the moment a position is taken. */
export async function recordEntry({
  ticker, eventTicker, playerName, opponentName, matchDate,
  entryCents, stakeUsd, source = 'shadow',
}) {
  if (!ticker || entryCents == null) return null;
  await query(
    `insert into ${t('closing_line')}
       (ticker, event_ticker, player_name, opponent_name, match_date,
        entry_cents, entry_at, stake_usd, source)
     values ($1,$2,$3,$4,$5,$6,now(),$7,$8)
     on conflict (ticker) do nothing`,
    [ticker, eventTicker, playerName, opponentName, matchDate,
      Math.round(entryCents), stakeUsd ?? null, source],
  );
  return true;
}

/**
 * Backfills entries from positions already taken.
 *
 * Runs every sync so a position recorded before this table existed, or one
 * placed by a path that forgot to call `recordEntry`, still gets measured. The
 * conflict clause makes it idempotent.
 */
export async function backfillEntries() {
  const r = await query(
    `insert into ${t('closing_line')}
       (ticker, event_ticker, player_name, opponent_name, match_date,
        entry_cents, entry_at, stake_usd, source)
     select st.ticker, st.event_ticker, st.player_name, st.opponent_name, st.match_date,
            coalesce(round(st.expected_vwap_cents)::int, st.best_ask_cents),
            st.created_at, st.stake_usd, 'shadow'
     from ${t('shadow_trades')} st
     where st.approved
       and coalesce(st.expected_vwap_cents, st.best_ask_cents) is not null
     on conflict (ticker) do nothing
     returning ticker`);
  return { added: r.rowCount ?? 0 };
}

/**
 * Fills in the closing prices for matches that have settled.
 *
 * Kalshi's close comes from our own price history — the last tick we recorded
 * before settlement — so it costs nothing and is never missing. The book close
 * is attempted only when a feed is configured, and its absence is recorded as
 * absence rather than as a zero.
 */
export async function captureClosingLines({ limit = 40 } = {}) {
  const { rows } = await query(
    `select cl.ticker, cl.player_name, cl.opponent_name, cl.entry_cents,
            m.result,
            (select ph.mid_cents from ${t('price_history')} ph
              where ph.ticker = cl.ticker and ph.mid_cents is not null
              order by ph.captured_at desc limit 1) as kalshi_close
     from ${t('closing_line')} cl
     join ${t('markets')} m on m.ticker = cl.ticker
     where cl.close_kalshi_cents is null and m.result in ('yes','no')
     order by cl.match_date desc
     limit $1`, [limit]);

  if (!rows.length) return { scored: 0, withBooks: 0 };

  let withBooks = 0;
  for (const row of rows) {
    let bookCents = null;
    let books = 0;

    if (oddsFeedConfigured()) {
      const quotes = await quotesForMatch(row.player_name, row.opponent_name).catch(() => null);
      const agg = quotes?.length ? bookConsensus(quotes) : null;
      if (agg?.consensus != null) {
        bookCents = Math.round(agg.consensus * 100);
        books = agg.books;
        withBooks += 1;
      }
    }

    const kalshiClose = row.kalshi_close != null ? Number(row.kalshi_close) : null;

    await query(
      /* Every placeholder is cast. Postgres cannot infer a type for a parameter
         that appears only inside a CASE, and an uncast one fails the whole
         statement with "could not determine data type" — this file has now hit
         that twice. */
      `update ${t('closing_line')} set
         close_kalshi_cents = $2::int,
         close_book_cents = $3::int,
         close_books = $4::int,
         close_captured_at = now(),
         /* Entry minus close. Buying below where the market ended is the
            direction that indicates edge, so a positive number is good. */
         clv_vs_kalshi_cents = case when $2::int is not null then $2::int - entry_cents end,
         clv_vs_book_cents   = case when $3::int is not null then $3::int - entry_cents end,
         result = $5::text,
         updated_at = now()
       where ticker = $1::text`,
      [row.ticker, kalshiClose, bookCents, books || null,
        row.result === 'yes' ? 'won' : 'lost'],
    );
  }

  return { scored: rows.length, withBooks };
}

/**
 * The scoreboard.
 *
 * `avg_clv_vs_kalshi` is the number to watch. Consistently positive means our
 * entries are ahead of where the market ends up, which is the earliest credible
 * sign of edge. Consistently negative means we are paying up, and no amount of
 * position sizing rescues that.
 */
export async function clvSummary({ days = 60 } = {}) {
  const overall = await query(
    `select count(*)::int scored,
            count(*) filter (where clv_vs_book_cents is not null)::int with_books,
            round(avg(clv_vs_kalshi_cents), 2) avg_clv_vs_kalshi,
            round(avg(clv_vs_book_cents), 2)   avg_clv_vs_book,
            round(100.0 * count(*) filter (where clv_vs_kalshi_cents > 0)
                  / nullif(count(*) filter (where clv_vs_kalshi_cents is not null), 0), 1) beat_kalshi_pct,
            round(stddev_samp(clv_vs_kalshi_cents), 2) clv_stddev
     from ${t('closing_line')}
     where clv_vs_kalshi_cents is not null
       and match_date >= current_date - $1::int`, [days]);

  const byBand = await query(
    `select case when entry_cents < 35 then 'a. <35c'
                 when entry_cents < 50 then 'b. 35-50c'
                 when entry_cents < 65 then 'c. 50-65c'
                 when entry_cents < 80 then 'd. 65-80c'
                 else 'e. 80c+' end band,
            count(*)::int n,
            round(avg(clv_vs_kalshi_cents), 2) avg_clv,
            round(100.0 * count(*) filter (where clv_vs_kalshi_cents > 0) / count(*), 1) beat_pct
     from ${t('closing_line')}
     where clv_vs_kalshi_cents is not null
       and match_date >= current_date - $1::int
     group by 1 order by 1`, [days]);

  const o = overall.rows[0] ?? {};
  const n = Number(o.scored ?? 0);
  const mean = o.avg_clv_vs_kalshi != null ? Number(o.avg_clv_vs_kalshi) : null;
  const sd = o.clv_stddev != null ? Number(o.clv_stddev) : null;

  /* A mean CLV is only meaningful against its own noise. Below roughly 30
     measurements the interval is wide enough that a positive average means
     nothing, and saying so is more useful than printing the number alone. */
  const stderr = sd != null && n > 1 ? sd / Math.sqrt(n) : null;

  return {
    scored: n,
    withBooks: Number(o.with_books ?? 0),
    avgClvVsKalshi: mean,
    avgClvVsBook: o.avg_clv_vs_book != null ? Number(o.avg_clv_vs_book) : null,
    beatKalshiPct: o.beat_kalshi_pct != null ? Number(o.beat_kalshi_pct) : null,
    stderr: stderr != null ? +stderr.toFixed(2) : null,
    significant: stderr != null && mean != null ? Math.abs(mean) > 2 * stderr : false,
    verdict: n < 30 ? 'too few measurements to read yet'
      : stderr != null && mean != null && Math.abs(mean) <= 2 * stderr
        ? 'no detectable edge either way'
        : mean > 0 ? 'entries are beating the close' : 'entries are behind the close',
    byBand: byBand.rows.map(b => ({
      band: b.band, n: b.n,
      avgClv: Number(b.avg_clv), beatPct: Number(b.beat_pct),
    })),
  };
}
