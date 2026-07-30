/**
 * The UTR fair-value model and the parsers that turn Kalshi's market payloads
 * into the shape this desk reasons about.
 *
 * There is no invented data anywhere in this file: every number either comes
 * from Kalshi or from a UTR rating that was explicitly imported. When a rating
 * is missing the model returns null rather than a guess.
 */

/** Kalshi returns money as decimal dollar strings ("0.8200"). We store cents. */
export function dollarsToCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Titles look like:
 *   "Will Johannus Monday win the Monday vs Hance: M25 Edwardsville IL Round of 16 match?"
 * rules_primary carries the year and the same tournament string, which is a
 * more reliable source for the tournament than the title in some events.
 */
export function parseMarketTitle(title = '', rules = '') {
  const out = { player: null, matchup: null, tournament: null, round: null, tourLevel: null };

  const m = /^Will\s+(.+?)\s+win the\s+(.+?):\s*(.+?)\s+match\?$/i.exec(title.trim());
  if (m) {
    out.player = m[1].trim();
    out.matchup = m[2].trim();
    const tail = m[3].trim();
    const r = /\b(Round of \d+|Quarterfinal|Semifinal|Final|R\d+|Qualifying(?:\s+Round)?(?:\s+\d+)?)\b/i.exec(tail);
    if (r) {
      out.round = r[1];
      out.tournament = tail.slice(0, r.index).trim() || null;
    } else {
      out.tournament = tail;
    }
  } else {
    // fall back to whatever the matchup looks like
    const alt = /win the\s+(.+?)\s+match/i.exec(title);
    if (alt) out.matchup = alt[1].trim();
  }

  // tour level: M15/M25/W35/W75/W100 … or ATP/WTA/Challenger
  const lvl = /\b([MW]\d{2,3})\b/.exec(out.tournament || title)
    || /\b(ATP|WTA|Challenger|ITF)\b/i.exec(out.tournament || title);
  if (lvl) out.tourLevel = lvl[1].toUpperCase();

  if (!out.tournament && rules) {
    const rm = /professional tennis match in the\s+(?:\d{4}\s+)?(.+?)(?:\s+(Round of \d+|Quarterfinal|Semifinal|Final))?\s*$/im
      .exec(rules.split('\n')[0] || '');
    if (rm) {
      out.tournament = rm[1].replace(/\.$/, '').trim();
      if (!out.round && rm[2]) out.round = rm[2];
    }
  }
  return out;
}

/**
 * Maps a UTR rating gap to a fair win probability, in cents.
 *
 * This is the desk's documented strategy — the same curve advertised on the
 * landing page: Δ2.0+ → ~99%, Δ1.0 → 85–90%, Δ0.5 → ~65%, Δ0 → ~50%.
 * `gap` is (this player's UTR − opponent's UTR) and may be negative.
 */
export function fairFromGap(gap) {
  if (gap === null || gap === undefined || !Number.isFinite(gap)) return null;
  const sign = gap < 0 ? -1 : 1;
  const g = Math.abs(gap);

  let p;                                  // probability the higher-rated player wins
  if (g >= 2.0) p = 99;
  else if (g >= 1.0) p = 85 + (Math.min(g, 2) - 1) * 14;
  else if (g >= 0.5) p = 65 + (g - 0.5) * 40;
  else p = 50 + g * 30;

  const cents = sign > 0 ? p : 100 - p;
  return Math.max(1, Math.min(99, Math.round(cents)));
}

/**
 * Expected value of buying YES at the market's ask, given fair value.
 * Returns percent. Uses the ask because that is the price you actually pay.
 */
export function evPct(fairCents, priceCents) {
  if (!fairCents || !priceCents || priceCents <= 0) return null;
  return +(((fairCents - priceCents) / priceCents) * 100).toFixed(2);
}

/** Executable price for a YES buy: the ask, falling back to last/bid. */
export function executablePrice(m) {
  return m.yes_ask_cents ?? m.last_price_cents ?? m.yes_bid_cents ?? null;
}

/** Mid price — what the UI shows as "market". */
export function midPrice(m) {
  const { yes_bid_cents: b, yes_ask_cents: a } = m;
  if (b != null && a != null && a > 0 && b > 0) return Math.round((b + a) / 2);
  return m.last_price_cents ?? a ?? b ?? null;
}

/**
 * Builds signals for the two markets of one event.
 * `players` maps competitor_id -> { name, utr }.
 */
export function buildSignalsForEvent(markets, players) {
  if (markets.length !== 2) return [];       // only head-to-head binaries are modelled

  return markets.map((m, i) => {
    const opp = markets[1 - i];
    const me = players.get(m.competitor_id);
    const you = players.get(opp.competitor_id);
    const myUtr = me?.utr != null ? Number(me.utr) : null;
    const oppUtr = you?.utr != null ? Number(you.utr) : null;

    const gap = myUtr != null && oppUtr != null ? +(myUtr - oppUtr).toFixed(2) : null;
    const fair = fairFromGap(gap);
    const price = executablePrice(m);
    const ev = fair != null ? evPct(fair, price) : null;

    return {
      ticker: m.ticker,
      event_ticker: m.event_ticker,
      player_name: m.player_name,
      opponent_name: opp.player_name,
      player_utr: myUtr,
      opponent_utr: oppUtr,
      utr_gap: gap,
      fair_cents: fair,
      market_cents: price,
      ev_pct: ev,
      model: 'utr_gap_v1',
    };
  });
}
