/**
 * UTR (Universal Tennis Rating) lookup.
 *
 * Ratings come from UTR's public player-search endpoint. Matching a Kalshi
 * competitor to a UTR profile is fuzzy, so every accepted match records the
 * profile id, the name it matched, and a confidence score — a wrong match would
 * otherwise quietly corrupt every fair value derived from it.
 */

const UTR_SEARCH = 'https://api.utrsports.net/v2/search/players';
const UTR_LOGIN = 'https://app.utrsports.net/api/v1/auth/login';

/*
 * Authenticated lookups. UTR hides many ratings from anonymous requests —
 * profiles that read "Rated" still return 0.0 without a login (Daniel Blazka:
 * 0.0 anonymous, 10.93 with the client's Power account). Credentials live in
 * env vars; the JWT they buy lasts about a month and is cached per instance.
 */
const utrCreds = () => ({
  email: process.env.UTR_EMAIL || '',
  password: process.env.UTR_PASSWORD || '',
});

let cachedJwt = null;   // { token, expiresAt (ms) }

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function utrLogin() {
  const { email, password } = utrCreds();
  if (!email || !password) return null;

  const res = await fetch(UTR_LOGIN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    console.warn(`UTR login failed: ${res.status}`);
    return null;
  }
  const token = res.headers.get('jwt-token');
  if (!token) return null;

  // refresh a day before the token actually dies
  cachedJwt = { token, expiresAt: jwtExpiryMs(token) - 24 * 3600 * 1000 };
  return cachedJwt.token;
}

async function utrToken() {
  if (cachedJwt && Date.now() < cachedJwt.expiresAt) return cachedJwt.token;
  try {
    return await utrLogin();
  } catch (e) {
    console.warn(`UTR login error: ${e.message}`);
    return null;
  }
}

/** Kalshi series -> expected UTR gender, used to reject cross-gender matches. */
const SERIES_GENDER = {
  KXITFMATCH: 'Male',
  KXITFWMATCH: 'Female',
  KXATPMATCH: 'Male',
  KXWTAGAME: 'Female',
  KXCHALLENGERMATCH: 'Male',
  KXWTACHALLENGERMATCH: 'Female',
};

export const genderForSeries = s => SERIES_GENDER[s] ?? null;

/** Lowercase, strip diacritics and punctuation — "Ñuñoa" and "Nunoa" must agree. */
export function normaliseName(s = '') {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = s => normaliseName(s).split(' ').filter(Boolean);

/**
 * Similarity in [0,1] between a Kalshi name and a UTR displayName.
 *
 * Kalshi often carries more name parts than UTR ("Alvaro Ariel Frutos Alonso"
 * vs "Alvaro Frutos Alonso"), so this scores token overlap rather than equality
 * and separately insists the surname lines up.
 */
export function nameScore(kalshiName, utrName) {
  const a = tokens(kalshiName);
  const b = tokens(utrName);
  if (!a.length || !b.length) return 0;

  const setB = new Set(b);
  const overlap = a.filter(x => setB.has(x)).length;
  const base = overlap / Math.max(a.length, b.length);

  // surname agreement: last token of either side present on the other
  const surnameOk = setB.has(a[a.length - 1]) || new Set(a).has(b[b.length - 1]);
  if (!surnameOk) return base * 0.35;

  // exact match after normalisation
  if (normaliseName(kalshiName) === normaliseName(utrName)) return 1;
  return Math.min(1, base + 0.15);
}

async function searchUtr(name, { signal, top = 8 } = {}) {
  const url = `${UTR_SEARCH}?query=${encodeURIComponent(name)}&top=${top}`;
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; CourtEdge/1.0)',
  };
  const token = await utrToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res = await fetch(url, { signal, headers });

  // A stale token gets one fresh login and one retry, then we give up loudly.
  if (res.status === 401 && token) {
    cachedJwt = null;
    const fresh = await utrToken();
    if (fresh) headers.Authorization = `Bearer ${fresh}`;
    else delete headers.Authorization;
    res = await fetch(url, { signal, headers });
  }

  if (!res.ok) {
    const e = new Error(`UTR search ${res.status} for "${name}"`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  return (j?.hits ?? []).map(h => h.source).filter(Boolean);
}

/**
 * Resolves one player name to a UTR rating.
 * Returns null when nothing clears the confidence bar — never a guess.
 */
export async function lookupPlayer(name, { gender, minScore = 0.55, signal } = {}) {
  const hits = await searchUtr(name, { signal });
  if (!hits.length) return null;

  const scored = hits
    .filter(h => !gender || !h.gender || h.gender === gender)
    .map(h => ({
      hit: h,
      score: nameScore(name, h.displayName || `${h.firstName ?? ''} ${h.lastName ?? ''}`),
    }))
    .sort((x, y) => y.score - x.score);

  const best = scored[0];
  if (!best || best.score < minScore) return null;

  const h = best.hit;
  const utr = h.singlesUtr != null ? Number(h.singlesUtr) : null;

  return {
    utr_player_id: String(h.id ?? h.profileId ?? ''),
    utr: Number.isFinite(utr) && utr > 0 ? +utr.toFixed(2) : null,
    utr_doubles: h.doublesUtr != null && Number(h.doublesUtr) > 0 ? +Number(h.doublesUtr).toFixed(2) : null,
    utr_status: h.ratingStatusSingles ?? null,
    utr_matched_name: h.displayName ?? null,
    utr_match_score: +best.score.toFixed(3),
    utr_nationality: h.nationality ?? null,
  };
}

/** Serialises lookups with a delay — this is an undocumented public endpoint. */
export async function lookupMany(names, { gender, delayMs = 260, onResult, signal } = {}) {
  const out = [];
  for (const name of names) {
    try {
      const r = await lookupPlayer(name, { gender, signal });
      out.push({ name, ...(r ?? {}), found: !!r });
      onResult?.(name, r);
    } catch (e) {
      out.push({ name, found: false, error: e.message });
      onResult?.(name, null, e);
    }
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
  return out;
}
