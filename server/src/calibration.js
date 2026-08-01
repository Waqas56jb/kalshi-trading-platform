import { t } from './config.js';
import { query } from './db.js';
import { probabilityBucket, utrBracket } from './risk.js';

/**
 * Measures how well the model actually predicts, and re-fits the UTR curve from
 * settled results.
 *
 * This exists because the hand-written curve was wrong and nobody could see it.
 * Measured against 756 settled matches it is accurate between 20% and 90% but
 * badly overconfident at both extremes, and too timid at a 0.5 UTR gap — it
 * says 65% where the real figure is 78%. Those numbers were never fitted to
 * anything; they were my estimate. This replaces the estimate with the data.
 *
 * Extremes are deliberately kept in the fit. The client suggested removing them,
 * and it is the one place I pushed back: the extremes are exactly where the
 * curve is wrong, so dropping them from the fit means it never learns that.
 * What we filter when trading is a separate decision, handled by the price
 * floor in the risk engine.
 */

/* Calibration needs settled predictions, not settled trades. The model priced
   every match whether we bet it or not, so the usable sample is hundreds of
   rows rather than the nine positions actually taken. */
const SETTLED_PREDICTIONS = `
  select s.fair_cents, (m.result = 'yes')::int as won
  from ${t('markets')} m
  join ${t('signals')} s on s.ticker = m.ticker
  where m.result in ('yes','no') and s.fair_cents is not null`;

/**
 * Recomputes per-bucket calibration.
 *
 * `verified` is set only where the sample is real and large enough to mean
 * something. The risk engine refuses the upper Kelly tiers without it, so a
 * thin bucket cannot buy trust it has not earned.
 */
export async function recomputeCalibration({ minSample = 40 } = {}) {
  const { rows } = await query(SETTLED_PREDICTIONS);
  if (!rows.length) return { buckets: 0, verified: 0, sample: 0 };

  const byBucket = new Map();
  for (const r of rows) {
    const p = Number(r.fair_cents) / 100;
    const bucket = probabilityBucket(p);
    if (!byBucket.has(bucket)) byBucket.set(bucket, { predicted: [], won: 0 });
    const b = byBucket.get(bucket);
    b.predicted.push(p);
    b.won += r.won;
  }

  const out = [];
  for (const [bucket, b] of byBucket) {
    const n = b.predicted.length;
    const meanPredicted = b.predicted.reduce((s, v) => s + v, 0) / n;
    const actual = b.won / n;
    out.push({
      bucket,
      sampleSize: n,
      meanPredicted: +meanPredicted.toFixed(4),
      actual: +actual.toFixed(4),
      error: +Math.abs(actual - meanPredicted).toFixed(4),
      verified: n >= minSample,
    });
  }

  await query(
    `insert into ${t('calibration')}
       (bucket, sample_size, mean_predicted, actual_rate, calibration_error, verified, computed_at)
     select * from unnest($1::text[], $2::int[], $3::numeric[], $4::numeric[], $5::numeric[], $6::boolean[])
       as x(b, n, mp, ar, ce, v), lateral (select now()) ts(computed_at)
     on conflict (bucket) do update set
       sample_size = excluded.sample_size, mean_predicted = excluded.mean_predicted,
       actual_rate = excluded.actual_rate, calibration_error = excluded.calibration_error,
       verified = excluded.verified, computed_at = now()`,
    [out.map(o => o.bucket), out.map(o => o.sampleSize), out.map(o => o.meanPredicted),
      out.map(o => o.actual), out.map(o => o.error), out.map(o => o.verified)],
  );

  return {
    buckets: out.length,
    verified: out.filter(o => o.verified).length,
    sample: rows.length,
    detail: out.sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}

/** Calibration for one bucket, in the shape the risk engine expects. */
export async function calibrationFor(bucket) {
  const r = await query(
    `select sample_size, calibration_error, verified from ${t('calibration')} where bucket = $1`,
    [bucket]);
  const row = r.rows[0];
  if (!row) return { sampleSize: 0, calibrationError: 1, verified: false };
  return {
    sampleSize: row.sample_size,
    calibrationError: Number(row.calibration_error),
    verified: row.verified,
  };
}

export async function calibrationMap() {
  const r = await query(`select bucket, sample_size, calibration_error, verified from ${t('calibration')}`);
  const map = new Map();
  for (const row of r.rows) {
    map.set(row.bucket, {
      sampleSize: row.sample_size,
      calibrationError: Number(row.calibration_error),
      verified: row.verified,
    });
  }
  return map;
}

/* ------------------------------------------------------------ UTR curve */

/* The brackets the client asked to collect on, plus a tail. Scaling happens
   inside each bracket as well as between them: a 0.1 gap and a 0.49 gap sit in
   different brackets now, and even within one bracket the fitted rate is
   interpolated rather than flat, which is the substance of the client's point
   that the algorithm should scale within the tiers. */
const BRACKETS = [
  { bracket: '0-0.1', low: 0, high: 0.10 },
  { bracket: '0.1-0.25', low: 0.10, high: 0.25 },
  { bracket: '0.25-0.5', low: 0.25, high: 0.50 },
  { bracket: '0.5-1.0', low: 0.50, high: 1.00 },
  { bracket: '1.0+', low: 1.00, high: 3.00 },
];

/**
 * Fits the curve: for each bracket, how often did the higher-rated player win?
 *
 * That empirical rate becomes the fair value for a gap in the middle of the
 * bracket, and `fairFromFittedCurve` interpolates between bracket midpoints so
 * the output moves smoothly with the gap instead of stepping.
 */
export async function refitUtrCurve({ minSample = 40 } = {}) {
  const { rows } = await query(
    `select abs(p.utr - op.utr) as gap,
            case when p.utr > op.utr then (m.result = 'yes') else (m.result = 'no') end as higher_won
     from ${t('markets')} m
     join ${t('markets')} opp on opp.event_ticker = m.event_ticker and opp.ticker <> m.ticker
     join ${t('players')} p  on p.competitor_id  = m.competitor_id
     join ${t('players')} op on op.competitor_id = opp.competitor_id
     where m.result in ('yes','no') and p.utr is not null and op.utr is not null and p.utr <> op.utr`);

  if (!rows.length) return { fitted: 0, sample: 0 };

  const fitted = [];
  for (const b of BRACKETS) {
    const inBracket = rows.filter(r => {
      const g = Number(r.gap);
      return g >= b.low && g < b.high;
    });
    if (inBracket.length < minSample) continue;

    const wins = inBracket.filter(r => r.higher_won).length;
    const rate = wins / inBracket.length;
    fitted.push({
      ...b,
      sampleSize: inBracket.length,
      winRate: +rate.toFixed(4),
      /* Never emit a fair value below an even split for the higher-rated player:
         a fitted rate under 50% on a thin bracket is noise, not a claim that
         being better rated makes you lose. */
      fittedCents: Math.max(50, Math.min(99, Math.round(rate * 100))),
    });
  }

  if (!fitted.length) return { fitted: 0, sample: rows.length };

  await query(
    `insert into ${t('utr_curve')} (bracket, gap_low, gap_high, sample_size, win_rate, fitted_cents, computed_at)
     select * from unnest($1::text[], $2::numeric[], $3::numeric[], $4::int[], $5::numeric[], $6::int[])
       as x(b, lo, hi, n, wr, fc), lateral (select now()) ts(c)
     on conflict (bracket) do update set
       sample_size = excluded.sample_size, win_rate = excluded.win_rate,
       fitted_cents = excluded.fitted_cents, computed_at = now()`,
    [fitted.map(f => f.bracket), fitted.map(f => f.low), fitted.map(f => f.high),
      fitted.map(f => f.sampleSize), fitted.map(f => f.winRate), fitted.map(f => f.fittedCents)],
  );

  return { fitted: fitted.length, sample: rows.length, detail: fitted };
}

/** The fitted curve, ordered by gap, for the model to interpolate over. */
export async function loadUtrCurve() {
  const r = await query(
    `select bracket, gap_low, gap_high, sample_size, win_rate, fitted_cents
     from ${t('utr_curve')} order by gap_low`);
  return r.rows.map(row => ({
    bracket: row.bracket,
    low: Number(row.gap_low),
    high: Number(row.gap_high),
    sampleSize: row.sample_size,
    winRate: Number(row.win_rate),
    fittedCents: row.fitted_cents,
  }));
}

export { BRACKETS, utrBracket };
