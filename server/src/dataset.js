import { t } from './config.js';
import { query } from './db.js';

/**
 * Builds the training dataset.
 *
 * One row is one player's side of one match, which is the unit a model actually
 * predicts on. Every match therefore appears twice, once from each player's
 * point of view, and the two rows carry opposite labels — which is why the class
 * balance comes out at exactly 50/50 and should not be read as a happy accident.
 *
 * The hard part here is leakage, not SQL. A settled market's last traded price
 * is 0c or 100c because the match has finished, so a model handed the closing
 * quote scores near-perfect accuracy and has learned nothing but how to read the
 * scoreboard. Columns are therefore split into two groups by prefix:
 *
 *   prematch_ / open_ / utr_ / model_   safe to train on
 *   final_                              leakage; for analysis only
 *
 * The cut is drawn three hours before close_time. Kalshi closes a tennis market
 * when the match ends, and ITF singles run one to three hours, so that boundary
 * sits at or before first serve for almost every match. It is deliberately
 * conservative: losing an hour of genuine pre-match signal costs far less than
 * letting one in-play tick through.
 */

const RANGES = {
  day: '1 day',
  week: '7 days',
  month: '30 days',
  season: '180 days',
  all: null,
};

export const RANGE_NAMES = Object.keys(RANGES);

/* Order matters: this is the column order in the exported file. */
export const COLUMNS = [
  // ---- identifiers, not features ----
  'match_date', 'ticker', 'event_ticker', 'tour', 'tournament', 'round', 'tour_level',
  'player_name', 'opponent_name',
  // ---- ratings ----
  'player_utr', 'opponent_utr', 'utr_gap', 'player_utr_rated', 'opponent_utr_rated',
  // ---- model ----
  'model_fair_prob', 'model_edge_cents', 'side_type',
  // ---- market, pre-match only ----
  'open_mid_cents', 'open_prob',
  'prematch_bid_cents', 'prematch_ask_cents', 'prematch_mid_cents', 'prematch_spread_cents',
  'prematch_prob', 'opponent_prematch_mid_cents', 'devig_prob', 'devig_overround',
  'prematch_volume', 'prematch_open_interest', 'prematch_liquidity',
  // ---- pre-match price dynamics ----
  'prematch_ticks', 'prematch_min_cents', 'prematch_max_cents', 'prematch_range_cents',
  'prematch_drift_cents', 'prematch_stddev_cents', 'hours_observed_prematch',
  // ---- timing ----
  'close_time', 'match_dow', 'match_month',
  // ---- leakage: analysis only ----
  'final_mid_cents', 'final_last_price_cents', 'final_volume',
  // ---- target ----
  'settlement_value', 'won',
];

/** Columns a model may legitimately train on. */
export const FEATURE_COLUMNS = COLUMNS.filter(c =>
  !c.startsWith('final_')
  && !['match_date', 'ticker', 'event_ticker', 'player_name', 'opponent_name',
    'close_time', 'settlement_value', 'won'].includes(c));

export const TARGET_COLUMN = 'won';

export async function buildDataset({ range = 'week' } = {}) {
  if (!(range in RANGES)) throw new Error(`unknown range: ${range}`);
  const interval = RANGES[range];

  const rows = await query(
    `with cut as (
       select m.ticker, m.close_time - interval '3 hours' as prematch_end
       from ${t('markets')} m
     ),
     hist as (
       select ph.ticker,
              count(*)::int                                  as ticks,
              min(ph.mid_cents)                              as min_c,
              max(ph.mid_cents)                              as max_c,
              round(stddev_samp(ph.mid_cents)::numeric, 3)   as sd_c,
              (array_agg(ph.mid_cents order by ph.captured_at))[1]                  as first_c,
              (array_agg(ph.mid_cents order by ph.captured_at desc))[1]             as last_c,
              (array_agg(ph.yes_bid_cents order by ph.captured_at desc))[1]         as last_bid,
              (array_agg(ph.yes_ask_cents order by ph.captured_at desc))[1]         as last_ask,
              (array_agg(ph.volume order by ph.captured_at desc))[1]                as last_vol,
              round(extract(epoch from (max(ph.captured_at) - min(ph.captured_at)))::numeric
                    / 3600, 2)                               as hours_observed
       from ${t('price_history')} ph
       join cut on cut.ticker = ph.ticker
       where ph.captured_at <= cut.prematch_end and ph.mid_cents is not null
       group by ph.ticker
     )
     select
       /* 238 of 756 settled markets carry no match_date — they were stored before
          the column existed — but every one has a close_time. Falling back to it
          keeps them in the day and week exports instead of silently dropping a
          third of the history. */
       coalesce(m.match_date,
                (m.settled_at  at time zone 'America/Los_Angeles')::date,
                (m.close_time  at time zone 'America/Los_Angeles')::date)::text
                                                as match_date,
       m.ticker, m.event_ticker,
       case when m.series_ticker like '%W%' then 'ITF women' else 'ITF men' end as tour,
       e.tournament, e.round, e.tour_level,
       m.player_name,
       opp.player_name                          as opponent_name,

       p.utr::float                             as player_utr,
       op.utr::float                            as opponent_utr,
       round((p.utr - op.utr)::numeric, 3)::float as utr_gap,
       (p.utr_status  = 'Rated')::int           as player_utr_rated,
       (op.utr_status = 'Rated')::int           as opponent_utr_rated,

       round(s.fair_cents::numeric / 100, 4)::float as model_fair_prob,
       (s.fair_cents - s.market_cents)          as model_edge_cents,
       s.side_type,

       h.first_c                                as open_mid_cents,
       round(h.first_c::numeric / 100, 4)::float as open_prob,

       h.last_bid                               as prematch_bid_cents,
       h.last_ask                               as prematch_ask_cents,
       h.last_c                                 as prematch_mid_cents,
       (h.last_ask - h.last_bid)                as prematch_spread_cents,
       round(h.last_c::numeric / 100, 4)::float as prematch_prob,
       oh.last_c                                as opponent_prematch_mid_cents,
       -- vig removed by normalising the two sides to sum to one
       case when h.last_c + oh.last_c > 0
            then round(h.last_c::numeric / (h.last_c + oh.last_c), 4) end::float as devig_prob,
       case when h.last_c + oh.last_c > 0
            then round((h.last_c + oh.last_c)::numeric / 100, 4) end::float      as devig_overround,
       h.last_vol                               as prematch_volume,
       m.open_interest::float                   as prematch_open_interest,
       m.liquidity::float                       as prematch_liquidity,

       h.ticks                                  as prematch_ticks,
       h.min_c                                  as prematch_min_cents,
       h.max_c                                  as prematch_max_cents,
       (h.max_c - h.min_c)                      as prematch_range_cents,
       (h.last_c - h.first_c)                   as prematch_drift_cents,
       h.sd_c::float                            as prematch_stddev_cents,
       h.hours_observed::float                  as hours_observed_prematch,

       to_char(m.close_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as close_time,
       extract(dow from coalesce(m.match_date,
         (m.settled_at at time zone 'America/Los_Angeles')::date,
         (m.close_time at time zone 'America/Los_Angeles')::date))::int   as match_dow,
       extract(month from coalesce(m.match_date,
         (m.settled_at at time zone 'America/Los_Angeles')::date,
         (m.close_time at time zone 'America/Los_Angeles')::date))::int   as match_month,

       m.last_price_cents                       as final_mid_cents,
       m.last_price_cents                       as final_last_price_cents,
       m.volume::float                          as final_volume,

       m.settlement_value::float                as settlement_value,
       (m.result = 'yes')::int                  as won
     from ${t('markets')} m
     join ${t('markets')} opp
       on opp.event_ticker = m.event_ticker and opp.ticker <> m.ticker
     left join ${t('players')}  p  on p.competitor_id  = m.competitor_id
     left join ${t('players')}  op on op.competitor_id = opp.competitor_id
     left join ${t('events')}   e  on e.event_ticker   = m.event_ticker
     left join ${t('signals')}  s  on s.ticker         = m.ticker
     left join hist h  on h.ticker = m.ticker
     left join hist oh on oh.ticker = opp.ticker
     where m.result in ('yes','no')
       ${interval ? `and coalesce(m.match_date,
               (m.settled_at at time zone 'America/Los_Angeles')::date,
               (m.close_time at time zone 'America/Los_Angeles')::date)
             >= (now() at time zone 'America/Los_Angeles')::date - interval '${interval}'` : ''}
     order by 1 desc, m.event_ticker, m.ticker`,
  );

  return { columns: COLUMNS, rows: rows.rows };
}

/** Headline numbers, so the export can state what it contains rather than imply it. */
export async function datasetSummary({ range = 'week' } = {}) {
  const { rows } = await buildDataset({ range });
  const labelled = rows.length;
  const wins = rows.filter(r => r.won === 1).length;
  const withUtr = rows.filter(r => r.player_utr != null && r.opponent_utr != null).length;
  const withPrematch = rows.filter(r => r.prematch_mid_cents != null).length;
  const dates = rows.map(r => r.match_date).filter(Boolean).sort();

  return {
    range,
    rows: labelled,
    matches: Math.round(labelled / 2),
    wins,
    losses: labelled - wins,
    class_balance: labelled ? +(wins / labelled).toFixed(3) : null,
    complete_utr_pairs: withUtr,
    with_prematch_prices: withPrematch,
    first_match: dates[0] ?? null,
    last_match: dates[dates.length - 1] ?? null,
    feature_columns: FEATURE_COLUMNS.length,
    target: TARGET_COLUMN,
  };
}

/* ------------------------------------------------------------- breakdowns */

/**
 * The profitability breakdowns the client asked for: by month, by day of week,
 * by round, and men's against women's.
 *
 * Measured on the model's own calls rather than on trades, for the same reason
 * calibration is: nine settled positions cannot support a breakdown, but several
 * hundred settled predictions can. `model_hit` is whether the side the model
 * priced above the market actually won.
 */
export async function buildBreakdowns({ range = 'all' } = {}) {
  const { rows } = await buildDataset({ range });

  const scored = rows.filter(r => r.model_fair_prob != null && r.prematch_prob != null);
  const summarise = keyFn => {
    const groups = new Map();
    for (const r of scored) {
      const key = keyFn(r);
      if (key == null || key === '') continue;
      if (!groups.has(key)) groups.set(key, { key, matches: 0, model_liked: 0, hits: 0, edge: 0 });
      const g = groups.get(key);
      g.matches += 1;
      // the model "likes" a side when its fair value sits above the market price
      const liked = r.model_fair_prob > r.prematch_prob;
      if (liked) {
        g.model_liked += 1;
        g.hits += r.won;
        g.edge += (r.model_fair_prob - r.prematch_prob) * 100;
      }
    }
    return [...groups.values()]
      .map(g => ({
        key: g.key,
        matches: Math.round(g.matches / 2),
        model_picks: g.model_liked,
        picks_won: g.hits,
        hit_rate: g.model_liked ? +(g.hits / g.model_liked).toFixed(3) : null,
        avg_claimed_edge_cents: g.model_liked ? +(g.edge / g.model_liked).toFixed(1) : null,
      }))
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  };

  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH = ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  return {
    range,
    rows: scored.length,
    by_month: summarise(r => (r.match_month ? MONTH[r.match_month] : null)),
    by_day_of_week: summarise(r => (r.match_dow != null ? DOW[r.match_dow] : null)),
    by_round: summarise(r => r.round),
    by_tour: summarise(r => r.tour),
    by_tour_level: summarise(r => r.tour_level),
  };
}

/** Flattens the breakdowns into one sheet, so CSV and Excel can carry them all. */
export function breakdownRows(breakdowns) {
  const out = [];
  for (const [dimension, key] of [
    ['Month', 'by_month'], ['Day of week', 'by_day_of_week'], ['Round', 'by_round'],
    ['Tour', 'by_tour'], ['Tour level', 'by_tour_level'],
  ]) {
    for (const row of breakdowns[key] ?? []) out.push({ dimension, ...row });
  }
  return out;
}

export const BREAKDOWN_COLUMNS = [
  'dimension', 'key', 'matches', 'model_picks', 'picks_won', 'hit_rate', 'avg_claimed_edge_cents',
];
