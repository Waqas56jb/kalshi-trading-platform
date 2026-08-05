/**
 * Decides whether a Kalshi quote is a price we can buy against.
 *
 * Desk rule (Max, Aug 2026): we only buy YES at the ask. Bid is irrelevant for
 * entry — especially pre-match. Opponent-side placeholders must not kill a
 * real ask that already beats our fair.
 */

/** Ask band: Robbie/Max Aug 5 — cut big underdogs (<35¢); keep 35–50 and favs. */
export const MIN_BUY_ASK_CENTS = 35;
export const MAX_BUY_ASK_CENTS = 85;

/** Kept for sync/review callers that still classify empty books. */
export const MAX_REAL_SPREAD_CENTS = 40;
export const MAX_OVERROUND_CENTS = 15;
export const MIN_REAL_BID_CENTS = 2;

/**
 * Buy-side check: is there an ask we can hit?
 *
 * `bid` / `opponentAsk` are ignored for tradability. They may still be passed
 * for logging. Returns `{ tradable, reason, oneSided }`.
 */
export function assessQuote({ bid, ask, opponentAsk = null }) {
  if (ask == null) return { tradable: false, reason: 'no_ask', spread: null, overround: null };

  const spread = bid == null ? null : ask - bid;
  const overround = opponentAsk == null ? null : ask + opponentAsk - 100;

  if (ask <= 0 || ask >= 100) {
    return { tradable: false, reason: 'degenerate_price', spread, overround };
  }
  /* Extreme favourite asks with no real interest — not a buy we want. */
  if (ask >= 90) {
    return { tradable: false, reason: 'placeholder_quote', spread, overround };
  }
  if (ask < MIN_BUY_ASK_CENTS || ask > MAX_BUY_ASK_CENTS) {
    return { tradable: false, reason: 'ask_out_of_band', spread, overround };
  }

  /* Buy path is ask-only. Opponent / bid do not gate the entry. */
  return {
    tradable: true,
    reason: null,
    spread,
    overround,
    oneSided: true,
  };
}

/**
 * Market reference for shrink: the ask we would pay (not mid, not opponent).
 */
export function marketProbability({ bid, ask, opponentBid = null, opponentAsk = null }) {
  const assessment = assessQuote({ bid, ask, opponentAsk });
  if (!assessment.tradable) return { probability: null, ...assessment };

  return { probability: ask / 100, ...assessment };
}

/** Human-readable, for the terminal. Ask-only path — no spread/both-sides copy. */
export const QUOTE_REASONS = {
  no_ask: 'No ask quoted',
  book_is_empty: 'No ask available to buy',
  spread_not_a_market: 'Ask not tradable',
  placeholder_quote: 'Placeholder ask (≥90¢) — not a buy',
  degenerate_price: 'Ask is at the boundary',
  ask_out_of_band: 'Ask outside the 35–85¢ buy band (no big underdogs)',
};
