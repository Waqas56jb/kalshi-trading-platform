/**
 * Decides whether a Kalshi quote is a price or an absence of one.
 *
 * This is the single most consequential check in the desk. On a two-sided binary
 * market the two yes-asks must sum to roughly 100 — that is what it means for
 * them to be the same match. Across a live sample of 108 markets they summed to
 * 149 on average, and 64 of them exceeded 115, with many showing 95c on both
 * sides against bids of 2c.
 *
 * A 95c ask with a 2c bid is not the market saying a player is 95% to win. It is
 * Kalshi displaying the widest possible spread because nobody is quoting at all.
 * Reading it as a price is how the desk came to report a player at "94% ask on
 * Kalshi" while the model said 14% — the client asked how that was possible, and
 * the answer is that the 94c never existed.
 *
 * Everything downstream depends on this: the edge, the shrinkage anchor, the
 * favourite/underdog label, and every backtest that used market_cents.
 */

/** Widest spread that can still be a real quote. Beyond this nobody is making a market. */
export const MAX_REAL_SPREAD_CENTS = 40;

/** How far the two sides may sum from 100 before the pair is nonsense. */
export const MAX_OVERROUND_CENTS = 15;

/** A bid at or below this is a placeholder, not an offer. */
export const MIN_REAL_BID_CENTS = 2;

/**
 * Classifies one side of a match, given the opponent's ask where we have it.
 *
 * Returns `{ tradable, reason, spread, overround, oneSided? }`. `tradable: false`
 * never means "a bad price" — it means there is no price, and the caller must
 * not compute an edge against it.
 *
 * Exception (Aug 2026): ITF often shows a real cheap ask (e.g. Kamendje 35¢)
 * while the favourite side sits on a 90–95¢ placeholder. Failing the whole
 * match as "book_is_empty" then blocked the only tradable edge. A mid-range
 * ask with a sane spread on *this* side is allowed one-sided.
 */
export function assessQuote({ bid, ask, opponentAsk = null }) {
  if (ask == null) return { tradable: false, reason: 'no_ask', spread: null, overround: null };

  const spread = bid == null ? null : ask - bid;
  const overround = opponentAsk == null ? null : ask + opponentAsk - 100;

  if (ask <= 0 || ask >= 100) {
    return { tradable: false, reason: 'degenerate_price', spread, overround };
  }
  /* Favourite-side placeholders — never trade these as if they were 90%+. */
  if (bid != null && bid <= MIN_REAL_BID_CENTS && ask >= 90) {
    return { tradable: false, reason: 'placeholder_quote', spread, overround };
  }
  if (spread != null && spread > MAX_REAL_SPREAD_CENTS && ask >= 80) {
    return { tradable: false, reason: 'spread_not_a_market', spread, overround };
  }

  /* Client (Max): the other side shouldn't matter if OUR ask is a real mid-range
     offer. ITF favourite placeholders (90–95¢) used to zero the whole board. */
  const thisSideLooksLive = ask >= 12 && ask <= 80;

  /* Two-sided nonsense — trade this side alone when the ask itself looks live. */
  if (overround != null && Math.abs(overround) > MAX_OVERROUND_CENTS) {
    if (thisSideLooksLive) {
      return { tradable: true, reason: null, spread, overround, oneSided: true };
    }
    return { tradable: false, reason: 'book_is_empty', spread, overround };
  }
  if (spread != null && spread > MAX_REAL_SPREAD_CENTS) {
    if (thisSideLooksLive) {
      return { tradable: true, reason: null, spread, overround, oneSided: true };
    }
    return { tradable: false, reason: 'spread_not_a_market', spread, overround };
  }

  return { tradable: true, reason: null, spread, overround, oneSided: false };
}

/**
 * The market's own probability for this side, with the spread removed.
 *
 * Uses both sides normalised to sum to one, which is the honest reference: a
 * single ask carries half the spread and is biased high by it. Returns null
 * rather than a guess when the pair is not a real book, because a wrong anchor
 * is worse than no anchor — it silently drags the shrunk probability toward a
 * number nobody was ever offering.
 */
export function marketProbability({ bid, ask, opponentBid = null, opponentAsk = null }) {
  const assessment = assessQuote({ bid, ask, opponentAsk });
  if (!assessment.tradable) return { probability: null, ...assessment };

  const mid = bid != null ? (bid + ask) / 2 : ask;
  /* One-sided: opponent is a placeholder — anchor on this ask only so a real
     35¢ offer is not dragged toward a fake 95¢ favourite quote. */
  if (assessment.oneSided) {
    return { probability: mid / 100, ...assessment };
  }

  const oppMid = opponentBid != null && opponentAsk != null
    ? (opponentBid + opponentAsk) / 2
    : opponentAsk;

  const probability = oppMid != null && mid + oppMid > 0
    ? mid / (mid + oppMid)
    : mid / 100;

  return { probability, ...assessment };
}

/** Human-readable, for the terminal. */
export const QUOTE_REASONS = {
  no_ask: 'No ask quoted',
  book_is_empty: 'No real market — both sides quoted far apart',
  spread_not_a_market: 'Spread too wide to be a market',
  placeholder_quote: 'Placeholder quote, nobody is offering',
  degenerate_price: 'Price is at the boundary',
};
