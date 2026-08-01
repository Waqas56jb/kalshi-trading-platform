/**
 * Cross-market confirmation against sharp sportsbooks.
 *
 * Ported from the client's Python. This asks a different question from the
 * rest of the desk: not "does our model beat Kalshi's price" but "is Kalshi's
 * own price wrong compared with what the wider book market believes". That is a
 * more defensible signal precisely because it does not depend on trusting our
 * model — which the backtest says we should not yet do.
 *
 * Odds come from a licensed aggregator. Scraping sportsbooks directly breaches
 * their terms, so it is not an option here.
 */

/** Decimal odds to raw implied probability. 2.50 → 40%. */
export function decimalToImplied(decimalOdds) {
  if (!(decimalOdds > 1)) throw new Error('decimal odds must be greater than 1');
  return 1 / decimalOdds;
}

/**
 * Removes vig from a two-outcome market by subtracting an equal absolute share
 * of the overround from each side.
 *
 * For exactly two outcomes this is equivalent to Shin's method, which models
 * the margin as arising from informed trading and is more accurate than
 * proportional normalisation on lines with a favourite-longshot bias — which
 * describes every tennis market we care about.
 */
export function devigTwoWay(impliedFor, impliedAgainst) {
  const overround = impliedFor + impliedAgainst - 1;
  return impliedFor - overround / 2;
}

export function devigQuote(quote) {
  return devigTwoWay(
    decimalToImplied(quote.decimalOddsFor),
    decimalToImplied(quote.decimalOddsAgainst),
  );
}

/**
 * De-vigs each book independently, then averages.
 *
 * Books are weighted equally by default. A weight can be supplied per book if
 * one is genuinely sharper — Pinnacle usually is on tennis — but guessing
 * weights without evidence would just be another hand-tuned number of the kind
 * that has already cost us once.
 */
export function bookConsensus(quotes) {
  const list = (quotes ?? []).filter(q => q && q.decimalOddsFor > 1 && q.decimalOddsAgainst > 1);
  if (!list.length) return null;

  const probs = list.map(q => ({
    book: q.book,
    probability: devigQuote(q),
    weight: q.weight ?? 1,
  }));

  const totalWeight = probs.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) return null;

  const weighted = probs.reduce((s, p) => s + p.probability * p.weight, 0) / totalWeight;
  const sorted = probs.map(p => p.probability).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    consensus: weighted,
    median,
    books: probs.length,
    range: sorted[sorted.length - 1] - sorted[0],
    perBook: probs,
  };
}

/**
 * Full verification of one Kalshi opportunity against the books.
 *
 * Returns a classification rather than a bare boolean so a rejection can be
 * read: MODEL_ONLY means our model liked it and the books did not, which is
 * the case worth watching, since that is precisely the pattern that lost money
 * historically.
 */
export function verifyAgainstBooks({
  modelProbability,
  kalshiVwap,
  feeRate = 0,
  slippage = 0,
  quotes,
  minModelEdge = 0.05,
  minConsensusEdge = 0.03,
  minSupportingBooks = 2,
  maxConsensusRange = 0.10,
  minIndividualBookEdge = 0.01,
}) {
  const agg = bookConsensus(quotes);
  const effectiveCost = kalshiVwap + feeRate + slippage;

  if (!agg) {
    return {
      approved: false,
      classification: 'NO_BOOK_DATA',
      effectiveCost,
      modelNetEdge: modelProbability - effectiveCost,
      reason: 'No usable sportsbook quotes were supplied.',
    };
  }

  if (effectiveCost >= 1) {
    return {
      approved: false,
      classification: 'INVALID_COST',
      ...agg,
      effectiveCost,
      reason: 'Effective cost is at or above the $1 payout.',
    };
  }

  const modelNetEdge = modelProbability - effectiveCost;
  const consensusEdge = agg.consensus - effectiveCost;
  const supportingBooks = agg.perBook
    .filter(p => p.probability - effectiveCost >= minIndividualBookEdge).length;

  const modelSupports = modelNetEdge >= minModelEdge;
  const booksSupport = consensusEdge >= minConsensusEdge
    && supportingBooks >= minSupportingBooks
    && agg.range <= maxConsensusRange;

  let classification;
  let reason;
  if (modelSupports && booksSupport) {
    classification = 'MODEL_AND_BOOK_VERIFIED';
    reason = 'Model and book consensus both show Kalshi underpriced.';
  } else if (modelSupports) {
    classification = 'MODEL_ONLY';
    reason = 'Our model sees value but the books do not confirm it.';
  } else if (booksSupport) {
    classification = 'BOOK_ONLY';
    reason = 'The books see value but our model does not clear its edge floor.';
  } else {
    classification = 'UNVERIFIED';
    reason = 'Neither the model nor the books show sufficient value.';
  }

  return {
    approved: modelSupports && booksSupport,
    classification,
    consensus: agg.consensus,
    median: agg.median,
    books: agg.books,
    range: agg.range,
    perBook: agg.perBook,
    effectiveCost,
    modelNetEdge,
    consensusEdge,
    supportingBooks,
    reason,
  };
}
