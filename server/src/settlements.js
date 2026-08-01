import { config, t } from './config.js';
import { query } from './db.js';

/**
 * Records how markets actually resolved.
 *
 * This is what makes the exported dataset trainable. The sync only ever asked
 * Kalshi for open markets, so when a match finished its market simply vanished
 * from the feed and `markUnseenClosed` flagged it closed — outcome unknown. That
 * left 756 closed markets carrying no result, and a training set with no label
 * is not a training set.
 *
 * Kalshi will serve settled markets in bulk (`status=settled`), which is far
 * cheaper than re-reading each closed ticker one at a time, so that is the path
 * taken here.
 */
export async function syncSettlements(kalshi, { maxPages = 6, pageSize = 200 } = {}) {
  let updated = 0;
  let seen = 0;

  for (const series of config.sync.seriesTickers) {
    let cursor;
    for (let page = 0; page < maxPages; page += 1) {
      const res = await kalshi.get('/markets', {
        status: 'settled', series_ticker: series, limit: pageSize, ...(cursor ? { cursor } : {}),
      }).catch(() => null);

      const markets = res?.markets ?? [];
      if (!markets.length) break;
      seen += markets.length;

      /* Only rows whose outcome we do not already hold get written, so a repeat
         run over the same pages costs one statement and changes nothing. */
      const rows = markets
        .map(m => ({
          ticker: m.ticker,
          result: (m.result ?? '').toLowerCase() || null,
          value: m.settlement_value_dollars != null ? Number(m.settlement_value_dollars) : null,
          at: m.settlement_ts ?? m.close_time ?? null,
        }))
        .filter(r => r.ticker && (r.result === 'yes' || r.result === 'no'));

      if (rows.length) {
        const out = await query(
          `update ${t('markets')} m set
             result = x.result,
             settlement_value = x.value,
             settled_at = coalesce(x.at, now()),
             status = 'settled'
           from unnest($1::text[], $2::text[], $3::numeric[], $4::timestamptz[])
                as x(ticker, result, value, at)
           where m.ticker = x.ticker and m.result is distinct from x.result`,
          [rows.map(r => r.ticker), rows.map(r => r.result),
            rows.map(r => r.value), rows.map(r => r.at)],
        );
        updated += out.rowCount ?? 0;
      }

      cursor = res?.cursor || null;
      if (!cursor) break;
    }
  }

  const remaining = (await query(
    `select count(*)::int n from ${t('markets')}
     where result is null and status in ('closed','settled','finalized')`)).rows[0].n;

  return { seen, updated, still_unresolved: remaining };
}

/** Outcome coverage, which is what decides whether the dataset is worth training on. */
export async function settlementCoverage() {
  const r = await query(
    `select
       count(*) filter (where result is not null)::int labelled,
       count(*) filter (where result = 'yes')::int wins,
       count(*) filter (where result = 'no')::int losses,
       count(*) filter (where result is null
                          and status in ('closed','settled','finalized'))::int unlabelled
     from ${t('markets')}`);
  return r.rows[0];
}
