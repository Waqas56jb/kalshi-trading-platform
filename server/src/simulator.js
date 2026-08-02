import { t } from './config.js';
import { query } from './db.js';
import { fairFromGap, fairFromLogistic } from './model.js';
import { loadUtrSlope } from './calibration.js';

/**
 * Replays every settled match against three fair-value formulas and reports
 * the P&L each would have produced — the client's request, verbatim: "simulate
 * P and L of three different weighted formulas so we can see how our formula
 * needs to adjust".
 *
 * The replay is honest about what was knowable: the entry price is the last
 * recorded ask at least three hours before the market closed (the same
 * pre-close cut the minimum-price derivation uses), never a post-hoc price.
 * Kalshi's per-contract fee is charged on every simulated entry.
 *
 * Three formulas, all fed the same UTR gap:
 *   1. fitted   — the logistic curve fitted by maximum likelihood on settled
 *                 matches (what the engine runs today).
 *   2. hand     — the documented hand-written curve the client originally
 *                 specified (50+30g / 65+40(g-.5) / 85+14(g-1)).
 *   3. blend    — the fitted curve shrunk toward the market price with the
 *                 engine's 60/40 model weight, i.e. what conservative sizing
 *                 actually prices from.
 *
 * Results are split favourite (ask ≥ 50c) vs underdog, because the standing
 * criticism is that the model is "way too underdog reliant" — the split shows
 * where each formula's P&L actually comes from.
 */
export async function simulateFormulas({
  minEdgeCents = 4,
  stakeUsd = 100,
  floorCents = 25,
  modelWeight = 0.6,
} = {}) {
  const { rows } = await query(
    `with cut as (select ticker, close_time - interval '3 hours' as pe from ${t('markets')}),
     px as (
       select ph.ticker, (array_agg(ph.yes_ask_cents order by ph.captured_at desc))[1] as ask
       from ${t('price_history')} ph join cut on cut.ticker = ph.ticker
       where ph.captured_at <= cut.pe and ph.yes_ask_cents is not null
       group by ph.ticker
     )
     select px.ask, (m.result = 'yes')::int as won, s.utr_gap
     from ${t('markets')} m
     join px on px.ticker = m.ticker
     join ${t('signals')} s on s.ticker = m.ticker
     where m.result in ('yes','no') and s.utr_gap is not null
       and px.ask between 1 and 99`);

  const slope = await loadUtrSlope().catch(() => null);
  const k = slope?.k ?? 1.24;

  const formulas = [
    {
      id: 'fitted_logistic',
      name: `Fitted logistic (k = ${k.toFixed(2)}, from settled matches)`,
      fair: gap => fairFromLogistic(gap, k),
    },
    {
      id: 'hand_curve',
      name: 'Original hand-written curve',
      fair: gap => fairFromGap(gap),
    },
    {
      id: 'market_blend',
      name: `Fitted logistic blended ${Math.round(modelWeight * 100)}/${Math.round((1 - modelWeight) * 100)} with the market`,
      fair: (gap, ask) => {
        const f = fairFromLogistic(gap, k);
        return f == null ? null : Math.round(modelWeight * f + (1 - modelWeight) * ask);
      },
    },
  ];

  const results = formulas.map(f => {
    const mk = () => ({ bets: 0, wins: 0, stakedUsd: 0, pnlUsd: 0 });
    const total = mk();
    const bySide = { favourite: mk(), underdog: mk() };

    for (const r of rows) {
      const ask = Number(r.ask);
      const gap = Number(r.utr_gap);
      const fair = f.fair(gap, ask);
      if (fair == null || ask < floorCents || fair - ask < minEdgeCents) continue;

      const contracts = Math.max(1, Math.floor((stakeUsd * 100) / ask));
      // Kalshi's trading fee, charged per contract on entry
      const feeCents = Math.ceil(0.07 * (ask / 100) * (1 - ask / 100) * 100);
      const costCents = contracts * (ask + feeCents);
      const pnlCents = (r.won ? contracts * 100 : 0) - costCents;

      for (const agg of [total, bySide[ask >= 50 ? 'favourite' : 'underdog']]) {
        agg.bets += 1;
        agg.wins += r.won ? 1 : 0;
        agg.stakedUsd += costCents / 100;
        agg.pnlUsd += pnlCents / 100;
      }
    }

    const finish = a => ({
      bets: a.bets,
      wins: a.wins,
      winRatePct: a.bets ? +((a.wins / a.bets) * 100).toFixed(1) : null,
      stakedUsd: +a.stakedUsd.toFixed(2),
      pnlUsd: +a.pnlUsd.toFixed(2),
      roiPct: a.stakedUsd > 0 ? +((a.pnlUsd / a.stakedUsd) * 100).toFixed(1) : null,
    });

    return {
      id: f.id,
      name: f.name,
      ...finish(total),
      favourite: finish(bySide.favourite),
      underdog: finish(bySide.underdog),
    };
  });

  return {
    sample: rows.length,
    logisticK: k,
    params: { minEdgeCents, stakeUsd, floorCents, modelWeight },
    formulas: results,
  };
}
