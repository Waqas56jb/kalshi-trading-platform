import { t } from './config.js';
import { query } from './db.js';
import { COMMON_SURNAMES, genderForSeries, lookupPlayer } from './utr.js';

const UTR_MATCHES_COL = `alter table ${t('players')}
  add column if not exists utr_matches_12m integer`;

/**
 * Fills in UTR ratings for competitors we have seen in Kalshi markets.
 *
 * Players are looked up at most once until `retryFailed` is passed, so a repeat
 * run is cheap and only picks up newly discovered competitors.
 */
async function ensureUtrExtraColumns() {
  await query(
    `alter table ${t('players')}
       add column if not exists utr_3m numeric(5,2)`,
  ).catch(() => null);
  await query(UTR_MATCHES_COL).catch(() => null);
}

export async function backfillRatings({
  limit = 500, delayMs = 260, retryFailed = false, staleDays = 7, onProgress,
} = {}) {
  await ensureUtrExtraColumns();
  /* Never-attempted players first, and nobody twice within twelve hours.
     Without the cooldown, players UTR reports as Unrated keep utr = null and
     requalify every sync, so the same dozen swallowed the whole per-cycle
     budget while freshly listed players never got looked up at all — whole
     tournaments showing no fair value. Failed lookups retry on their own
     after three days; profiles do appear later for new players.
     Rated rows missing utr_3m / match volume also re-qualify (same 12h
     cooldown) so the 50/50 blend and >15-match gate can populate. */
  const rows = await query(
    `select competitor_id, name, series_ticker from (
       select distinct on (p.competitor_id)
              p.competitor_id, p.name, m.series_ticker, p.lookup_attempted_at
       from ${t('players')} p
       join ${t('markets')} m on m.competitor_id = p.competitor_id
       where (
               p.utr is null
               or p.utr_3m is null
               or p.utr_matches_12m is null
               or p.utr_updated_at < now() - ($2 || ' days')::interval
             )
         and ($3 or p.lookup_attempted_at is null or p.lookup_failed = false
              or p.lookup_attempted_at < now() - interval '3 days')
         and ($3 or p.lookup_attempted_at is null
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
      // Only a Rated profile with a real number may price a market. Projected /
      // Unrated numbers are stored as status metadata but utr is cleared so
      // Dreycopp/Ross-style junk (3–8 UTR on a 12-range ITF player) cannot
      // reach fair value. Robbie/Max: verified Rated only, with a checkmark.
      const usable = hit.utr != null && hit.utr_status === 'Rated';
      if (usable) stats.rated++; else stats.unrated++;
      /* If UTR omits threeMonthRating, mirror singles so we stop re-fetching
         and the blend degrades to 100% singles for that player. */
      const utr3m = usable ? (hit.utr_3m ?? hit.utr) : null;

      await query(
        `update ${t('players')} set
           utr = $2, utr_3m = $3, utr_matches_12m = $4, utr_doubles = $5,
           utr_status = $6, utr_player_id = $7,
           utr_matched_name = $8, utr_match_score = $9, utr_nationality = $10,
           utr_source = 'utrsports.net', utr_updated_at = now(),
           lookup_attempted_at = now(), lookup_failed = false
         where competitor_id = $1`,
        [p.competitor_id,
          usable ? hit.utr : null,
          utr3m,
          usable ? hit.utr_matches_12m : null,
          hit.utr_doubles, hit.utr_status, hit.utr_player_id,
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

/**
 * Clears Projected/Unrated numbers and weak name matches so the next backfill
 * re-resolves them under the tighter rules. Idempotent.
 */
export async function scrubUnusableRatings() {
  const r = await query(
    `update ${t('players')} set
       utr = null,
       lookup_attempted_at = null,
       lookup_failed = false,
       utr_updated_at = now()
     where (
             utr is not null and coalesce(utr_status, '') <> 'Rated'
           )
        or (
             utr is not null and coalesce(utr_match_score, 0) < 0.72
           )
        /* Common surnames: scrub when first initial/name disagrees with match
           (Thamchaiwat's wrong Wang → 88¢ fair). List must match COMMON_SURNAMES
           in utr.js so scrub + matcher stay in lockstep. */
        or (
             utr_matched_name is not null
             and lower(split_part(trim(name), ' ', -1)) = any($1::text[])
             and (
               coalesce(utr_match_score, 0) < 0.92
               or left(lower(split_part(trim(name), ' ', 1)), 1)
                    is distinct from left(lower(split_part(trim(utr_matched_name), ' ', 1)), 1)
             )
           )
        /* Always re-resolve Kuznetsova* — multiple ITF players, wrong profile
           poisons fair (Rothensteiner vs Kuznetsova, Max Aug 4). */
        or (
             utr is not null
             and lower(split_part(trim(name), ' ', -1)) in ('kuznetsova', 'kuznetcova')
           )
     returning competitor_id, name, utr_status, utr_match_score, utr_matched_name`,
    [[...COMMON_SURNAMES]]);
  return { scrubbed: r.rowCount ?? 0, rows: r.rows.slice(0, 20) };
}
