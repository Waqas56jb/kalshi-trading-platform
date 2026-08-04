import { t } from './config.js';
import { query } from './db.js';
import { nameScore } from './utr.js';
import { fetchSchedule } from './schedule.js';

/**
 * Backfills set scores onto settled Kalshi markets.
 *
 * Kalshi only returns yes/no. Scores come from Sofascore's day schedule (same
 * feed we already use for start times). Matched by both player surnames so a
 * single common surname cannot pin the wrong match.
 */

async function ensureScoreColumns() {
  await query(
    `alter table ${t('markets')}
       add column if not exists final_score text,
       add column if not exists score_source text`,
  ).catch(() => null);
}

/**
 * Pull scores for settled markets that still lack final_score.
 * Looks back a few Pacific match-days (ITF often settles hours after play).
 */
export async function syncMatchScores({ daysBack = 4, minScore = 0.55 } = {}) {
  await ensureScoreColumns();

  const { rows: dates } = await query(
    `select distinct match_date::text as d
     from ${t('markets')}
     where result in ('yes','no')
       and final_score is null
       and match_date is not null
       and match_date >= (now() at time zone 'America/Los_Angeles')::date
                          - ($1::int)
     order by 1 desc
     limit 8`,
    [daysBack],
  );
  if (!dates.length) return { updated: 0, dates: 0 };

  let updated = 0;
  const sources = new Set();

  for (const { d } of dates) {
    const feed = await fetchSchedule(d);
    if (!feed.ok || !feed.events?.length) continue;
    sources.add(feed.host || 'sofascore');

    const finished = feed.events.filter(e => e.score
      && (e.status === 'finished' || e.status === 'ended' || e.score));
    if (!finished.length) continue;

    const { rows: markets } = await query(
      `select m.ticker, m.event_ticker, m.player_name, e.matchup
       from ${t('markets')} m
       join ${t('events')} e using (event_ticker)
       where m.match_date = $1::date
         and m.result in ('yes','no')
         and m.final_score is null`,
      [d],
    );

    for (const m of markets) {
      const [a, b] = String(m.matchup ?? '').split(/\s+vs\.?\s+/i);
      if (!a || !b) continue;

      let best = null;
      for (const ev of finished) {
        const direct = Math.min(nameScore(a, ev.home), nameScore(b, ev.away));
        const swapped = Math.min(nameScore(a, ev.away), nameScore(b, ev.home));
        const score = Math.max(direct, swapped);
        if (!best || score > best.score) best = { ev, score, swapped: swapped > direct };
      }
      if (!best || best.score < minScore || !best.ev.score) continue;

      /* Orient score to matchup order (player A vs player B), not Sofascore home/away. */
      let display = best.ev.score;
      if (best.swapped) {
        display = best.ev.score.split(' ').map(set => {
          const [x, y] = set.split('-');
          return x != null && y != null ? `${y}-${x}` : set;
        }).join(' ');
      }

      const r = await query(
        `update ${t('markets')} set
           final_score = $2,
           score_source = $3
         where ticker = $1 and final_score is null`,
        [m.ticker, display, 'sofascore'],
      );
      updated += r.rowCount ?? 0;

      /* Same score on the other side of the event (opponent ticker). */
      await query(
        `update ${t('markets')} set
           final_score = $2,
           score_source = $3
         where event_ticker = $1 and ticker <> $4 and final_score is null`,
        [m.event_ticker, display, 'sofascore', m.ticker],
      ).catch(() => null);
    }
  }

  return { updated, dates: dates.length, sources: [...sources] };
}
