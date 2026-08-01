import { closePool, query } from '../src/db.js';
import { loadRiskConfig } from '../src/shadow.js';
import { evaluateBet, kalshiFeeRate, probabilityBucket, utrBracket } from '../src/risk.js';
import { calibrationMap, loadUtrCurve } from '../src/calibration.js';
import { fairFromFittedCurve, fairFromGap } from '../src/model.js';

/**
 * Replays the risk engine over settled matches.
 *
 * The point is to answer the client's question honestly: does the new engine
 * make money where the old signal lost it? The old one lost at every edge
 * threshold and lost more the bigger the claimed edge, so nothing here should be
 * taken on trust.
 *
 * Prices come from the pre-match window — the last tick at least three hours
 * before the market closed. Using the settled quote would score near-perfectly
 * and mean nothing, since by then the match is over.
 */
async function main() {
  const cfg = await loadRiskConfig();
  const curve = await loadUtrCurve();
  const calibration = await calibrationMap();

  const { rows } = await query(
    `with cut as (select ticker, close_time - interval '3 hours' as pe from public.kalshi_markets),
     px as (
       select ph.ticker,
              (array_agg(ph.yes_ask_cents order by ph.captured_at desc))[1] as ask,
              (array_agg(ph.yes_bid_cents order by ph.captured_at desc))[1] as bid,
              (array_agg(ph.mid_cents     order by ph.captured_at desc))[1] as mid
       from public.kalshi_price_history ph join cut on cut.ticker = ph.ticker
       where ph.captured_at <= cut.pe and ph.yes_ask_cents is not null
       group by ph.ticker
     )
     select m.ticker, m.event_ticker, m.player_name, m.result,
            px.ask, px.bid, px.mid,
            oppx.mid as opponent_mid,
            p.utr as player_utr, op.utr as opponent_utr, p.utr_status,
            coalesce(m.match_date, (m.settled_at at time zone 'America/Los_Angeles')::date) as match_date
     from public.kalshi_markets m
     join px on px.ticker = m.ticker
     join public.kalshi_markets opp
       on opp.event_ticker = m.event_ticker and opp.ticker <> m.ticker
     left join px oppx on oppx.ticker = opp.ticker
     left join public.kalshi_players p  on p.competitor_id  = m.competitor_id
     left join public.kalshi_players op on op.competitor_id = opp.competitor_id
     where m.result in ('yes','no') and px.ask between 1 and 99`);

  /* A fixed bankroll for every decision. Compounding through the replay would
     make the result depend on the order matches happen to settle in, which is
     not something we are trying to measure. */
  const portfolio = {
    bankrollCents: cfg.simulatedBankrollCents,
    cashCents: cfg.simulatedBankrollCents,
    unsettledCents: 0,
    dailyRealisedCents: 0,
    weeklyPeakCents: cfg.simulatedBankrollCents,
    exposure: { match: {}, player: {}, playerDaily: {}, bucket: {}, signal: {} },
  };

  const run = (label, fairFn) => {
    const taken = [];
    const rejected = new Map();

    for (const r of rows) {
      const gap = r.player_utr != null && r.opponent_utr != null
        ? Number(r.player_utr) - Number(r.opponent_utr) : null;
      const fair = fairFn(gap);
      if (fair == null) continue;

      const ask = Number(r.ask) / 100;
      /* The shrinkage anchor is the de-vigged market, not the raw ask. Both
         sides of the match are quoted, so normalising them to sum to one strips
         the spread out of the reference. */
      const oppMid = r.opponent_mid != null ? Number(r.opponent_mid) : null;
      const mid = r.mid != null ? Number(r.mid) : Number(r.ask);
      const marketRef = oppMid != null && mid + oppMid > 0 ? mid / (mid + oppMid) : mid / 100;

      const decision = evaluateBet({
        opportunity: {
          matchId: r.event_ticker,
          playerId: r.player_name,
          modelSignalId: label,
          modelProbability: fair / 100,
          marketReferenceProbability: marketRef,
          priceAtModelTime: ask,
          modelTimestamp: Date.now(),
          marketSnapshotTimestamp: Date.now(),
          // one level, sized generously: the replay is testing the rules, not depth
          orderBookAsks: [{ price: ask, contracts: 100000 }],
          feeRate: kalshiFeeRate(ask),
          slippage: cfg.expectedSlippage,
          dataQualityScore: r.utr_status === 'Rated' ? 1 : 0.7,
        },
        portfolio,
        calibration: calibration.get(probabilityBucket(fair / 100)),
        health: { healthy: true },
        cfg,
        now: Date.now(),
      });

      if (!decision.approved) {
        const key = decision.limitingConstraint ?? 'unknown';
        rejected.set(key, (rejected.get(key) ?? 0) + 1);
        continue;
      }

      const stake = decision.stakeCents;
      const fee = Math.round(decision.contracts * kalshiFeeRate(ask) * 100);
      const payout = r.result === 'yes' ? Math.round(decision.contracts * 100) : 0;
      taken.push({
        pnl: payout - stake - fee,
        stake,
        won: r.result === 'yes',
        bracket: utrBracket(gap),
        ask: Number(r.ask),
      });
    }

    const staked = taken.reduce((s, t) => s + t.stake, 0);
    const pnl = taken.reduce((s, t) => s + t.pnl, 0);
    return {
      label,
      bets: taken.length,
      wins: taken.filter(t => t.won).length,
      winRate: taken.length ? +(taken.filter(t => t.won).length / taken.length).toFixed(3) : null,
      avgAsk: taken.length ? +(taken.reduce((s, t) => s + t.ask, 0) / taken.length).toFixed(1) : null,
      staked: +(staked / 100).toFixed(2),
      pnl: +(pnl / 100).toFixed(2),
      roi: staked > 0 ? +((pnl / staked) * 100).toFixed(1) : null,
      taken,
      rejected: [...rejected.entries()].sort((a, b) => b[1] - a[1]),
    };
  };

  console.log(`settled markets with a pre-match quote: ${rows.length}`);
  console.log(`fitted curve brackets: ${curve.length} | price floor ${cfg.minPriceCents}c`);
  console.log('');

  const before = run('old: hand-written curve, no risk engine', fairFromGap);
  const after = run('new: fitted curve + risk engine', g => fairFromFittedCurve(g, curve));

  console.log('=== the old signal, sized flat, no risk rules ===');
  console.log(bareBacktest(rows));
  console.log('');
  console.log('=== both runs through the risk engine ===');
  console.table([before, after].map(r => ({
    run: r.label, bets: r.bets, 'win %': r.winRate != null ? (r.winRate * 100).toFixed(1) : '—',
    'avg ask': r.avgAsk, staked: r.staked, pnl: r.pnl, 'roi %': r.roi,
  })));

  console.log('');
  console.log('new engine — why trades were rejected:');
  console.table(after.rejected.slice(0, 8).map(([reason, n]) => ({ reason, n })));

  const byBracket = new Map();
  for (const t of after.taken) {
    const k = t.bracket ?? '(no UTR pair)';
    if (!byBracket.has(k)) byBracket.set(k, { bracket: k, bets: 0, wins: 0, staked: 0, pnl: 0 });
    const b = byBracket.get(k);
    b.bets += 1; b.wins += t.won ? 1 : 0; b.staked += t.stake; b.pnl += t.pnl;
  }
  if (byBracket.size) {
    console.log('');
    console.log('new engine — by UTR bracket:');
    console.table([...byBracket.values()].sort((a, b) => a.bracket.localeCompare(b.bracket))
      .map(b => ({
        bracket: b.bracket, bets: b.bets, wins: b.wins,
        'win %': ((b.wins / b.bets) * 100).toFixed(1),
        staked: +(b.staked / 100).toFixed(2), pnl: +(b.pnl / 100).toFixed(2),
        'roi %': b.staked ? +((b.pnl / b.staked) * 100).toFixed(1) : null,
      })));
  }

  await closePool();
}

/** One contract per signal at a 15c edge, which is what the desk used to do. */
function bareBacktest(rows) {
  let bets = 0; let wins = 0; let staked = 0; let pnl = 0;
  for (const r of rows) {
    const gap = r.player_utr != null && r.opponent_utr != null
      ? Number(r.player_utr) - Number(r.opponent_utr) : null;
    const fair = fairFromGap(gap);
    if (fair == null) continue;
    const ask = Number(r.ask);
    if (fair - ask < 15) continue;
    bets += 1;
    staked += ask;
    const fee = Math.round(kalshiFeeRate(ask / 100) * 100);
    if (r.result === 'yes') { wins += 1; pnl += 100 - ask - fee; } else { pnl += -ask - fee; }
  }
  return `  ${bets} bets, ${wins} won (${bets ? ((wins / bets) * 100).toFixed(1) : 0}%), `
    + `$${(staked / 100).toFixed(2)} staked, $${(pnl / 100).toFixed(2)} P&L, `
    + `${staked ? ((pnl / staked) * 100).toFixed(1) : 0}% ROI`;
}

main().catch(e => { console.error(e); process.exit(1); });
