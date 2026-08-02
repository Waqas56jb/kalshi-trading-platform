import { t } from './config.js';
import { query } from './db.js';
import { genderForSeries, lookupPlayer } from './utr.js';

/**
 * Fills in UTR ratings for competitors we have seen in Kalshi markets.
 *
 * Players are looked up at most once until `retryFailed` is passed, so a repeat
 * run is cheap and only picks up newly discovered competitors.
 */
export async function backfillRatings({
  limit = 500, delayMs = 260, retryFailed = false, staleDays = 7, onProgress,
} = {}) {
  /* Never-attempted players first, and nobody twice within twelve hours.
     Without the cooldown, players UTR reports as Unrated keep utr = null and
     requalify every sync, so the same dozen swallowed the whole per-cycle
     budget while freshly listed players never got looked up at all — whole
     tournaments showing no fair value. Failed lookups retry on their own
     after three days; profiles do appear later for new players. */
  const rows = await query(
    `select competitor_id, name, series_ticker from (
       select distinct on (p.competitor_id)
              p.competitor_id, p.name, m.series_ticker, p.lookup_attempted_at
       from ${t('players')} p
       join ${t('markets')} m on m.competitor_id = p.competitor_id
       where (
               p.utr is null
               or p.utr_updated_at < now() - ($2 || ' days')::interval
             )
         and ($3 or p.lookup_attempted_at is null or p.lookup_failed = false
              or p.lookup_attempted_at < now() - interval '3 days')
         and (p.lookup_attempted_at is null
              or p.lookup_attempted_at < now() - interval '12 hours')
       order by p.competitor_id, m.updated_at desc
     ) q
     order by q.lookup_attempted_at asc nulls first
     limit $1`,
    [limit, String(staleDays), retryFailed],
  );

  const stats = { considered: rows.rows.length, rated: 0, unrated: 0, missed: 0, errors: 0 };

  for (const [i, p] of rows.rows.entries()) {
    let hit = null;
    let failed = false;
    try {
      hit = await lookupPlayer(p.name, { gender: genderForSeries(p.series_ticker) });
    } catch {
      stats.errors++;
      failed = true;
    }

    if (hit) {
      // Only a "Rated" profile with an actual number can price a market.
      const usable = hit.utr != null && hit.utr_status === 'Rated';
      if (usable) stats.rated++; else stats.unrated++;

      await query(
        `update ${t('players')} set
           utr = $2, utr_doubles = $3, utr_status = $4, utr_player_id = $5,
           utr_matched_name = $6, utr_match_score = $7, utr_nationality = $8,
           utr_source = 'utrsports.net', utr_updated_at = now(),
           lookup_attempted_at = now(), lookup_failed = false
         where competitor_id = $1`,
        [p.competitor_id, hit.utr, hit.utr_doubles, hit.utr_status, hit.utr_player_id,
          hit.utr_matched_name, hit.utr_match_score, hit.utr_nationality],
      );
    } else {
      if (!failed) stats.missed++;
      await query(
        `update ${t('players')} set lookup_attempted_at = now(), lookup_failed = $2
         where competitor_id = $1`,
        [p.competitor_id, true],
      );
    }

    onProgress?.(i + 1, rows.rows.length, p.name, hit);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }

  return stats;
}

export async function ratingsCoverage() {
  const r = await query(
    `select count(*)::int total,
            count(utr)::int with_any_utr,
            count(*) filter (where utr is not null and utr_status = 'Rated')::int usable,
            count(*) filter (where lookup_failed)::int failed,
            count(*) filter (where lookup_attempted_at is null)::int not_attempted
     from ${t('players')}`,
  );
  return r.rows[0];
}
