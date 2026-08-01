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
/**
 * Fair value from a curve fitted to settled matches, rather than from the
 * hand-written breakpoints below.
 *
 * Two problems with the original are fixed here. It was never fitted to
 * anything — the numbers were an estimate, and measured against 756 settled
 * matches it says 65% at a 0.5 gap where the real rate is 78%. And it moved in
 * coarse segments, which is the substance of the client's complaint that a 0.1
 * gap and a 0.49 gap were being treated alike: they sat in the same segment.
 *
 * The fitted curve interpolates between bracket midpoints, so the output moves
 * continuously with the gap and scales inside a tier as well as between tiers.
 * Falls back to the original curve while a bracket still lacks the sample to be
 * worth trusting.
 */
export function fairFromFittedCurve(gap, curve) {
  if (gap === null || gap === undefined || !Number.isFinite(gap)) return null;
  if (!curve?.length) return fairFromGap(gap);

  const sign = gap < 0 ? -1 : 1;
  const g = Math.abs(gap);

  // anchor at an even split for an identical pair, then each bracket's midpoint
  const points = [{ gap: 0, cents: 50 }];
  for (const b of curve) {
    points.push({ gap: (b.low + b.high) / 2, cents: b.fittedCents });
  }
  points.sort((a, b) => a.gap - b.gap);

  let p;
  if (g >= points[points.length - 1].gap) {
    p = points[points.length - 1].cents;
  } else {
    let i = 0;
    while (i < points.length - 1 && points[i + 1].gap < g) i += 1;
    const a = points[i];
    const b = points[i + 1];
    const span = b.gap - a.gap;
    p = span <= 0 ? b.cents : a.cents + ((g - a.gap) / span) * (b.cents - a.cents);
  }

  const cents = sign > 0 ? p : 100 - p;
  return Math.max(1, Math.min(99, Math.round(cents)));
}

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
export function buildSignalsForEvent(markets, players, curve = null) {
  if (markets.length !== 2) return [];       // only head-to-head binaries are modelled

  return markets.map((m, i) => {
    const opp = markets[1 - i];
    const me = players.get(m.competitor_id);
    const you = players.get(opp.competitor_id);
    const myUtr = me?.utr != null ? Number(me.utr) : null;
    const oppUtr = you?.utr != null ? Number(you.utr) : null;

    const gap = myUtr != null && oppUtr != null ? +(myUtr - oppUtr).toFixed(2) : null;
    /* Prefer the curve fitted to settled matches. The hand-written fallback
       says 65c at a 0.5 gap where the measured rate is 78c, and moves in coarse
       segments that gave a 0.1 gap and a 0.49 gap near-identical prices — the
       client raised exactly that. */
    const fair = curve?.length ? fairFromFittedCurve(gap, curve) : fairFromGap(gap);
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

/**
 * Classifies a Kalshi `occurrence_datetime`.
 *
 * It is not a start time. Across a live sample of 454 markets there were 29
 * distinct values, every one on a :00 or :30 grid, and a number sitting at
 * exactly 00:00Z — a date with no time in it. Rendering such a value in a local
 * zone produces a convincing but invented clock time, so it is labelled instead.
 */
export function classifySchedule(occurrenceIso) {
  if (!occurrenceIso) return { confidence: 'none', source: 'kalshi_missing' };
  const d = new Date(occurrenceIso);
  if (Number.isNaN(d.getTime())) return { confidence: 'none', source: 'kalshi_invalid' };

  // exactly midnight UTC == "some time that day", not a schedule
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
    return { confidence: 'none', source: 'kalshi_placeholder' };
  }
  return { confidence: 'slot', source: 'kalshi_slot' };
}

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/**
 * Match date, parsed from the Kalshi ticker.
 *
 * `KXITFMATCH-26JUL30ZEUSMI-SMI` encodes 2026-07-30, and this is the one piece of
 * timing Kalshi gets right — it agreed with `occurrence_datetime`'s date on 366 of
 * 400 sampled markets, the exceptions being ones whose expiry estimate spills past
 * midnight UTC.
 *
 * `occurrence_datetime` itself is NOT a start time: it is identical to
 * `expected_expiration_time`, i.e. roughly when the match should be over. For
 * ITF M25 Koszalin it read 18:00Z while the match actually began at 13:27Z — 4h33m
 * earlier, about one match's duration. So the day comes from here and the clock
 * time has to come from a real schedule source.
 */
export function matchDateFromTicker(ticker) {
  const m = /^KX[A-Z0-9]+-(\d{2})([A-Z]{3})(\d{2})/.exec(String(ticker ?? ''));
  if (!m || !(m[2] in MONTHS)) return null;
  /* Returned as a plain YYYY-MM-DD string, never a Date. The ticker carries a
     calendar date with no timezone; wrapping it in a UTC Date and then rendering
     that in Pacific shifts it back a day, which made every match look as though it
     had already happened. */
  const month = String(MONTHS[m[2]] + 1).padStart(2, '0');
  return `20${m[1]}-${month}-${m[3]}`;
}

/** Calendar day in a given zone, as YYYY-MM-DD. */
export function dayIn(date, timeZone = 'America/Los_Angeles') {
  return new Date(date).toLocaleDateString('en-CA', { timeZone });
}

/**
 * Whether a market looks like it is in play or already decided, judged from the
 * book rather than a clock.
 *
 * This exists because Kalshi publishes no start time. Two signals the trader
 * identified and the data confirms:
 *  - a quote at or beyond 2c/97c does not occur before a ball is struck;
 *  - a pre-match book barely moves, while an in-play one swings hard.
 */
export function looksInPlay({
  bid, ask, recentMoveCents, volumeGrowth3h,
  moveThreshold = 8, volumeThreshold = 150,
} = {}) {
  /* Volume growth is the strongest signal by a wide margin. Measured while ITF M25
     Koszalin was in play: markets under way had grown 48,047 / 17,936 / 1,182
     contracts over three hours; markets yet to start had grown 0 / 0 / 9. */
  if (volumeGrowth3h != null && volumeGrowth3h >= volumeThreshold) return 'volume_says_in_play';
  if (bid != null && (bid <= 2 || bid >= 97)) return 'price_implies_in_play';
  if (ask != null && (ask <= 2 || ask >= 98)) return 'price_implies_in_play';
  if (recentMoveCents != null && recentMoveCents >= moveThreshold) return 'price_moving_like_in_play';
  return null;
}

/**
 * Whether a price represents the favourite or the underdog.
 *
 * A Kalshi contract settles at $1, so its price is the market's probability: above
 * 50c is the side expected to win. The narrow band around even money is called out
 * separately because "favourite" means little at 49c.
 */
export function sideType(priceCents) {
  if (priceCents == null) return null;
  if (priceCents >= 55) return 'favourite';
  if (priceCents <= 45) return 'underdog';
  return 'pickem';
}
