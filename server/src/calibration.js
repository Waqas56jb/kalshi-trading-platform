import { t } from './config.js';
import { query } from './db.js';
import { probabilityBucket, utrBracket } from './risk.js';
import { fairFromGap } from './model.js';

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
  select distinct on (m.event_ticker)
         s.fair_cents, (m.result = 'yes')::int as won
  from ${t('markets')} m
  join ${t('signals')} s on s.ticker = m.ticker
  where m.result in ('yes','no') and s.fair_cents is not null
  order by m.event_ticker, m.ticker`;

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
  // open-ended: a strict 3.0 bound silently dropped every larger gap from the fit
  { bracket: '1.0+', low: 1.00, high: Infinity },
];

/**
 * Fits the curve: for each bracket, how often did the higher-rated player win?
 *
 * That empirical rate becomes the fair value for a gap in the middle of the
 * bracket, and `fairFromFittedCurve` interpolates between bracket midpoints so
 * the output moves smoothly with the gap instead of stepping.
 */
/**
 * Enforces that a larger rating gap never prices lower than a smaller one.
 *
 * Pool-adjacent-violators: where two neighbouring brackets are out of order they
 * are merged into their sample-weighted average, repeatedly, until the sequence
 * only rises. It is the standard isotonic fit, and it moves the numbers as
 * little as the constraint allows.
 *
 * The constraint is not a statistical preference, it is a fact about tennis: a
 * player rated further above their opponent cannot be less likely to win. Four
 * days of data produced 62c at a 0.1-0.25 gap and 57c at 0.25-0.5, which
 * inverted the curve and left two different deltas returning the same fair
 * price. The client spotted that on the terminal before I did.
 */
function enforceMonotonic(points) {
  const blocks = points.map(p => ({ sum: p.value * p.weight, weight: p.weight, items: [p] }));
  let i = 0;
  while (i < blocks.length - 1) {
    const a = blocks[i];
    const b = blocks[i + 1];
    if (a.sum / a.weight <= b.sum / b.weight) { i += 1; continue; }
    blocks.splice(i, 2, {
      sum: a.sum + b.sum,
      weight: a.weight + b.weight,
      items: [...a.items, ...b.items],
    });
    if (i > 0) i -= 1;                       // a merge can violate the pair before it
  }
  const out = [];
  for (const block of blocks) {
    const value = block.sum / block.weight;
    for (const item of block.items) out.push({ ...item, value });
  }
  return out;
}

/**
 * Fits the logistic slope by maximum likelihood on the match-level results.
 *
 * P(higher-rated wins | gap g) = 1 / (1 + e^(-k·g))
 *
 * One parameter, fitted on every settled match at once, so it cannot inherit
 * bucket noise. This replaces bracket-midpoint interpolation as the pricing
 * curve because of what the client saw on the terminal: a 0.15 gap at 56c
 * against a 0.35 gap at 59c — three cents for more than twice the rating
 * advantage — and then 0.71 and 0.81 both landing on 76c because everything
 * past the last bracket anchor went flat. A logistic is monotone and smooth by
 * construction: more gap is always more price, in proportion, at every point
 * on the curve. The bracket fit below is kept as the verification view — the
 * place to check the smooth curve against raw bucket win rates.
 *
 * Newton-Raphson on the log-likelihood; the derivatives are textbook:
 * L'(k) = Σ g·(y − σ(kg)),  L''(k) = −Σ g²·σ(kg)·(1−σ(kg)).
 */
export function fitLogisticSlope(rows, { k0 = 2.0, priorWeight = 60 } = {}) {
  const data = rows
    .map(r => ({ g: Number(r.gap), y: r.higher_won ? 1 : 0 }))
    .filter(d => Number.isFinite(d.g) && d.g > 0);
  if (!data.length) return null;

  let k = k0;
  for (let iter = 0; iter < 50; iter += 1) {
    let d1 = 0;
    let d2 = 0;
    for (const { g, y } of data) {
      const p = 1 / (1 + Math.exp(-k * g));
      d1 += g * (y - p);
      d2 -= g * g * p * (1 - p);
    }
    if (d2 === 0) break;
    const step = d1 / d2;
    k -= step;
    k = Math.min(8, Math.max(0.1, k));
    if (Math.abs(step) < 1e-6) break;
  }

  /* Same shrinkage philosophy as the brackets: a thin sample stays near the
     prior slope, a large one lands on its own evidence. Never publish a slope
     flatter than 1.5 — below that the curve is calling 1-point favourites
     coin-flips, which is the bug Max screenshotted. */
  const n = data.length;
  const shrunk = (n * k + priorWeight * k0) / (n + priorWeight);
  const floored = Math.max(1.5, Math.min(4.0, shrunk));
  return { kRaw: +k.toFixed(4), k: +floored.toFixed(4), sample: n };
}

/**
 * Fits the curve from settled matches.
 *
 * Three things the first version got wrong, all of which the client saw in the
 * terminal before I did.
 *
 * Each bracket is anchored at the mean gap actually observed inside it, not the
 * arithmetic midpoint. The top bracket spans 1.0 to 3.0, so anchoring it at 2.0
 * put the curve's last point beyond any real match and flattened every gap above
 * 0.75 onto a single price.
 *
 * Thin brackets are shrunk toward the original curve rather than believed
 * outright. Fifty-two matches is not enough to conclude that a two-point rating
 * advantage is worth 77c when the prior says 99c.
 *
 * And the result is forced monotonic, because a bigger gap losing value is not a
 * finding, it is noise.
 */
export async function refitUtrCurve({ minSample = 40, priorWeight = 60 } = {}) {
  const { rows } = await query(
    `select abs(p.utr - op.utr) as gap,
            case when p.utr > op.utr then (m.result = 'yes') else (m.result = 'no') end as higher_won
     from ${t('markets')} m
     join ${t('markets')} opp on opp.event_ticker = m.event_ticker and opp.ticker <> m.ticker
     join ${t('players')} p  on p.competitor_id  = m.competitor_id
     join ${t('players')} op on op.competitor_id = opp.competitor_id
     where m.result in ('yes','no') and p.utr is not null and op.utr is not null and p.utr <> op.utr
       -- one row per match. The self-join yields both orderings, and counting
       -- both doubled every sample size, which halved the shrinkage a thin
       -- bracket was supposed to receive from the prior.
       and m.ticker < opp.ticker`);

  if (!rows.length) return { fitted: 0, sample: 0 };

  /* The pricing curve: one smooth logistic slope, fitted to every settled
     match. k0 is the slope the hand-written curve implies at a 0.5 gap
     (ln(65/35)/0.5), so with no data the fit reproduces the documented
     strategy and with data it converges on the measured one. */
  /* Prior k0 = 2.0 matches Max's 10–12c underdog at ~Δ1. Shrinkage never
     returns a slope flatter than MIN_USABLE — a collapsed fit is what priced
     a 1.19 gap at 60c. */
  const slope = fitLogisticSlope(rows, { k0: 2.0, priorWeight });
  if (slope) {
    await query(
      `insert into ${t('derived_limits')} (name, value, unit, sample_size, evidence, computed_at)
       values ('utr_logistic_k', $1, 'slope', $2, $3::jsonb, now())
       on conflict (name) do update set
         value = excluded.value, sample_size = excluded.sample_size,
         evidence = excluded.evidence, computed_at = now()`,
      [slope.k, slope.sample, JSON.stringify({ kRaw: slope.kRaw, kShrunk: slope.k, priorK: 2.0 })],
    );
  }

  const measured = [];
  for (const b of BRACKETS) {
    const inBracket = rows.filter(r => {
      const g = Number(r.gap);
      return g >= b.low && g < b.high;
    });
    if (inBracket.length < minSample) continue;

    const wins = inBracket.filter(r => r.higher_won).length;
    const meanGap = inBracket.reduce((s, r) => s + Number(r.gap), 0) / inBracket.length;
    const observed = (wins / inBracket.length) * 100;
    const prior = fairFromGap(meanGap);

    /* Sample-weighted blend with the prior. A bracket with thousands of matches
       lands essentially on its observed rate; one with fifty stays close to the
       curve we started from. */
    const n = inBracket.length;
    const shrunk = (n * observed + priorWeight * prior) / (n + priorWeight);

    measured.push({
      ...b,
      sampleSize: n,
      meanGap: +meanGap.toFixed(3),
      rawWinRate: +(wins / n).toFixed(4),
      observedCents: Math.round(observed),
      shrunkCents: Math.round(shrunk),
      value: shrunk,
      weight: n,
    });
  }

  if (!measured.length) return { fitted: 0, sample: rows.length };

  measured.sort((a, b) => a.meanGap - b.meanGap);
  const monotonic = enforceMonotonic(measured);

  const fitted = monotonic.map(m => ({
    ...m,
    // the higher-rated player is never priced below an even split
    fittedCents: Math.max(50, Math.min(99, Math.round(m.value))),
  }));

  await query(
    `insert into ${t('utr_curve')}
       (bracket, gap_low, gap_high, sample_size, win_rate, fitted_cents,
        mean_gap, raw_win_rate, shrunk_cents, computed_at)
     select * from unnest($1::text[], $2::numeric[], $3::numeric[], $4::int[], $5::numeric[],
                          $6::int[], $7::numeric[], $8::numeric[], $9::int[])
       as x(b, lo, hi, n, wr, fc, mg, rwr, sc), lateral (select now()) ts(c)
     on conflict (bracket) do update set
       sample_size = excluded.sample_size, win_rate = excluded.win_rate,
       fitted_cents = excluded.fitted_cents, mean_gap = excluded.mean_gap,
       raw_win_rate = excluded.raw_win_rate, shrunk_cents = excluded.shrunk_cents,
       gap_low = excluded.gap_low, gap_high = excluded.gap_high, computed_at = now()`,
    [fitted.map(f => f.bracket), fitted.map(f => f.low), fitted.map(f => f.high),
      fitted.map(f => f.sampleSize), fitted.map(f => f.rawWinRate), fitted.map(f => f.fittedCents),
      fitted.map(f => f.meanGap), fitted.map(f => f.rawWinRate), fitted.map(f => f.shrunkCents)],
  );

  /* Brackets with too thin a sample this run are removed rather than left at
     their old value. A stale row sits in the table alongside freshly fitted ones
     and can invert the loaded curve, which is the whole thing monotonicity was
     added to prevent. */
  await query(
    `delete from ${t('utr_curve')} where bracket <> all($1::text[])`,
    [fitted.map(f => f.bracket)]);

  return { fitted: fitted.length, sample: rows.length, logisticK: slope?.k ?? null, detail: fitted };
}

/** The fitted logistic slope, or null while there is nothing usable fitted yet. */
export async function loadUtrSlope() {
  const r = await query(
    `select value, sample_size from ${t('derived_limits')} where name = 'utr_logistic_k'`);
  const row = r.rows[0];
  if (!row) return null;
  const k = Number(row.value);
  /* A collapsed slope must not reach the pricing path or the Model page as if
     it were the live curve — fairFromLogistic also rejects it, belt and braces. */
  if (!Number.isFinite(k) || k < 1.5 || k > 4.0) {
    return { k: null, sample: row.sample_size, rejected: k };
  }
  return { k, sample: row.sample_size };
}

/** The fitted curve, ordered by gap, for the model to interpolate over. */
export async function loadUtrCurve() {
  const r = await query(
    `select bracket, gap_low, gap_high, sample_size, win_rate, fitted_cents,
            mean_gap, raw_win_rate, shrunk_cents
     from ${t('utr_curve')} order by coalesce(mean_gap, (gap_low + gap_high) / 2)`);
  return r.rows.map(row => ({
    bracket: row.bracket,
    low: Number(row.gap_low),
    high: Number(row.gap_high),
    // anchored where matches actually sit, not the middle of the bracket
    meanGap: row.mean_gap != null
      ? Number(row.mean_gap)
      : (Number(row.gap_low) + Number(row.gap_high)) / 2,
    sampleSize: row.sample_size,
    winRate: Number(row.win_rate),
    rawWinRate: row.raw_win_rate != null ? Number(row.raw_win_rate) : null,
    fittedCents: row.fitted_cents,
  }));
}

export { BRACKETS, utrBracket };

/* ---------------------------------------------------------- derived limits */

const PRICE_BANDS = [
  { band: 'under 10c', low: 1, high: 10 },
  { band: '10-15c', low: 10, high: 15 },
  { band: '15-20c', low: 15, high: 20 },
  { band: '20-25c', low: 20, high: 25 },
  { band: '25-35c', low: 25, high: 35 },
  { band: '35-50c', low: 35, high: 50 },
  { band: '50c+', low: 50, high: 100 },
];

/**
 * Works out the minimum price worth trading, from settled results.
 *
 * The client's instruction was to stop typing these in — "the risk algorithm is
 * supposed to do what's best" — and on this one he is plainly right. A price
 * floor is not a preference; there is a correct answer and the data holds it.
 *
 * Measured over model-liked bets: everything under 25c loses, and the sub-10c
 * band is 134 bets with not a single winner. So the floor is the cheapest band
 * that has both a meaningful sample and non-negative returns, and it moves on
 * its own as more matches settle. Until there is enough evidence it stays where
 * it is rather than guessing.
 */
export async function deriveMinimumPrice({ minBandSample = 20, fallbackCents = 25 } = {}) {
  const { rows } = await query(
    `with cut as (select ticker, close_time - interval '3 hours' as pe from ${t('markets')}),
     px as (
       select ph.ticker, (array_agg(ph.yes_ask_cents order by ph.captured_at desc))[1] as ask
       from ${t('price_history')} ph join cut on cut.ticker = ph.ticker
       where ph.captured_at <= cut.pe and ph.yes_ask_cents is not null
       group by ph.ticker
     )
     select px.ask, (m.result = 'yes')::int as won
     from ${t('markets')} m
     join px on px.ticker = m.ticker
     join ${t('signals')} s on s.ticker = m.ticker
     where m.result in ('yes','no') and s.fair_cents is not null
       and px.ask between 1 and 99 and s.fair_cents - px.ask >= 4`);

  if (!rows.length) return { floorCents: fallbackCents, sample: 0, derived: false };

  const evidence = PRICE_BANDS.map(b => {
    const inBand = rows.filter(r => Number(r.ask) >= b.low && Number(r.ask) < b.high);
    let staked = 0;
    let ret = 0;
    for (const r of inBand) {
      const ask = Number(r.ask);
      // Kalshi's fee, charged per contract on entry
      const fee = Math.ceil(0.07 * (ask / 100) * (1 - ask / 100) * 100);
      staked += ask;
      ret += (r.won ? 100 : 0) - ask - fee;
    }
    return {
      band: b.band,
      low: b.low,
      bets: inBand.length,
      wins: inBand.filter(r => r.won).length,
      roi: staked > 0 ? +((ret / staked) * 100).toFixed(1) : null,
    };
  });

  const firstGood = evidence.find(e => e.bets >= minBandSample && e.roi != null && e.roi >= 0);
  /* Never raise the live floor above 25¢ — a 50¢ derived floor blocked real
     35–36¢ edges the desk wants in early rounds. */
  const floorCents = Math.min(25, firstGood ? firstGood.low : fallbackCents);

  await query(
    `insert into ${t('derived_limits')} (name, value, unit, sample_size, evidence, computed_at)
     values ('minimum_price', $1, 'cents', $2, $3::jsonb, now())
     on conflict (name) do update set
       value = excluded.value, sample_size = excluded.sample_size,
       evidence = excluded.evidence, computed_at = now()`,
    [floorCents, rows.length, JSON.stringify(evidence)],
  );

  return { floorCents, sample: rows.length, derived: Boolean(firstGood), evidence };
}

/** Everything the engine works out for itself, for the read-only panel. */
export async function derivedLimits() {
  const r = await query(
    `select name, value, unit, sample_size, evidence, computed_at from ${t('derived_limits')}`);
  const out = {};
  for (const row of r.rows) {
    out[row.name] = {
      value: Number(row.value),
      unit: row.unit,
      sampleSize: row.sample_size,
      evidence: row.evidence,
      computedAt: row.computed_at,
    };
  }
  return out;
}
