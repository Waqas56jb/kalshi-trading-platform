import { t } from './config.js';
import { query } from './db.js';
import { nameScore } from './utr.js';
import { oddsFeedConfigured, scoreForMatch } from './oddsfeed.js';

/**
 * Backfills set scores onto settled Kalshi markets from the Tennis API
 * (same RapidAPI product as the odds checker) — not Sofascore.
 *
 *   GET /tennis/v2/extend/api/event/get/{p1}/{p2}/{date}
 *
 * Kalshi only returns yes/no; this adds e.g. "6-4 6-3" for Trade history.
 */

async function ensureScoreColumns() {
  await query(
    `alter table ${t('markets')}
       add column if not exists final_score text,
       add column if not exists score_source text`,
  ).catch(() => null);
}

/** Orient API score (p1–p2) to Kalshi matchup order (a vs b). */
function orientScore(score, apiP1, apiP2, matchupA, matchupB) {
  if (!score || !apiP1 || !apiP2 || !matchupA || !matchupB) return score;
  const direct = Math.min(nameScore(matchupA, apiP1), nameScore(matchupB, apiP2));
  const swapped = Math.min(nameScore(matchupA, apiP2), nameScore(matchupB, apiP1));
  if (swapped <= direct) return score;
  return score.split(' ').map(set => {
    const [x, y] = set.split('-');
    return x != null && y != null ? `${y}-${x}` : set;
  }).join(' ');
}

/**
 * Pull scores for settled markets that still lack final_score.
 * Budget-limited per sync against the RapidAPI rate cap.
 */
export async function syncMatchScores({ limit = 40 } = {}) {
  await ensureScoreColumns();
  if (!oddsFeedConfigured()) return { updated: 0, skipped: 'odds_feed_not_configured' };

  const { rows: markets } = await query(
    `select m.ticker, m.event_ticker, m.player_name, m.match_date::text as match_date,
            e.matchup,
            opp.player_name as opponent_name
     from ${t('markets')} m
     join ${t('events')} e using (event_ticker)
     left join ${t('markets')} opp
       on opp.event_ticker = m.event_ticker and opp.ticker <> m.ticker
     where m.result in ('yes','no')
       and m.final_score is null
       and m.match_date is not null
       and m.match_date >= (now() at time zone 'America/Los_Angeles')::date - 5
     order by m.settled_at desc nulls last, m.match_date desc
     limit $1`,
    [limit],
  );
  if (!markets.length) return { updated: 0, considered: 0 };

  let updated = 0;
  let missed = 0;
  const seenEvents = new Set();

  for (const m of markets) {
    if (seenEvents.has(m.event_ticker)) continue;

    const [a, b] = String(m.matchup ?? '').split(/\s+vs\.?\s+/i);
    const p1 = m.player_name || a;
    const p2 = m.opponent_name || b;
    if (!p1 || !p2 || !m.match_date) { missed += 1; continue; }

    const hit = await scoreForMatch(p1, p2, m.match_date);
    if (!hit?.score) { missed += 1; continue; }

    const display = orientScore(hit.score, hit.p1, hit.p2, a || p1, b || p2);

    const r = await query(
      `update ${t('markets')} set
         final_score = $2,
         score_source = 'tennis-api'
       where event_ticker = $1 and final_score is null`,
      [m.event_ticker, display],
    );
    const n = r.rowCount ?? 0;
    if (n > 0) {
      updated += n;
      seenEvents.add(m.event_ticker);
    } else {
      missed += 1;
    }
  }

  return { updated, considered: markets.length, missed, source: 'tennis-api' };
}
