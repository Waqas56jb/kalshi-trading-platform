/**
 * Bookmaker odds, converted to something directly comparable with a Kalshi price.
 *
 * A Kalshi contract settles at $1, so its price in cents *is* an implied
 * probability. American odds convert to the same scale:
 *
 *   +100  ->  100/(100+100)  =  50%  ->  50c
 *   +200  ->  100/(200+100)  =  33%  ->  33c
 *   +450  ->  100/(450+100)  =  18%  ->  18c
 *   -800  ->  800/(800+100)  =  89%  ->  89c
 *
 * Once both sides are in cents, "trading far from the odds" is just a subtraction.
 */

/** American odds -> implied probability in cents (1-99). */
export function americanToCents(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) return null;
  const p = n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
  return Math.max(1, Math.min(99, Math.round(p * 100)));
}

/** Decimal (European) odds -> implied cents. 2.00 -> 50c. */
export function decimalToCents(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n <= 1) return null;
  return Math.max(1, Math.min(99, Math.round((1 / n) * 100)));
}

export function centsToAmerican(cents) {
  const p = Number(cents) / 100;
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}

/**
 * Removes the bookmaker's margin from a two-way market.
 *
 * Raw implied probabilities sum to more than 100% — that overround is the vig,
 * and it is how the book makes money. The screenshot's -800 / +450 gives 89c and
 * 18c, summing to 107c; scaling both by 100/107 yields 83c and 17c, which is the
 * book's actual view. Comparing a Kalshi price against un-normalised odds would
 * make every favourite look cheap.
 */
export function removeVig(centsA, centsB) {
  const total = centsA + centsB;
  if (!total) return { a: centsA, b: centsB, overround: 0 };
  return {
    a: Math.max(1, Math.min(99, Math.round((centsA / total) * 100))),
    b: Math.max(1, Math.min(99, Math.round((centsB / total) * 100))),
    overround: +(total - 100).toFixed(1),
  };
}

/**
 * Provider adapters. Each returns
 *   [{ playerName, americanOdds?, decimalOdds?, bookmaker? }]
 * for one match, and the caller converts and stores.
 *
 * Bet Hero is stubbed until its endpoint and auth are known — it throws a clear
 * error rather than inventing a URL, so a misconfiguration is obvious instead of
 * silently producing no odds.
 */
export const providers = {
  /** The Odds API (the-odds-api.com) — the common aggregator shape. */
  async theoddsapi({ apiKey, sport = 'tennis_atp', signal }) {
    if (!apiKey) throw new Error('ODDS_API_KEY is not set');
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds`
      + `?apiKey=${encodeURIComponent(apiKey)}&regions=us,uk,eu&markets=h2h&oddsFormat=american`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Odds API ${res.status}: ${(await res.text()).slice(0, 160)}`);

    const events = await res.json();
    return events.flatMap(ev =>
      (ev.bookmakers ?? []).flatMap(bk =>
        (bk.markets ?? []).filter(m => m.key === 'h2h').flatMap(m =>
          (m.outcomes ?? []).map(o => ({
            matchup: `${ev.home_team} vs ${ev.away_team}`,
            commenceTime: ev.commence_time,
            playerName: o.name,
            americanOdds: o.price,
            bookmaker: bk.title ?? bk.key,
          })))));
  },

  async bethero() {
    throw Object.assign(
      new Error('Bet Hero is not configured: its base URL, authentication method and '
        + 'response shape are still unknown. Set BETHERO_BASE_URL and BETHERO_API_KEY and '
        + 'implement this adapter once the API details are available.'),
      { code: 'provider_not_configured' },
    );
  },
};

/**
 * How far a Kalshi price sits from the bookmaker consensus, in cents.
 *
 * Positive means Kalshi is cheaper than the books think it should be, which is
 * the direction worth buying. This is the check the UTR model cannot do on its
 * own: when the books agree with Kalshi, a large UTR "edge" is the model being
 * wrong, not an opportunity.
 */
export function divergence({ kalshiCents, consensusCents }) {
  if (kalshiCents == null || consensusCents == null) return null;
  return {
    kalshi_cents: kalshiCents,
    consensus_cents: consensusCents,
    diff_cents: consensusCents - kalshiCents,
    kalshi_cheaper: consensusCents > kalshiCents,
  };
}
