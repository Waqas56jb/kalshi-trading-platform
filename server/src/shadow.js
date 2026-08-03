import { config, t } from './config.js';
import { query } from './db.js';
import { looksInPlay } from './model.js';
import { evaluateBet, kalshiFeeRate, probabilityBucket, utrBracket } from './risk.js';
import { calibrationMap, derivedLimits } from './calibration.js';
import { bookConsensus } from './crossmarket.js';
import { marketProbability, QUOTE_REASONS } from './quote.js';
import { autoPlaceApproved } from './orders.js';
import { oddsFeedConfigured, quotesForMatch } from './oddsfeed.js';

/**
 * Shadow trading: the risk engine runs against live markets and real prices,
 * records every decision it reaches, and places nothing.
 *
 * The backtest is why. Buying on the model's raw signal lost money at every
 * edge threshold we tested — worse the bigger the claimed edge — so the engine
 * needs to prove itself on live markets before it is allowed near the account.
 * Shadow mode also generates the calibration history the Kelly tiers require,
 * which is otherwise a chicken-and-egg problem.
 *
 * Both sides of every match are evaluated, each against its own order book.
 * The client was explicit that one side's price must never be taken as 1 minus
 * the other's, and they are right: the two contracts carry separate spreads and
 * separate depth, and on ITF markets the difference is not small.
 */

/** Reads settings into the shape the risk engine expects. Cents where money. */
export async function loadRiskConfig() {
  const s = (await query(`select * from ${t('settings')} where id = 1`)).rows[0] ?? {};
  const n = (v, d) => (v == null ? d : Number(v));
  return {
    shadowMode: s.shadow_mode !== false,
    shadowAutoPlace: s.shadow_auto_place !== false,
    simulatedBankrollCents: Math.round(n(s.simulated_bankroll_usd, 10000) * 100),

    minimumFreeCashFraction: n(s.minimum_free_cash_fraction, 0.60),
    fixedOperatingReserveCents: Math.round(n(s.fixed_operating_reserve_usd, 0) * 100),
    minimumBetCents: Math.round(n(s.minimum_bet_usd, 1) * 100),

    /* Blend: modelWeight of UTR fair + (1-modelWeight) of Kalshi. Was 60/40;
       75/25 is more risk-tolerant for early-round volume without ignoring the book. */
    modelWeight: n(s.model_weight, 0.75),
    uncertaintyHaircut: n(s.uncertainty_haircut, 0.005),
    sub10UncertaintyHaircut: n(s.sub10_uncertainty_haircut, 0.015),
    transitionBandLow: n(s.transition_band_low, 0.07),
    transitionBandHigh: n(s.transition_band_high, 0.13),

    kellyBase: n(s.kelly_base, 0.10),
    kellyWellValidated: n(s.kelly_well_validated, 0.15),
    kellyWeakData: n(s.kelly_weak_data, 0.05),
    kellyExtremeUnderdog: n(s.kelly_extreme_underdog, 0.025),
    calibrationMinSample: n(s.calibration_min_sample, 200),
    calibrationStrongSample: n(s.calibration_strong_sample, 500),
    calibrationMaxError: n(s.calibration_max_error, 0.04),
    calibrationStrongError: n(s.calibration_strong_error, 0.02),

    capOrdinary: n(s.cap_ordinary, 0.005),
    cap10to20: n(s.cap_10_to_20, 0.0035),
    capSub10: n(s.cap_sub_10, 0.002),
    capAbsoluteMax: n(s.cap_absolute_max, 0.015),

    edgeScalingEnabled: s.edge_scaling_enabled !== false,
    edgeScalingReference: n(s.edge_scaling_reference, 0.15),
    edgeScalingMaxMult: n(s.edge_scaling_max_mult, 3),

    capMatchExposure: n(s.cap_match_exposure, 0.0075),
    capPlayerExposure: n(s.cap_player_exposure, 0.01),
    capPlayerDailyStake: n(s.cap_player_daily_stake, 0.03),
    capBucketExposure: n(s.cap_bucket_exposure, 0.025),
    capSignalExposure: n(s.cap_signal_exposure, 0.03),
    capUnsettledExposure: n(s.cap_unsettled_exposure, 0.08),

    minNetEdge: n(s.min_net_edge, 0.03),
    sub10MinNetEdge: n(s.sub10_min_net_edge, 0.04),
    minRoi: n(s.min_roi, 0.08),
    sub10MinRoi: n(s.sub10_min_roi, 0.20),
    absoluteMinProbability: n(s.absolute_min_probability, 0.05),
    /* Placeholder. loadRiskConfig's caller overlays the derived floor, which is
       measured from settled results rather than typed in. This value survives
       only as a manual override. */
    minPriceCents: n(s.min_price_cents, 25),

    crossMarketEnabled: s.cross_market_enabled === true,
    /* Was 3pp / 2 books — too strict for ITF early rounds. */
    crossMarketMinEdge: n(s.cross_market_min_edge, 0.015),
    crossMarketMinBooks: n(s.cross_market_min_books, 1),
    crossMarketMaxSpread: n(s.cross_market_max_spread, 0.12),
    /* ITF often has no line until near first serve. Allow a reduced stake so
       early-round volume is not zero; full size only when books confirm. */
    crossMarketAllowMissing: s.cross_market_allow_missing !== false,
    crossMarketMissingStakeMult: n(s.cross_market_missing_stake_mult, 0.65),

    maxBookParticipation: n(s.max_book_participation, 0.12),
    maxSignalAgeSeconds: n(s.max_signal_age_seconds, 120),
    maxSnapshotAgeSeconds: n(s.max_snapshot_age_seconds, 180),
    maxPriceMove: n(s.max_price_move, 0.03),
    expectedSlippage: n(s.expected_slippage, 0.003),

    throttle1At: n(s.throttle_1_at, 0.01),
    throttle2At: n(s.throttle_2_at, 0.02),
    throttle3At: n(s.throttle_3_at, 0.04),
    dailyStopAt: n(s.daily_stop_at, 0.06),
    weeklyDrawdownStop: n(s.weekly_drawdown_stop, 0.05),
    throttle1Mult: n(s.throttle_1_mult, 0.75),
    throttle2Mult: n(s.throttle_2_mult, 0.50),
    throttle3Mult: n(s.throttle_3_mult, 0.25),

    rejectWhenUnhealthy: true,
    recalibrationEnabled: s.recalibration_enabled !== false,
    recalibrationMinSample: n(s.recalibration_min_sample, 40),
  };
}

/**
 * Fetches executable depth for specific tickers, one call per contract.
 *
 * Only candidates are fetched, never the whole board: a full sweep would be one
 * request per market every cycle, which is both slow and needless when the
 * engine will reject most of them on price or edge before depth ever matters.
 */
export async function refreshOrderBooks(kalshi, tickers, { depth = 10, concurrency = 4 } = {}) {
  const list = [...new Set(tickers)].filter(Boolean);
  if (!list.length) return { fetched: 0, failed: 0 };

  let fetched = 0;
  let failed = 0;
  const rows = [];

  for (let i = 0; i < list.length; i += concurrency) {
    const slice = list.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(async ticker => {
      try {
        const res = await kalshi.getOrderbook(ticker, depth);
        return { ticker, book: res?.orderbook_fp ?? res?.orderbook ?? res };
      } catch {
        return { ticker, book: null };
      }
    }));

    for (const { ticker, book } of results) {
      if (!book) { failed += 1; continue; }

      /* Kalshi's book is `{orderbook_fp: {yes_dollars, no_dollars}}`, each a list
         of [price, size] pairs as decimal STRINGS, and each side lists resting
         BIDS rather than offers. The name carries the `_fp` suffix like every
         other numeric field on this API — reading `orderbook` or `yes` returns
         undefined and silently yields an empty book, which has cost this project
         three separate bugs already.
         A yes ask is the mirror of a no bid: someone bidding 30c for no is
         offering yes at 70c. That mirroring is a fact about how binary contracts
         settle, not an inference from the other side's price — the two queues
         are read independently and neither is derived from the other's ask. */
      const level = ([price, size]) => ({ price: Number(price), contracts: Number(size) });
      const asks = (book.no_dollars ?? [])
        .map(level)
        .map(l => ({ price: +(1 - l.price).toFixed(4), contracts: l.contracts }))
        .filter(l => l.contracts > 0 && l.price > 0 && l.price < 1)
        .sort((a, b) => a.price - b.price);
      const bids = (book.yes_dollars ?? [])
        .map(level)
        .filter(l => l.contracts > 0 && l.price > 0 && l.price < 1)
        .sort((a, b) => b.price - a.price);

      rows.push({
        ticker,
        asks: JSON.stringify(asks),
        bids: JSON.stringify(bids),
        bestAsk: asks.length ? Math.round(asks[0].price * 100) : null,
        depthDollars: +asks.reduce((s, l) => s + l.price * l.contracts, 0).toFixed(2),
        levels: asks.length,
      });
      fetched += 1;
    }
  }

  if (rows.length) {
    await query(
      `insert into ${t('order_books')} (ticker, asks, bids, best_ask, depth_dollars, levels, captured_at)
       select *, now() from unnest($1::text[], $2::jsonb[], $3::jsonb[], $4::int[], $5::numeric[], $6::int[])
       on conflict (ticker) do update set
         asks = excluded.asks, bids = excluded.bids, best_ask = excluded.best_ask,
         depth_dollars = excluded.depth_dollars, levels = excluded.levels, captured_at = now()`,
      [rows.map(r => r.ticker), rows.map(r => r.asks), rows.map(r => r.bids),
        rows.map(r => r.bestAsk), rows.map(r => r.depthDollars), rows.map(r => r.levels)],
    );
  }

  return { fetched, failed };
}

/** Simulated portfolio: fixed bankroll, cash reduced by open shadow exposure. */
async function shadowPortfolio(cfg) {
  await ensureShadowArchiveColumn();
  const r = await query(
    `select
       coalesce(sum(stake_usd) filter (where approved and result is null), 0)::numeric as open_stake,
       coalesce(sum(pnl_usd)   filter (where settled_at::date = (now() at time zone 'America/Los_Angeles')::date), 0)::numeric as today_pnl,
       coalesce(sum(pnl_usd), 0)::numeric as lifetime_pnl
     from ${t('shadow_trades')}
     where archived_at is null`);
  const row = r.rows[0];

  const openCents = Math.round(Number(row.open_stake) * 100);
  const todayCents = Math.round(Number(row.today_pnl) * 100);
  const lifetimeCents = Math.round(Number(row.lifetime_pnl) * 100);
  const bankrollCents = cfg.simulatedBankrollCents + lifetimeCents;

  const exposure = { match: {}, player: {}, playerDaily: {}, bucket: {}, signal: {} };
  const open = await query(
    `select event_ticker, player_name, utr_bracket, stake_usd, ticker
     from ${t('shadow_trades')}
     where archived_at is null and approved and result is null`);
  const heldTickers = new Set(open.rows.map(r => r.ticker));
  for (const p of open.rows) {
    const cents = Math.round(Number(p.stake_usd) * 100);
    exposure.match[p.event_ticker] = (exposure.match[p.event_ticker] ?? 0) + cents;
    exposure.player[p.player_name] = (exposure.player[p.player_name] ?? 0) + cents;
  }
  const daily = await query(
    `select player_name, sum(stake_usd)::numeric total from ${t('shadow_trades')}
     where archived_at is null and approved
       and created_at::date = (now() at time zone 'America/Los_Angeles')::date
     group by player_name`);
  for (const p of daily.rows) {
    exposure.playerDaily[p.player_name] = Math.round(Number(p.total) * 100);
  }

  return {
    bankrollCents: Math.max(1, bankrollCents),
    cashCents: Math.max(0, bankrollCents - openCents),
    unsettledCents: openCents,
    dailyRealisedCents: todayCents,
    weeklyPeakCents: Math.max(bankrollCents, cfg.simulatedBankrollCents),
    exposure,
    /* Tickers already holding an open position. They must not be re-sized: their
       own stake sits inside `exposure`, so re-evaluating one has it compete with
       itself for headroom, and the upsert then writes the smaller answer over the
       original row. Left alone the recorded stake oscillated between $20 and
       $9.85 every sixty seconds, and whichever figure the row happened to hold at
       settlement was the one the P&L got booked on. */
    heldTickers,
  };
}

/**
 * Evaluates every live market, both sides, and records the outcome.
 *
 * Rejections are stored, not discarded. The client asked to see what was
 * filtered and why — silently dropping an opportunity is how a gate like the
 * old 0.5 UTR minimum went a fortnight without anyone noticing it was costing
 * 68 signals a day.
 */
export async function runShadowCycle(kalshi, { verbose = false } = {}) {
  const cfg = await loadRiskConfig();

  /* The floor the data supports, not the one someone typed. Cap at 25¢ — a
     derived 50¢ floor was rejecting 36¢ asks (Shadow hold list) and zeroing
     early-round volume Max/Robbie expect. */
  const limits = await derivedLimits().catch(() => ({}));
  if (limits.minimum_price?.value != null) {
    cfg.minPriceCents = Math.min(25, Math.max(15, Math.round(limits.minimum_price.value)));
  }

  /* Entries are pre-match only — the client's rule, and the model's too: the
     UTR signal is a pre-match estimate that says nothing about a match in
     progress. Three gates, because no single one covers every case:
       1. play_state — the book-inference flag the sync stamps (volume growth,
          extreme quotes). Excludes anything already detected as live.
       2. match_date — the match day must not have passed (Pacific, the tour's
          operational day used everywhere else in this codebase).
       3. scheduled_at — when a real schedule source gave us the exact start
          time, never enter at or after it. Only 'exact' is trusted; Kalshi's
          placeholder slots are date guesses, not start times. */
  const { rows: candidates } = await query(
    `select m.ticker, m.event_ticker, m.player_name, m.competitor_id,
            m.yes_ask_cents, m.yes_bid_cents, m.yes_ask_size, m.match_date, m.status,
            m.play_state,
            opp.yes_ask_cents as opponent_ask, opp.yes_bid_cents as opponent_bid,
            s.fair_cents, s.market_cents, s.utr_gap, s.side_type, s.opponent_name,
            s.model, s.computed_at,
            p.utr_status, p.utr_match_score, p.utr_matched_name,
            opp.ticker as opponent_ticker
     from ${t('markets')} m
     join ${t('signals')} s on s.ticker = m.ticker
     left join ${t('events')} e on e.event_ticker = m.event_ticker
     left join ${t('players')} p on p.competitor_id = m.competitor_id
     left join ${t('markets')} opp
       on opp.event_ticker = m.event_ticker and opp.ticker <> m.ticker
     where m.status in ('active','open','initialized')
       and s.fair_cents is not null
       and m.yes_ask_cents is not null
       and coalesce(m.play_state, 'unknown') <> 'in_play'
       and coalesce(m.match_date, (now() at time zone 'America/Los_Angeles')::date)
             >= (now() at time zone 'America/Los_Angeles')::date
       and (e.schedule_confidence is distinct from 'exact'
            or e.scheduled_at is null
            or e.scheduled_at > now())`);

  if (!candidates.length) return { evaluated: 0, approved: 0, rejected: 0 };

  /* Depth only for markets that could plausibly clear the price floor. Fetching
     the whole board would be one request each per cycle for markets the engine
     rejects on price before depth is ever consulted. */
  const worthFetching = candidates
    .filter(c => c.yes_ask_cents >= cfg.minPriceCents
      && (c.fair_cents - c.market_cents) >= Math.round(cfg.minNetEdge * 100))
    .map(c => c.ticker);
  const books = await refreshOrderBooks(kalshi, worthFetching);

  const bookRows = await query(
    `select ticker, asks, best_ask, levels, captured_at from ${t('order_books')}
     where captured_at > now() - interval '10 minutes'`);
  const bookByTicker = new Map(bookRows.rows.map(r => [r.ticker, r]));

  const calibration = await calibrationMap();
  const portfolio = await shadowPortfolio(cfg);
  const now = Date.now();

  /* Sportsbook confirmation is only fetched when the gate that consumes it is
     on, and never for more than the provider's rate budget allows in one
     cycle. Both caches inside the feed make the budget a worst case, not a
     steady state. */
  const useOddsFeed = cfg.crossMarketEnabled && oddsFeedConfigured();
  let oddsBudget = 80;

  const decisions = [];
  for (const c of candidates) {
    // an open position is a fact, not a decision to remake every minute
    if (portfolio.heldTickers?.has(c.ticker)) continue;

    /* Backstop for the pre-match gate: play_state can be up to a sync cycle
       stale, but a quote pinned at the extremes means the match is being
       decided right now. Recorded as a rejection, not silently skipped, so the
       decision log shows why the engine stood aside. */
    if (looksInPlay({ bid: c.yes_bid_cents, ask: c.yes_ask_cents })) {
      decisions.push({
        candidate: c,
        bestAskCents: c.yes_ask_cents,
        levels: 0,
        decision: {
          approved: false,
          stakeCents: 0,
          contracts: 0,
          limitingConstraint: 'match in play',
          rejectionReason: 'Quote implies the match is in play — entries are pre-match only.',
        },
      });
      continue;
    }

    const book = bookByTicker.get(c.ticker);

    /* Markets pre-filtered out of the depth fetch still get evaluated, using the
       top-of-book quote the sync already stored as a one-level ladder. Without
       this they came back as "no executable ask liquidity", which was simply
       untrue — we had a quote, we just had not asked for the ladder behind it —
       and it buried the real reasons under a made-up one. */
    const asks = book?.asks?.length
      ? book.asks
      : (c.yes_ask_cents != null
        /* Prefer resting size; if Kalshi prints an ask with size 0 in the sync
           snapshot (common on ITF), still evaluate one contract so a live 35¢
           print is not dropped as "no liquidity" before the next book refresh. */
        ? [{
          price: c.yes_ask_cents / 100,
          contracts: Math.max(1, Number(c.yes_ask_size) || 0),
        }]
        : []);
    const bestAskCents = book?.best_ask ?? c.yes_ask_cents;

    const modelProbability = c.fair_cents / 100;

    /* The shrinkage anchor comes from both sides normalised to sum to one, not
       from a single ask. A lone ask carries the whole spread and reads high, and
       on an empty book it is not a price at all — which is how a player the model
       had at 14% came to be shown as "94% on Kalshi". When the pair is not a real
       book there is no anchor, and the opportunity is dropped rather than shrunk
       toward a number nobody was offering. */
    /* Buy YES at the ask only — bid / other side do not decide tradability. */
    const market = marketProbability({
      bid: c.yes_bid_cents,
      ask: c.yes_ask_cents,
      opponentBid: c.opponent_bid,
      opponentAsk: c.opponent_ask,
    });
    if (market.probability == null) {
      decisions.push({
        candidate: c,
        bestAskCents: c.yes_ask_cents,
        levels: 0,
        decision: {
          approved: false,
          stakeCents: 0,
          contracts: 0,
          limitingConstraint: 'no real market',
          rejectionReason: QUOTE_REASONS[market.reason] ?? market.reason,
        },
      });
      continue;
    }
    const marketReference = market.probability;
    const priceAtModelTime = bestAskCents / 100;
    const bucket = probabilityBucket(modelProbability);

    /* Rated only — Projected UTRs never trade. Signals already strip them from
       fair value, but this backstops any stale row still in the candidate set. */
    if (c.utr_status !== 'Rated') {
      decisions.push({
        candidate: c,
        bestAskCents: c.yes_ask_cents,
        levels: 0,
        decision: {
          approved: false,
          stakeCents: 0,
          contracts: 0,
          limitingConstraint: 'utr not rated',
          rejectionReason: 'UTR is not fully Rated (Projected/Unrated) — no trade until verified.',
        },
      });
      continue;
    }

    const dataQuality = 1.0;
    const largeGap = Math.abs(Number(c.utr_gap) || 0) >= 2;

    /* Book consensus for the cross-market gate. Null when the books have not
       priced this match, which for ITF is common until close to first serve —
       the gate then fails closed by design. `supportingBooks` counts books
       whose de-vigged probability clears the ask by at least a point, the
       same individual-book test verifyAgainstBooks applies. */
    let consensus = null;
    let oddsMissReason = null;
    if (useOddsFeed && oddsBudget > 0) {
      oddsBudget--;
      const q = await quotesForMatch(c.player_name, c.opponent_name).catch(() => null);
      if (q?.quotes?.length) consensus = bookConsensus(q.quotes);
      else oddsMissReason = q == null
        ? 'no_fixture_or_odds'
        : 'fixture_found_no_quotes';
    } else if (useOddsFeed) {
      oddsMissReason = 'odds_budget_exhausted';
    } else if (!oddsFeedConfigured()) {
      oddsMissReason = 'odds_feed_not_configured';
    }

    /* Δ ≥ 2: only hard-hold weak name matches without books. Strong UTR name
       scores (≥0.85) or book confirmation can proceed (tagged for review). */
    const matchScore = Number(c.utr_match_score);
    const strongName = Number.isFinite(matchScore) && matchScore >= 0.85;
    if (largeGap && consensus?.consensus == null && !strongName) {
      decisions.push({
        candidate: c,
        bestAskCents: c.yes_ask_cents,
        levels: 0,
        decision: {
          approved: false,
          stakeCents: 0,
          contracts: 0,
          limitingConstraint: 'verify name (Δ≥2)',
          rejectionReason: `UTR gap ${c.utr_gap} ≥ 2, weak/unknown name match`
            + (Number.isFinite(matchScore) ? ` (${matchScore})` : '')
            + ' and no book consensus — confirm the player before placing.'
            + (oddsMissReason ? ` (${oddsMissReason})` : ''),
        },
      });
      continue;
    }

    const opportunity = {
      matchId: c.event_ticker,
      playerId: c.player_name,
      modelSignalId: c.model ?? 'utr_gap_v1',
      modelProbability,
      marketReferenceProbability: marketReference,
      priceAtModelTime,
      modelTimestamp: c.computed_at ? new Date(c.computed_at).getTime() : now,
      marketSnapshotTimestamp: book?.captured_at ? new Date(book.captured_at).getTime() : now,
      orderBookAsks: asks,
      feeRate: kalshiFeeRate(priceAtModelTime),
      slippage: cfg.expectedSlippage,
      dataQualityScore: dataQuality,
      uncertaintyEstimate: 0,
      bookConsensus: consensus?.consensus ?? null,
      supportingBooks: consensus
        ? consensus.perBook.filter(p => p.probability - priceAtModelTime >= 0.01).length
        : 0,
      consensusRange: consensus?.range ?? null,
      oddsMissReason,
      nameCheckFlag: largeGap,
    };

    const decision = evaluateBet({
      opportunity,
      portfolio,
      calibration: calibration.get(bucket),
      health: { healthy: true },
      cfg,
      now,
    });
    if (largeGap && decision.approved) {
      decision.nameCheckFlag = true;
      decision.limitingConstraint = decision.limitingConstraint
        ? `${decision.limitingConstraint}; name check (Δ≥2)`
        : 'name check (Δ≥2)';
    }

    /* An approved bet consumes capacity for the rest of this cycle, or the
       engine would approve the same $75 of headroom to twenty markets at once. */
    if (decision.approved) {
      portfolio.cashCents -= decision.stakeCents;
      portfolio.unsettledCents += decision.stakeCents;
      portfolio.exposure.match[c.event_ticker] =
        (portfolio.exposure.match[c.event_ticker] ?? 0) + decision.stakeCents;
      portfolio.exposure.player[c.player_name] =
        (portfolio.exposure.player[c.player_name] ?? 0) + decision.stakeCents;
      portfolio.exposure.playerDaily[c.player_name] =
        (portfolio.exposure.playerDaily[c.player_name] ?? 0) + decision.stakeCents;
      /* Key on the bucket the engine actually caps against — the shrunk
         probability's — not the raw model's. They differ by design, so crediting
         the raw one left the bucket cap permanently unconsumed. */
      const capBucket = decision.bucket ?? bucket;
      portfolio.exposure.bucket[capBucket] =
        (portfolio.exposure.bucket[capBucket] ?? 0) + decision.stakeCents;
      // the model-signal cap was initialised and never written, so it never bound
      const signalId = c.model ?? 'utr_gap_v1';
      portfolio.exposure.signal[signalId] =
        (portfolio.exposure.signal[signalId] ?? 0) + decision.stakeCents;
    }

    decisions.push({ candidate: c, decision, bestAskCents, levels: book?.levels ?? 0 });
  }

  await recordDecisions(decisions, cfg);

  /* Auto-placement — the algorithm approves, nobody clicks. While shadow mode
     is on this books a labelled paper fill at the real ask; only with shadow
     mode off, paper trading off and working Kalshi credentials does an order
     go to the exchange. */
  let placements = null;
  if (cfg.shadowAutoPlace) {
    placements = await autoPlaceApproved(
      kalshi,
      decisions.filter(d => d.decision.approved).map(d => ({
        ticker: d.candidate.ticker,
        event_ticker: d.candidate.event_ticker,
        player_name: d.candidate.player_name,
        opponent_name: d.candidate.opponent_name,
        fair_cents: d.candidate.fair_cents,
        entry_cents: d.bestAskCents,
        contracts: d.decision.contracts,
        stake_usd: +(d.decision.stakeCents / 100).toFixed(2),
      })),
      cfg,
    ).catch(e => ({ placed: 0, error: String(e.message).slice(0, 160) }));
  }

  const approved = decisions.filter(d => d.decision.approved).length;
  if (verbose) {
    console.log(`  shadow: ${decisions.length} evaluated, ${approved} approved, `
      + `${placements ? `${placements.placed} placed, ` : ''}${books.fetched} books fetched`);
  }

  return {
    evaluated: decisions.length,
    approved,
    rejected: decisions.length - approved,
    placed: placements?.placed ?? 0,
    autoPlace: cfg.shadowAutoPlace,
    booksFetched: books.fetched,
    booksFailed: books.failed,
    bankroll: +(portfolio.bankrollCents / 100).toFixed(2),
  };
}

async function recordDecisions(decisions, cfg) {
  if (!decisions.length) return;
  const col = f => decisions.map(f);
  const pct = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

  await query(
    `insert into ${t('shadow_trades')} (
       ticker, event_ticker, player_name, opponent_name, side,
       model_probability, market_reference, conservative_prob, utr_gap, utr_bracket,
       best_ask_cents, expected_vwap_cents, fee_rate, slippage, effective_cost,
       max_price_cents, book_depth_levels,
       approved, net_edge, expected_roi, full_kelly, kelly_multiplier,
       base_cap_fraction, edge_scaling_mult, effective_cap, throttle_multiplier,
       stake_usd, contracts, limiting_constraint, rejection_reason, match_date)
     select * from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
       $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::text[],
       $11::int[], $12::numeric[], $13::numeric[], $14::numeric[], $15::numeric[],
       $16::numeric[], $17::int[],
       $18::boolean[], $19::numeric[], $20::numeric[], $21::numeric[], $22::numeric[],
       $23::numeric[], $24::numeric[], $25::numeric[], $26::numeric[],
       $27::numeric[], $28::numeric[], $29::text[], $30::text[], $31::date[])
     on conflict (ticker, match_date) do update set
       model_probability = excluded.model_probability,
       market_reference = excluded.market_reference,
       conservative_prob = excluded.conservative_prob,
       utr_gap = excluded.utr_gap, utr_bracket = excluded.utr_bracket,
       side = excluded.side, opponent_name = excluded.opponent_name,
       fee_rate = excluded.fee_rate, slippage = excluded.slippage,
       base_cap_fraction = excluded.base_cap_fraction,
       best_ask_cents = excluded.best_ask_cents,
       expected_vwap_cents = excluded.expected_vwap_cents,
       effective_cost = excluded.effective_cost,
       max_price_cents = excluded.max_price_cents,
       book_depth_levels = excluded.book_depth_levels,
       approved = excluded.approved, net_edge = excluded.net_edge,
       expected_roi = excluded.expected_roi, full_kelly = excluded.full_kelly,
       kelly_multiplier = excluded.kelly_multiplier,
       edge_scaling_mult = excluded.edge_scaling_mult,
       effective_cap = excluded.effective_cap,
       throttle_multiplier = excluded.throttle_multiplier,
       stake_usd = excluded.stake_usd, contracts = excluded.contracts,
       limiting_constraint = excluded.limiting_constraint,
       rejection_reason = excluded.rejection_reason,
       created_at = now()
     -- a filled position is a historical fact; re-evaluation must not rewrite it
     where ${t('shadow_trades')}.result is null`,
    [
      col(d => d.candidate.ticker), col(d => d.candidate.event_ticker),
      col(d => d.candidate.player_name), col(d => d.candidate.opponent_name),
      col(d => d.candidate.side_type),
      col(d => pct(d.decision.rawModelEdge != null ? d.candidate.fair_cents / 100 : null)),
      col(d => pct(d.candidate.market_cents / 100)),
      col(d => pct(d.decision.conservativeP)),
      col(d => (d.candidate.utr_gap == null ? null : Number(d.candidate.utr_gap))),
      col(d => utrBracket(d.candidate.utr_gap)),
      col(d => d.bestAskCents),
      col(d => (d.decision.vwap == null ? null : +(d.decision.vwap * 100).toFixed(3))),
      col(d => pct(d.decision.feeRate)), col(d => pct(d.decision.slippage)),
      col(d => pct(d.decision.effectiveCost)),
      col(d => (d.decision.maxPrice == null ? null : +(d.decision.maxPrice * 100).toFixed(3))),
      col(d => d.levels),
      col(d => d.decision.approved),
      col(d => pct(d.decision.netEdge)), col(d => pct(d.decision.roi)),
      col(d => pct(d.decision.kelly)), col(d => pct(d.decision.kellyMultiplier)),
      col(d => (d.decision.baseCap == null ? null : +d.decision.baseCap.toFixed(6))),
      col(d => (d.decision.edgeMult == null ? null : +d.decision.edgeMult.toFixed(3))),
      col(d => (d.decision.effectiveCap == null ? null : +d.decision.effectiveCap.toFixed(6))),
      col(d => (d.decision.throttleMultiplier == null ? null : +d.decision.throttleMultiplier.toFixed(3))),
      col(d => +((d.decision.stakeCents ?? 0) / 100).toFixed(2)),
      col(d => (d.decision.contracts == null ? null : +d.decision.contracts.toFixed(4))),
      col(d => d.decision.limitingConstraint ?? null),
      col(d => d.decision.rejectionReason ?? null),
      col(d => d.candidate.match_date),
    ],
  );
}

/**
 * Settles shadow positions once the real market resolves.
 *
 * A YES contract pays $1 if the player won and nothing if not, so P&L is the
 * payout less what the fill and fees actually cost.
 */
/* The rejections the cross-market gate is solely responsible for. Settled
   outcomes are recorded for these too, or "would the formula alone have won"
   could never be answered. */
const CROSS_MARKET_CONSTRAINTS = [
  'cross-market data', 'cross-market edge', 'supporting books', 'consensus dispersion',
];

export async function settleShadowTrades() {
  await ensureShadowArchiveColumn();
  const r = await query(
    `update ${t('shadow_trades')} st set
       result = case when m.result = 'yes' then 'won' else 'lost' end,
       -- Kalshi rounds the fee up once for the whole order, so the ledger must
       -- charge ceil(rate x contracts) rather than rate x contracts.
       -- Real P&L only for real (approved) positions; a gate-rejected row gets
       -- its outcome recorded but no money booked against it.
       pnl_usd = case when st.approved then round(
         case when m.result = 'yes' then st.contracts * 1.0 else 0 end
         - st.stake_usd
         - ceil(coalesce(st.contracts * st.fee_rate, 0) * 100) / 100.0, 2) end,
       settled_at = coalesce(m.settled_at, now())
     from ${t('markets')} m
     where m.ticker = st.ticker
       and st.archived_at is null
       and (st.approved or st.limiting_constraint = any($1))
       and st.result is null
       and m.result in ('yes','no')`,
    [CROSS_MARKET_CONSTRAINTS]);
  return { settled: r.rowCount ?? 0 };
}

/* When the odds feed went live and book data started being recorded. Rows
   before this are from an era with no book information and would poison the
   comparison. */
const ODDS_FEED_LIVE_SINCE = '2026-08-02T13:00:00Z';

/**
 * Desk P&L / Placed / Settled restart. Everything approved before this is
 * archived out of the Shadow headline numbers (the old 6 and earlier paper).
 * Held-back diagnostics stay visible.
 */
/* Desk scoreboard starts Aug 4 UTC — wipes Aug 3 and earlier Lost/Won from the UI. */
export const NEW_FORMULA_SINCE = '2026-08-04T00:00:00Z';

/** Ensures archive column exists (prod may not have run the SQL migration yet). */
async function ensureShadowArchiveColumn() {
  await query(
    `alter table ${t('shadow_trades')}
       add column if not exists archived_at timestamptz`).catch(() => null);
}

/**
 * Archives pre-new-formula shadow placements and ALL ledger fills from before
 * the era (paper or live) so Trade history Lost/Won and desk P&L restart clean.
 * Idempotent.
 */
export async function archivePreNewFormulaDesk() {
  await ensureShadowArchiveColumn();
  const shadow = await query(
    `update ${t('shadow_trades')} set archived_at = now()
     where archived_at is null
       and approved
       and created_at < $1::timestamptz
     returning ticker`,
    [NEW_FORMULA_SINCE]);
  /* Any mode — Max still saw Lost because live/imported rows were skipped. */
  const trades = await query(
    `update ${t('trades')} set archived_at = now()
     where archived_at is null
       and placed_at < $1::timestamptz
     returning id`,
    [NEW_FORMULA_SINCE]);
  return {
    shadowArchived: shadow.rowCount ?? 0,
    tradesArchived: trades.rowCount ?? 0,
    since: NEW_FORMULA_SINCE,
  };
}

/**
 * The comparison the client asked for on 2 Aug 2026: bets confirmed against
 * the odds API versus bets the formula would take regardless of it.
 *
 * Both cohorts are scored at a flat stake with Kalshi's fee, like the formula
 * lab, so the difference is attributable to the gate and nothing else. It can
 * only build forward from the day odds recording began — bookmakers do not
 * hand out their past prices retroactively.
 */
export async function gateComparison({ stakeUsd = 100 } = {}) {
  const { rows } = await query(
    `select approved, limiting_constraint, book_consensus, best_ask_cents, result
     from ${t('shadow_trades')}
     where result is not null
       and best_ask_cents between 1 and 99
       and (approved or limiting_constraint = any($1))
       and created_at >= $2`,
    [CROSS_MARKET_CONSTRAINTS, ODDS_FEED_LIVE_SINCE]);

  const mk = () => ({ bets: 0, wins: 0, stakedUsd: 0, pnlUsd: 0 });
  const cohorts = { confirmed: mk(), formulaAlone: mk() };

  for (const r of rows) {
    const ask = Number(r.best_ask_cents);
    const contracts = Math.max(1, Math.floor((stakeUsd * 100) / ask));
    const feeCents = Math.ceil(0.07 * (ask / 100) * (1 - ask / 100) * 100);
    const costCents = contracts * (ask + feeCents);
    const pnlCents = (r.result === 'won' ? contracts * 100 : 0) - costCents;

    const into = agg => {
      agg.bets += 1;
      agg.wins += r.result === 'won' ? 1 : 0;
      agg.stakedUsd += costCents / 100;
      agg.pnlUsd += pnlCents / 100;
    };

    // the formula wanted every one of these; the gate only let some through
    into(cohorts.formulaAlone);
    if (r.approved && r.book_consensus != null) into(cohorts.confirmed);
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
    since: ODDS_FEED_LIVE_SINCE,
    stakeUsd,
    confirmed: finish(cohorts.confirmed),
    formulaAlone: finish(cohorts.formulaAlone),
  };
}

/** Headline shadow performance, and the per-bracket breakdown the client asked for. */
export async function shadowSummary() {
  await ensureShadowArchiveColumn();
  const [overall, brackets, reasons, priceBands] = await Promise.all([
    query(`select
        count(*) filter (where approved)::int placed,
        count(*) filter (where not approved)::int held_back,
        count(*) filter (where approved and result is not null)::int settled,
        -- gate-rejected rows also carry results now; only real positions count here
        count(*) filter (where approved and result = 'won')::int won,
        coalesce(sum(stake_usd) filter (where approved), 0)::numeric staked,
        coalesce(sum(pnl_usd) filter (where approved), 0)::numeric pnl,
        coalesce(sum(stake_usd) filter (where approved and result is null), 0)::numeric at_risk
      from ${t('shadow_trades')}
      where archived_at is null`),
    query(`select utr_bracket,
        count(*) filter (where approved)::int placed,
        count(*) filter (where approved and result is not null)::int settled,
        count(*) filter (where approved and result = 'won')::int won,
        coalesce(sum(stake_usd) filter (where approved), 0)::numeric staked,
        coalesce(sum(pnl_usd) filter (where approved), 0)::numeric pnl
      from ${t('shadow_trades')}
      where archived_at is null and utr_bracket is not null
      group by 1 order by 1`),
    query(`select rejection_reason, limiting_constraint, count(*)::int n
      from ${t('shadow_trades')}
      where archived_at is null and not approved
        and created_at > now() - interval '12 hours'
      group by 1, 2 order by n desc limit 12`),
    /* The tilt audit: where the engine's entries actually sit on the price
       ladder. The standing worry is that the model leans on underdogs, and the
       only honest answer is the entry mix and each band's own P&L. */
    query(`select case
          when best_ask_cents < 35 then 'under 35c (longshot)'
          when best_ask_cents < 50 then '35-50c (underdog)'
          when best_ask_cents < 65 then '50-65c (slight favourite)'
          when best_ask_cents < 80 then '65-80c (favourite)'
          else '80c+ (heavy favourite)' end as band,
        min(best_ask_cents)::int ord,
        count(*)::int placed,
        count(*) filter (where result is not null)::int settled,
        count(*) filter (where result = 'won')::int won,
        coalesce(sum(stake_usd), 0)::numeric staked,
        coalesce(sum(pnl_usd), 0)::numeric pnl
      from ${t('shadow_trades')}
      where archived_at is null and approved and best_ask_cents is not null
      group by 1 order by 2`),
  ]);

  const o = overall.rows[0];
  const staked = Number(o.staked);
  const pnl = Number(o.pnl);

  /* Desk bug monitors — surface on Shadow so a 50¢ floor / spread hold can't
     hide again after Robbie/Max called them out. */
  const limits = await derivedLimits().catch(() => ({}));
  const rawFloor = limits.minimum_price?.value != null
    ? Math.round(Number(limits.minimum_price.value)) : null;
  const liveFloor = rawFloor != null ? Math.min(25, Math.max(15, rawFloor)) : 25;
  const spreadHolds = reasons.rows
    .filter(r => /spread/i.test(r.rejection_reason || '')
      || /spread/i.test(r.limiting_constraint || ''))
    .reduce((n, r) => n + Number(r.n), 0);
  const floorHolds = reasons.rows
    .filter(r => /price floor/i.test(r.limiting_constraint || '')
      || /below the .*floor/i.test(r.rejection_reason || ''))
    .reduce((n, r) => n + Number(r.n), 0);
  const monitors = [];
  if (rawFloor != null && rawFloor > 25) {
    monitors.push({
      id: 'floor_uncapped',
      severity: 'error',
      message: `Derived floor tried ${rawFloor}¢ (live capped at ${liveFloor}¢) — investigate deriveMinimumPrice.`,
    });
  }
  if (spreadHolds > 0) {
    monitors.push({
      id: 'spread_holds',
      severity: 'error',
      message: `${spreadHolds} hold(s) in last 12h still cite spread — buy path should be ask-only.`,
    });
  }
  if (floorHolds > 0 && liveFloor >= 25) {
    monitors.push({
      id: 'floor_holds',
      severity: 'warn',
      message: `${floorHolds} price-floor hold(s) in last 12h at live floor ${liveFloor}¢.`,
    });
  }

  return {
    placed: o.placed,
    heldBack: o.held_back,
    settled: o.settled,
    won: o.won,
    winRate: o.settled ? +(o.won / o.settled).toFixed(3) : null,
    staked: +staked.toFixed(2),
    pnl: +pnl.toFixed(2),
    roi: staked > 0 ? +((pnl / staked) * 100).toFixed(1) : null,
    atRisk: +Number(o.at_risk).toFixed(2),
    brackets: brackets.rows.map(b => ({
      bracket: b.utr_bracket,
      placed: b.placed,
      settled: b.settled,
      won: b.won,
      winRate: b.settled ? +(b.won / b.settled).toFixed(3) : null,
      staked: +Number(b.staked).toFixed(2),
      pnl: +Number(b.pnl).toFixed(2),
      roi: Number(b.staked) > 0 ? +((Number(b.pnl) / Number(b.staked)) * 100).toFixed(1) : null,
    })),
    heldBackReasons: reasons.rows,
    priceBands: priceBands.rows.map(b => ({
      band: b.band,
      placed: b.placed,
      settled: b.settled,
      won: b.won,
      winRate: b.settled ? +(b.won / b.settled).toFixed(3) : null,
      staked: +Number(b.staked).toFixed(2),
      pnl: +Number(b.pnl).toFixed(2),
      roi: Number(b.staked) > 0 ? +((Number(b.pnl) / Number(b.staked)) * 100).toFixed(1) : null,
    })),
    /* Share of stake below 50c — the single number that answers "does it tilt
       towards underdogs". */
    underdogStakeShare: (() => {
      const total = priceBands.rows.reduce((s, b) => s + Number(b.staked), 0);
      if (!total) return null;
      const dogs = priceBands.rows
        .filter(b => b.ord < 50)
        .reduce((s, b) => s + Number(b.staked), 0);
      return +((dogs / total) * 100).toFixed(1);
    })(),
    monitors,
    floor: { raw: rawFloor, live: liveFloor, cappedAt: 25 },
  };
}

export { bookConsensus, config };
