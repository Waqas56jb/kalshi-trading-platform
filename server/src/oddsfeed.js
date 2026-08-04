/**
 * Sportsbook odds via the Tennis API (RapidAPI, "Tennis API - ATP WTA ITF").
 *
 * Verified against the live product with the desk's own key:
 *   - Fixtures come from /tennis/v2/{atp|wta}/fixtures. There is no `itf` tour
 *     type — ITF events live inside atp/wta, marked by tournament rankId 0
 *     (ITF $10-25K) and 1 (Challenger / ITF above $10K). Asking for `itf`
 *     returns 400, which is exactly how "the API has no ITF" got believed.
 *   - Odds come from /tennis/v2/extend/api/odds/summary/{fixtureId}. Books
 *     post ITF prices close to first serve, so a null result is normal hours
 *     out and the feed simply reports "no quotes yet".
 *
 * Matching to Kalshi is by normalised player-name pair. Everything is cached:
 * the fixture index for ten minutes, per-fixture odds for five, so a cycle
 * over the same slate costs almost no requests against the 100/min limit.
 */
const HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';

const apiKey = () => process.env.TENNIS_API_KEY || '';
export const oddsFeedConfigured = () => Boolean(apiKey());

async function fetchJson(path, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${HOST}${path}`, {
      headers: { 'X-RapidAPI-Key': apiKey(), 'X-RapidAPI-Host': HOST },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`odds feed ${res.status} on ${path}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* Order-insensitive, accent-insensitive name keys, so "Émile Hudd" on the
   books matches "Emile Hudd" on Kalshi whichever player is listed first. */
const normName = s => String(s ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z ]/g, ' ')
  .split(/\s+/).filter(Boolean).sort().join(' ');

const pairKey = (a, b) => [normName(a), normName(b)].sort().join('|');

/* ------------------------------------------------------------ fixture index */

const FIXTURE_TTL_MS = 10 * 60 * 1000;
let fixtureCache = { at: 0, map: new Map() };
let fixtureLoad = null;

async function buildFixtureIndex() {
  const map = new Map();
  for (const tour of ['atp', 'wta']) {
    for (let page = 1; page <= 4; page++) {
      let j;
      try {
        j = await fetchJson(
          `/tennis/v2/${tour}/fixtures?filter=PlayerGroup:singles&pageSize=100&pageNo=${page}`);
      } catch {
        break; // partial index is still useful; next refresh retries
      }
      for (const f of j?.data ?? []) {
        const p1 = f?.player1?.name;
        const p2 = f?.player2?.name;
        if (!f?.id || !p1 || !p2) continue;
        map.set(pairKey(p1, p2), { id: f.id, p1, p2 });
      }
      if (!j?.hasNextPage) break;
    }
  }
  return map;
}

async function fixtureIndex() {
  if (Date.now() - fixtureCache.at < FIXTURE_TTL_MS) return fixtureCache.map;
  // single in-flight rebuild, however many candidates ask at once
  fixtureLoad ??= buildFixtureIndex()
    .then(map => { fixtureCache = { at: Date.now(), map }; return map; })
    .finally(() => { fixtureLoad = null; });
  return fixtureLoad;
}

/* --------------------------------------------------------------- schedule */

/*
 * The date-scoped fixtures route doubles as a schedule feed: unlike the plain
 * listing (where `date` is mostly null), /fixtures/{YYYY-MM-DD} carries a real
 * clock time on every row — verified 103/103 for 3 Aug 2026, ITF included.
 * The desk already pays for this API, so it replaces the paid schedule
 * provider we thought we needed.
 */
const scheduleCache = new Map(); // date -> { at, events }

export async function fixturesForDate(date) {
  if (!oddsFeedConfigured() || !date) return [];
  const hit = scheduleCache.get(date);
  if (hit && Date.now() - hit.at < FIXTURE_TTL_MS) return hit.events;

  const events = [];
  for (const tour of ['atp', 'wta']) {
    for (let page = 1; page <= 4; page++) {
      let j;
      try {
        j = await fetchJson(
          `/tennis/v2/${tour}/fixtures/${date}?filter=PlayerGroup:singles&pageSize=100&pageNo=${page}`);
      } catch {
        break; // partial day is still useful; the cache TTL retries
      }
      for (const f of j?.data ?? []) {
        const home = f?.player1?.name;
        const away = f?.player2?.name;
        if (!home || !away || !f?.date) continue;
        events.push({ home, away, startsAt: f.date, status: null, tournament: '' });
      }
      if (!j?.hasNextPage) break;
    }
  }
  scheduleCache.set(date, { at: Date.now(), events });
  return events;
}

/* -------------------------------------------------------------------- odds */

const ODDS_TTL_MS = 5 * 60 * 1000;
const oddsCache = new Map(); // fixtureId -> { at, books }
let loggedUnknownShape = false;

/**
 * Extracts per-book decimal odds from the odds summary, oriented to the
 * fixture's player1/player2.
 *
 * The payload shape is the provider's, not ours, so the parser hunts through
 * the shapes their products use rather than trusting one exact layout. An
 * unrecognised payload is logged once per process so it can be added, and
 * parses as "no quotes" rather than guessing.
 */
export function parseOddsSummary(payload) {
  const out = [];
  const r = payload?.result ?? payload?.data ?? null;
  if (!r) return out;

  const candidates = [r.bookmakers, r.odds, r.books, r.list, Array.isArray(r) ? r : null]
    .filter(Array.isArray);
  for (const list of candidates) {
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      const book = b.bookmaker ?? b.bookmakerName ?? b.bookName ?? b.name ?? b.book ?? null;
      const o1 = Number(b.player1Odds ?? b.homeOdds ?? b.odds1 ?? b.home ?? b.p1 ?? NaN);
      const o2 = Number(b.player2Odds ?? b.awayOdds ?? b.odds2 ?? b.away ?? b.p2 ?? NaN);
      if (book && o1 > 1 && o2 > 1) out.push({ book: String(book), forPlayer1: o1, forPlayer2: o2 });
    }
    if (out.length) break;
  }

  if (!out.length && !loggedUnknownShape) {
    loggedUnknownShape = true;
    console.log('oddsfeed: unrecognised odds payload:', JSON.stringify(payload).slice(0, 800));
  }
  return out;
}

/**
 * Final / live set score from the Live API side of the same RapidAPI product.
 *
 *   GET /tennis/v2/extend/api/event/get/{player1}/{player2}/{YYYY-MM-DD}
 *
 * Returns e.g. `{ score: "6-4 6-3", status: "Ended", p1, p2 }` or null.
 * Score is oriented to participant1–participant2 (API order).
 */
export async function scoreForMatch(playerName, opponentName, dateOnly) {
  if (!oddsFeedConfigured() || !playerName || !opponentName || !dateOnly) return null;

  const tryOrder = async (a, b) => {
    const path = `/tennis/v2/extend/api/event/get/`
      + `${encodeURIComponent(a)}/${encodeURIComponent(b)}/${encodeURIComponent(dateOnly)}`;
    try {
      /* Short timeout — scores must not blow the Vercel 60s sync budget. */
      const j = await fetchJson(path, { timeoutMs: 4000 });
      const r = j?.result ?? j?.data ?? null;
      if (!r) return null;
      const raw = r.score ?? r.result ?? null;
      if (!raw || typeof raw !== 'string') return null;
      /* "7-6,6-1" or "6-4 6-3" → space-separated; drop trailing empty sets. */
      const score = String(raw)
        .replace(/,/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(set => {
          const [x, y] = set.split('-').map(Number);
          return Number.isFinite(x) && Number.isFinite(y) && !(x === 0 && y === 0);
        })
        .join(' ');
      if (!score) return null;
      return {
        score,
        status: r.status ?? null,
        p1: r.participant1 ?? a,
        p2: r.participant2 ?? b,
        eventId: r.id ?? null,
      };
    } catch {
      return null;
    }
  };

  return (await tryOrder(playerName, opponentName))
    ?? (await tryOrder(opponentName, playerName));
}

/**
 * Bookmaker quotes for one Kalshi market's player, or null when the books
 * have nothing — no fixture matched, or no odds posted yet.
 *
 * Returned quotes are oriented so `decimalOddsFor` prices the named player,
 * ready for crossmarket.js's de-vig and consensus.
 */
export async function quotesForMatch(playerName, opponentName) {
  if (!oddsFeedConfigured() || !playerName || !opponentName) return null;

  const idx = await fixtureIndex();
  const fx = idx.get(pairKey(playerName, opponentName));
  if (!fx) return null;

  let cached = oddsCache.get(fx.id);
  if (!cached || Date.now() - cached.at > ODDS_TTL_MS) {
    let books = [];
    try {
      books = parseOddsSummary(await fetchJson(`/tennis/v2/extend/api/odds/summary/${fx.id}`));
    } catch {
      books = []; // treated as "no quotes"; the TTL retries soon enough
    }
    cached = { at: Date.now(), books };
    oddsCache.set(fx.id, cached);
  }
  if (!cached.books.length) return null;

  const playerIsP1 = normName(fx.p1) === normName(playerName);
  return {
    fixtureId: fx.id,
    quotes: cached.books.map(b => ({
      book: b.book,
      decimalOddsFor: playerIsP1 ? b.forPlayer1 : b.forPlayer2,
      decimalOddsAgainst: playerIsP1 ? b.forPlayer2 : b.forPlayer1,
    })),
  };
}
