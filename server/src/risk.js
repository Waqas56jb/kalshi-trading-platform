/**
 * The risk engine, ported from the client's Python.
 *
 * It never predicts a winner. It takes a probability and answers one question:
 * given this price, this depth and this bankroll, do we buy, and for how much?
 *
 * Two deliberate departures from the Python original:
 *
 * Money is integer cents, not Decimal. Node has no Decimal, and the usual
 * workaround — a float that gets rounded at the end — is exactly what the
 * client's comments warn against for a ledger that accumulates over thousands
 * of trades. Integers cannot drift at all, and they match the numeric columns
 * the ledger already uses. Probabilities, Kelly fractions and multipliers stay
 * float throughout, as the original does, because they are not money.
 *
 * There is no surface exposure cap. The client removed it, and Kalshi publishes
 * no surface for us to group on, so it could not have been enforced honestly.
 */

/* --------------------------------------------------------------- helpers */

const clamp01 = v => Math.min(1, Math.max(0, v));

/** Kalshi's actual fee: 7% of price × (1 − price) per contract, rounded up. */
export function kalshiFeeRate(priceDollars) {
  const p = clamp01(priceDollars);
  return Math.ceil(0.07 * p * (1 - p) * 100) / 100;
}

export function probabilityBucket(p) {
  if (p < 0.05) return '0-5%';
  if (p < 0.10) return '5-10%';
  if (p < 0.20) return '10-20%';
  if (p < 0.40) return '20-40%';
  if (p < 0.60) return '40-60%';
  if (p < 0.80) return '60-80%';
  if (p < 0.90) return '80-90%';
  return '90-100%';
}

/**
 * The four brackets the client asked to collect data on, plus a tail.
 *
 * The coercion matters: node-postgres hands back `numeric` columns as strings,
 * and `Number.isFinite('0.45')` is false, so reading a gap straight out of a
 * query silently bucketed every row as null — which is precisely the breakdown
 * the client asked for.
 */
export function utrBracket(gap) {
  if (gap == null || gap === '') return null;
  const n = Number(gap);
  if (!Number.isFinite(n)) return null;
  const g = Math.abs(n);
  if (g < 0.10) return '0-0.1';
  if (g < 0.25) return '0.1-0.25';
  if (g < 0.50) return '0.25-0.5';
  if (g < 1.00) return '0.5-1.0';
  return '1.0+';
}

/* --------------------------------------------------- probability handling */

/**
 * Fraction of the sub-10% regime still in force, blended across the transition
 * band so a small wobble in the estimate cannot flip the regime outright at
 * exactly 10%.
 */
function sub10Blend(pModel, cfg) {
  const low = cfg.transitionBandLow;
  const high = cfg.transitionBandHigh;
  if (high <= low) return pModel < 0.10 ? 1 : 0;
  if (pModel <= low) return 1;
  if (pModel >= high) return 0;
  return (high - pModel) / (high - low);
}

/**
 * Shrinks the model toward the market, then takes an uncertainty haircut.
 *
 * This is the single most important correction in the engine. Our model sits an
 * average of 14.9 points from an even split while the market sits 33.5 points
 * away, and that flatness is what made every historical signal an underdog: a
 * hesitant model facing a decisive market can only ever find "value" on the
 * cheap side. Shrinking toward the market removes most of that illusion.
 *
 * The weight is flat for every trade, per the client's explicit decision — no
 * calibration-tiered trust and no separate underdog weight.
 */
export function conservativeProbability(opp, cfg) {
  const pModel = clamp01(opp.modelProbability);
  const pMarket = clamp01(opp.marketReferenceProbability);

  const blend = sub10Blend(pModel, cfg);
  const haircut = blend * cfg.sub10UncertaintyHaircut
    + (1 - blend) * cfg.uncertaintyHaircut;

  const shrunk = cfg.modelWeight * pModel + (1 - cfg.modelWeight) * pMarket;
  return clamp01(shrunk - haircut - (opp.uncertaintyEstimate ?? 0));
}

/**
 * Fractional-Kelly multiplier.
 *
 * `calibration.verified` gates both upper tiers. An assumed or placeholder
 * calibration can never buy the same trust as a measured track record, however
 * favourable its numbers look.
 */
export function selectKellyMultiplier(probability, calibration, dataQuality, cfg) {
  const cal = calibration ?? { verified: false, sampleSize: 0, calibrationError: 1 };
  const dq = clamp01(dataQuality ?? 1);

  let base;
  if (probability < 0.10) {
    base = cfg.kellyExtremeUnderdog;
  } else if (cal.verified
    && cal.sampleSize >= cfg.calibrationStrongSample
    && cal.calibrationError <= cfg.calibrationStrongError
    && dq >= 0.90) {
    base = cfg.kellyWellValidated;
  } else if (cal.verified
    && cal.sampleSize >= cfg.calibrationMinSample
    && cal.calibrationError <= cfg.calibrationMaxError
    && dq >= 0.70) {
    base = cfg.kellyBase;
  } else {
    base = cfg.kellyWeakData;
  }
  return base * dq;
}

/** f* = (p − c) / (1 − c), where c is total effective cost per $1 payout. */
export function fullKellyFraction(probability, effectivePrice) {
  if (effectivePrice >= 1) return 0;
  return Math.max(0, (probability - effectivePrice) / (1 - effectivePrice));
}

/** Per-bet cap, minimum net edge and minimum ROI for this probability. */
export function probabilityRules(probability, cfg) {
  if (probability < 0.10) {
    return { cap: cfg.capSub10, minEdge: cfg.sub10MinNetEdge, minRoi: cfg.sub10MinRoi };
  }
  if (probability < 0.20) {
    return { cap: cfg.cap10to20, minEdge: cfg.minNetEdge, minRoi: cfg.minRoi };
  }
  return { cap: cfg.capOrdinary, minEdge: cfg.minNetEdge, minRoi: cfg.minRoi };
}

/**
 * Lets a high-conviction bet exceed the flat cap — but only on verified
 * calibration, only up to a bounded multiple, and never past the absolute
 * ceiling. Three independent brakes, so one bad edge estimate cannot produce an
 * outsized position on its own.
 */
export function edgeScaledCapMultiplier(netEdge, minEdge, calibration, dataQuality, cfg) {
  if (!cfg.edgeScalingEnabled) return 1;
  const cal = calibration ?? { verified: false, sampleSize: 0, calibrationError: 1 };
  if (!cal.verified
    || cal.sampleSize < cfg.calibrationStrongSample
    || cal.calibrationError > cfg.calibrationStrongError
    || (dataQuality ?? 1) < 0.90) return 1;

  const reference = cfg.edgeScalingReference;
  if (reference <= minEdge) return 1;
  const progress = (netEdge - minEdge) / (reference - minEdge);
  const mult = 1 + Math.max(0, Math.min(1, progress)) * (cfg.edgeScalingMaxMult - 1);
  return Math.max(1, mult);
}

/** Highest price that still leaves the required ROI: p / (1 + roi) − fees. */
export function maximumAcceptablePrice(probability, feeRate, minRoi) {
  return Math.max(0, Math.min(0.999999, probability / (1 + minRoi) - feeRate));
}

/* ------------------------------------------------------------ execution */

/**
 * Walks the ask side and returns the fill we would actually get.
 *
 * Deliberately not the best ask. On a thin book the top level covers a fraction
 * of the order and the rest fills higher up, so sizing off the top quote
 * overstates the edge on exactly the illiquid markets where it matters most.
 */
export function estimateFill(asks, maxPriceDollars, desiredCents, participation) {
  const empty = { contracts: 0, principalCents: 0, averagePrice: 0, highestPrice: 0, levels: 0, availableCents: 0 };
  if (desiredCents <= 0) return empty;

  const levels = (asks ?? [])
    .filter(l => l.contracts > 0 && l.price > 0 && l.price <= maxPriceDollars)
    .sort((a, b) => a.price - b.price);
  if (!levels.length) return empty;

  const availableCents = Math.round(levels.reduce((s, l) => s + l.price * l.contracts * 100, 0));
  const target = Math.min(desiredCents, Math.floor(availableCents * participation));

  let remaining = target;
  let contracts = 0;
  let principal = 0;
  let highest = 0;
  let used = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const levelCents = level.price * level.contracts * 100;
    const takeCents = Math.min(remaining, levelCents);
    contracts += takeCents / (level.price * 100);
    principal += takeCents;
    highest = level.price;
    remaining -= takeCents;
    used += 1;
  }

  const principalCents = Math.round(principal);
  return {
    contracts,
    principalCents,
    averagePrice: contracts > 0 ? (principalCents / 100) / contracts : 0,
    highestPrice: highest,
    levels: used,
    availableCents,
  };
}

/* ------------------------------------------------------------- throttles */

/** Shrinks new positions as the day's realised losses grow. Never liquidates. */
export function dailyThrottle(portfolio, cfg) {
  const loss = Math.max(0, -portfolio.dailyRealisedCents);
  const fraction = portfolio.bankrollCents > 0 ? loss / portfolio.bankrollCents : 0;
  if (fraction >= cfg.dailyStopAt) return { multiplier: 0, reason: 'daily stop — no new entries' };
  if (fraction >= cfg.throttle3At) return { multiplier: cfg.throttle3Mult, reason: 'daily throttle 3' };
  if (fraction >= cfg.throttle2At) return { multiplier: cfg.throttle2Mult, reason: 'daily throttle 2' };
  if (fraction >= cfg.throttle1At) return { multiplier: cfg.throttle1Mult, reason: 'daily throttle 1' };
  return { multiplier: 1, reason: 'no daily throttle' };
}

/** Capital eligible for sizing, after both reserves. */
export function riskBankrollCents(portfolio, cfg) {
  const afterFixed = Math.max(0, portfolio.cashCents - cfg.fixedOperatingReserveCents);
  const afterFreeCash = Math.max(0,
    portfolio.cashCents - Math.round(portfolio.bankrollCents * cfg.minimumFreeCashFraction));
  return Math.min(portfolio.bankrollCents, afterFixed, afterFreeCash);
}

const remainingCapacity = (bankrollCents, capFraction, usedCents) =>
  Math.max(0, Math.round(bankrollCents * capFraction) - (usedCents ?? 0));

function reject(reason, constraint, extra = {}) {
  return {
    approved: false,
    stakeCents: 0,
    contracts: 0,
    limitingConstraint: constraint,
    rejectionReason: reason,
    ...extra,
  };
}

/* ------------------------------------------------------- the main engine */

/**
 * Evaluates one side of one match.
 *
 * Called separately for each player's contract, against that contract's own
 * order book. One side's price is never inferred from the other's — the client
 * was explicit, and they are right: the two contracts of a match carry their
 * own spreads and their own depth.
 */
export function evaluateBet({ opportunity, portfolio, calibration, health, cfg, now = Date.now() }) {
  const opp = opportunity;
  const dq = clamp01(opp.dataQualityScore ?? 1);
  const rawEdge = opp.modelProbability - opp.priceAtModelTime;
  const base = { rawModelEdge: rawEdge, dataQuality: dq };

  if (cfg.rejectWhenUnhealthy && health && !health.healthy) {
    return reject('System health check failed.', 'system health', base);
  }

  const signalAge = (now - opp.modelTimestamp) / 1000;
  if (signalAge > cfg.maxSignalAgeSeconds) {
    return reject(`Model signal is ${Math.round(signalAge)}s old.`, 'signal age', base);
  }

  const snapshotAge = (now - opp.marketSnapshotTimestamp) / 1000;
  if (snapshotAge > cfg.maxSnapshotAgeSeconds) {
    return reject(`Order book is ${Math.round(snapshotAge)}s old.`, 'snapshot age', base);
  }

  const asks = opp.orderBookAsks ?? [];
  if (!asks.length) return reject('No executable ask liquidity.', 'order book', base);

  const bestAsk = Math.min(...asks.filter(l => l.contracts > 0).map(l => l.price));
  if (!Number.isFinite(bestAsk)) return reject('No executable ask liquidity.', 'order book', base);

  /* The price floor. Every backtest we have run puts the losses below roughly
     10c: at a 6c average the model won 2.4% of the time against a 6% breakeven.
     This is the single most load-bearing filter in the engine. */
  if (Math.round(bestAsk * 100) < cfg.minPriceCents) {
    return reject(
      `Best ask ${Math.round(bestAsk * 100)}c is below the ${cfg.minPriceCents}c floor.`,
      'price floor', { ...base, bestAsk });
  }

  if (Math.abs(bestAsk - opp.priceAtModelTime) > cfg.maxPriceMove) {
    return reject('Price moved too far since the model ran.', 'price movement', { ...base, bestAsk });
  }

  const conservativeP = conservativeProbability(opp, cfg);
  if (conservativeP < cfg.absoluteMinProbability) {
    return reject(
      `Shrunk probability ${(conservativeP * 100).toFixed(1)}% is below the trading floor.`,
      'probability floor', { ...base, bestAsk, conservativeP });
  }

  const { cap: baseCap, minEdge, minRoi } = probabilityRules(conservativeP, cfg);
  const feeRate = opp.feeRate ?? kalshiFeeRate(bestAsk);
  const slippage = opp.slippage ?? cfg.expectedSlippage;
  const maxPrice = maximumAcceptablePrice(conservativeP, feeRate + slippage, minRoi);

  const mid = { ...base, bestAsk, conservativeP, maxPrice, feeRate, slippage };

  if (bestAsk > maxPrice) {
    return reject(
      `Best ask ${(bestAsk * 100).toFixed(0)}c exceeds the ${(maxPrice * 100).toFixed(1)}c maximum.`,
      'maximum entry price', mid);
  }

  const effectivePrice = bestAsk + feeRate + slippage;
  const netEdge = conservativeP - effectivePrice;
  const roi = effectivePrice > 0 ? netEdge / effectivePrice : 0;
  const withEv = { ...mid, netEdge, roi };

  if (netEdge < minEdge) {
    return reject(
      `Net edge ${(netEdge * 100).toFixed(1)}pp is below the required ${(minEdge * 100).toFixed(0)}pp.`,
      'minimum net edge', withEv);
  }
  if (roi < minRoi) {
    return reject(
      `Expected ROI ${(roi * 100).toFixed(1)}% is below the required ${(minRoi * 100).toFixed(0)}%.`,
      'minimum ROI', withEv);
  }

  /* Cross-market confirmation. Asks a different question from everything above:
     not "does our model beat this price" but "is Kalshi mispriced against the
     wider book market". Fails closed when required but absent — switching the
     gate on is a decision that every gated trade carries book data. */
  let crossEdge = null;
  if (cfg.crossMarketEnabled) {
    if (opp.bookConsensus == null) {
      return reject('Cross-market confirmation required but no book consensus available.',
        'cross-market data', withEv);
    }
    crossEdge = opp.bookConsensus - effectivePrice;
    if (crossEdge < cfg.crossMarketMinEdge) {
      return reject(
        `Books do not confirm: consensus edge ${(crossEdge * 100).toFixed(1)}pp `
        + `below the required ${(cfg.crossMarketMinEdge * 100).toFixed(0)}pp.`,
        'cross-market edge', { ...withEv, crossEdge });
    }
    if ((opp.supportingBooks ?? 0) < cfg.crossMarketMinBooks) {
      return reject(
        `Only ${opp.supportingBooks ?? 0} book(s) support the direction, `
        + `${cfg.crossMarketMinBooks} required.`,
        'supporting books', { ...withEv, crossEdge });
    }
    if ((opp.consensusRange ?? 0) > cfg.crossMarketMaxSpread) {
      return reject('Books disagree too widely to be treated as a consensus.',
        'consensus dispersion', { ...withEv, crossEdge });
    }
  }

  const riskBankroll = riskBankrollCents(portfolio, cfg);
  if (riskBankroll <= 0) {
    return reject('No capital available after the cash reserve.', 'cash reserve',
      { ...withEv, crossEdge });
  }

  const throttle = dailyThrottle(portfolio, cfg);
  if (throttle.multiplier <= 0) {
    return reject('Daily loss stop reached; new entries disabled.', throttle.reason,
      { ...withEv, crossEdge });
  }

  const peak = portfolio.weeklyPeakCents || portfolio.bankrollCents;
  if (peak > 0 && (peak - portfolio.bankrollCents) / peak >= cfg.weeklyDrawdownStop) {
    return reject('Weekly drawdown stop reached; new entries disabled.', 'weekly drawdown',
      { ...withEv, crossEdge });
  }

  const kellyMultiplier = selectKellyMultiplier(conservativeP, calibration, dq, cfg);
  const kelly = fullKellyFraction(conservativeP, effectivePrice);
  const edgeMult = edgeScaledCapMultiplier(netEdge, minEdge, calibration, dq, cfg);
  const effectiveCap = Math.min(baseCap * edgeMult, cfg.capAbsoluteMax);

  const bucket = probabilityBucket(conservativeP);
  const used = portfolio.exposure ?? {};

  const constraints = {
    'fractional Kelly': Math.round(riskBankroll * kelly * kellyMultiplier * throttle.multiplier),
    'per-bet cap': Math.round(riskBankroll * effectiveCap),
    'match exposure': remainingCapacity(riskBankroll, cfg.capMatchExposure, used.match?.[opp.matchId]),
    'player exposure': remainingCapacity(riskBankroll, cfg.capPlayerExposure, used.player?.[opp.playerId]),
    'player daily stake': remainingCapacity(riskBankroll, cfg.capPlayerDailyStake, used.playerDaily?.[opp.playerId]),
    'probability bucket': remainingCapacity(riskBankroll, cfg.capBucketExposure, used.bucket?.[bucket]),
    'model signal': remainingCapacity(riskBankroll, cfg.capSignalExposure, used.signal?.[opp.modelSignalId]),
    'total unsettled': remainingCapacity(riskBankroll, cfg.capUnsettledExposure, portfolio.unsettledCents),
    'cash available': Math.max(0, portfolio.cashCents - cfg.fixedOperatingReserveCents
      - Math.round(portfolio.bankrollCents * cfg.minimumFreeCashFraction)),
  };

  let limiting = 'fractional Kelly';
  let desired = Infinity;
  for (const [name, value] of Object.entries(constraints)) {
    if (value < desired) { desired = value; limiting = name; }
  }

  const sizing = {
    ...withEv, crossEdge, kelly, kellyMultiplier, baseCap, edgeMult, effectiveCap,
    throttleMultiplier: throttle.multiplier, bucket,
  };

  if (desired < cfg.minimumBetCents) {
    return reject(
      `Risk limits permit $${(desired / 100).toFixed(2)}, below the `
      + `$${(cfg.minimumBetCents / 100).toFixed(2)} minimum order.`,
      limiting, sizing);
  }

  const fill = estimateFill(asks, maxPrice, desired, cfg.maxBookParticipation);
  if (fill.principalCents < cfg.minimumBetCents) {
    return reject('Executable depth permits less than the minimum order.',
      'order-book liquidity', sizing);
  }

  /* Re-check the economics at the volume-weighted price actually reachable,
     not the top of book that got us this far. */
  const finalCost = fill.averagePrice + feeRate + slippage;
  const finalEdge = conservativeP - finalCost;
  const finalRoi = finalCost > 0 ? finalEdge / finalCost : 0;

  if (finalEdge < minEdge || finalRoi < minRoi) {
    return reject('Volume-weighted fill no longer clears the edge and ROI floors.',
      'volume-weighted fill price',
      { ...sizing, netEdge: finalEdge, roi: finalRoi, vwap: fill.averagePrice });
  }

  return {
    approved: true,
    stakeCents: fill.principalCents,
    contracts: fill.contracts,
    ...sizing,
    netEdge: finalEdge,
    roi: finalRoi,
    vwap: fill.averagePrice,
    effectiveCost: finalCost,
    bookLevelsUsed: fill.levels,
    limitingConstraint: fill.principalCents < desired ? 'order-book liquidity' : limiting,
    rejectionReason: null,
    finalBankrollFraction: riskBankroll > 0 ? fill.principalCents / riskBankroll : 0,
  };
}
