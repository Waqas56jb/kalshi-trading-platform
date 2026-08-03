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

/* Surnames that collide constantly on ITF (Max: Thamchaiwat vs the wrong Wang).
   Surname-only overlap must not clear the confidence bar — given name required. */
export const COMMON_SURNAMES = new Set([
  'wang', 'li', 'lee', 'kim', 'chen', 'zhang', 'liu', 'yang', 'huang', 'zhao',
  'wu', 'zhou', 'xu', 'sun', 'ma', 'zhu', 'hu', 'guo', 'he', 'lin', 'gao',
  'luo', 'zheng', 'liang', 'xie', 'song', 'tang', 'deng', 'han', 'cao', 'peng',
  'xiao', 'park', 'choi', 'jung', 'cho', 'kang', 'yoon', 'jang', 'lim', 'shin',
  'oh', 'seo', 'singh', 'kumar', 'patel', 'nguyen', 'tran', 'le', 'pham', 'hoang',
  'vo', 'smith', 'jones', 'brown', 'garcia', 'martin', 'lopez',
  /* Slavic / ITF collisions — Max: wrong Kuznetsova vs Rothensteiner. */
  'kuznetsova', 'kuznetcova', 'ivanova', 'petrova', 'smirnova', 'popova',
  'sokolova', 'novikova', 'morozova', 'volkova', 'pavkova', 'novakova',
]);

/**
 * Given-name agreement, including Kalshi initials ("J. Wang" → "Jiaqi Wang").
 * Exact token match OR single-letter initial vs first letter of a given name.
 */
function givenNameOverlap(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const aGiven = a.slice(0, -1);
  const bGiven = b.slice(0, -1);
  let n = 0;
  for (const t of aGiven) {
    if (bGiven.includes(t)) { n += 1; continue; }
    if (t.length === 1 && bGiven.some(u => u.startsWith(t))) n += 1;
  }
  for (const t of bGiven) {
    if (t.length === 1 && aGiven.some(u => u.startsWith(t))) n += 1;
  }
  return n;
}

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
  const aSur = a[a.length - 1];
  const bSur = b[b.length - 1];
  const surnameOk = setB.has(aSur) || new Set(a).has(bSur);
  if (!surnameOk) return base * 0.35;

  // exact match after normalisation
  if (normaliseName(kalshiName) === normaliseName(utrName)) return 1;

  /* Common surname (Wang, Li, Kim…): given-name overlap is mandatory. Otherwise
     "Y. Wang" silently attaches to a different Rated Wang and poisons fair value. */
  const commonSur = COMMON_SURNAMES.has(aSur) || COMMON_SURNAMES.has(bSur);
  if (commonSur) {
    const given = givenNameOverlap(a, b);
    if (!given) return Math.min(base, 0.45); // below lookup minScore — refuse
    /* Initial matches ("J Wang"→"Jiaqi Wang") need to clear minScore 0.72. */
    return Math.min(1, Math.max(base + 0.25, 0.78));
  }

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
 *
 * Duplicate surnames (two Daria Kuznetsovas, etc.) are the main failure mode:
 * we prefer Rated profiles, require a clear gap over the second-best hit, and
 * use a higher default score bar so a weak surname overlap cannot win.
 */
export async function lookupPlayer(name, {
  gender, minScore = 0.72, minMargin = 0.12, preferRated = true, signal,
} = {}) {
  const sur = tokens(name).slice(-1)[0];
  const top = COMMON_SURNAMES.has(sur) ? 20 : 8;
  const hits = await searchUtr(name, { signal, top });
  if (!hits.length) return null;

  const scored = hits
    .filter(h => !gender || !h.gender || h.gender === gender)
    .map(h => {
      const display = h.displayName || `${h.firstName ?? ''} ${h.lastName ?? ''}`;
      return {
        hit: h,
        display,
        score: nameScore(name, display),
        rated: (h.ratingStatusSingles ?? '') === 'Rated',
        given: givenNameOverlap(tokens(name), tokens(display)),
      };
    })
    .sort((x, y) => {
      // Never let "Rated" override a better given-name match on Wang/Li/Kim…
      if (preferRated && x.rated !== y.rated && Math.abs(x.score - y.score) < 0.20
        && x.given === y.given) {
        return x.rated ? -1 : 1;
      }
      if (x.given !== y.given) return y.given - x.given;
      return y.score - x.score;
    });

  const best = scored[0];
  if (!best || best.score < minScore) return null;

  // Ambiguous: two strong hits with nearly the same name score — refuse rather
  // than guess (Max's Kuznetsova / wrong Wang cases).
  // Common surnames: never let "Rated" break a tie between two Daria Kuznetsovas
  // — that is exactly how the wrong profile won before.
  const second = scored[1];
  const commonSur = COMMON_SURNAMES.has(sur);
  if (second && (best.score - second.score) < minMargin && best.given === second.given) {
    if (commonSur || !preferRated || best.rated === second.rated) return null;
  }

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
