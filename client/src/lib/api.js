import { clearSession, getToken } from './auth';

/**
 * Backend client. Every number rendered in this app comes through here —
 * there is no local sample data anywhere in the frontend.
 */
/**
 * Where the backend lives.
 *
 * VITE_API_URL is baked in at build time. The frontend and backend are deployed
 * as two separate Vercel projects, so this must be set on the frontend project
 * or requests fall back to this origin — where no /api exists — and 404.
 */
const BASE = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:8787' : ''))
  .replace(/\/$/, '');

export const API_BASE_CONFIGURED = Boolean(import.meta.env.VITE_API_URL);

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(
      API_BASE_CONFIGURED
        ? `Cannot reach the API at ${BASE}. Is the backend running and is this origin allowed by CORS?`
        : 'VITE_API_URL is not set, so there is no backend to call. Set it on this '
          + 'deployment to your backend URL and redeploy.',
      0, null);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }

  if (!res.ok) {
    /* An expired or revoked token must end the session immediately rather than
       leaving the dashboard polling a wall of 401s. The login endpoint is exempt:
       a wrong password there is a form error, not a dead session. */
    if (res.status === 401 && !path.startsWith('/api/auth/login')) clearSession();
    throw new ApiError(json?.message || json?.error || `${res.status} ${res.statusText}`, res.status, json);
  }
  return json;
}

const get = (p, q) => {
  const qs = q
    ? '?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null)).toString()
    : '';
  return call('GET', p + qs);
};

export const api = {
  base: BASE,
  health: () => get('/api/health'),

  /* ---- auth ---- */
  login: (email, password) => call('POST', '/api/auth/login', { email, password }),
  me: () => get('/api/auth/me'),
  updateMe: patch => call('PATCH', '/api/auth/me', patch),

  /* ---- accounts (admin) ---- */
  users: () => get('/api/users'),
  createUser: body => call('POST', '/api/users', body),
  updateUser: (id, patch) => call('PATCH', `/api/users/${id}`, patch),
  deleteUser: id => call('DELETE', `/api/users/${id}`),

  markets: q => get('/api/markets', q),
  priceHistory: (ticker, limit) => get(`/api/markets/${encodeURIComponent(ticker)}/history`, { limit }),

  alerts: status => get('/api/alerts', { status }),
  dismissAlert: id => call('POST', `/api/alerts/${id}/dismiss`),
  dismissAllAlerts: () => call('POST', '/api/alerts/dismiss-all'),
  executeAlert: (id, contracts) => call('POST', `/api/alerts/${id}/execute`, contracts ? { contracts } : {}),

  trades: filter => get('/api/trades', { filter }),

  overview: days => get('/api/overview', { days }),
  analytics: days => get('/api/analytics', { days }),
  pnl: days => get('/api/pnl', { days }),

  settings: () => get('/api/settings'),
  saveSettings: patch => call('PATCH', '/api/settings', patch),

  sync: () => call('POST', '/api/sync'),
  reconcileTrades: () => call('POST', '/api/trades/reconcile'),
};

export { ApiError };

/* ---------------------------------------------------------------- helpers */

export const centsToPrice = c => (c == null ? null : `${c}¢`);

export const fmtUsd = (n, { sign = false } = {}) => {
  if (n == null) return '—';
  const v = Number(n);
  const s = sign && v > 0 ? '+' : v < 0 ? '-' : '';
  return `${s}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
};

export const fmtPct = (n, { sign = true } = {}) => {
  if (n == null) return '—';
  const v = Number(n);
  return `${sign && v > 0 ? '+' : ''}${v.toFixed(1)}%`;
};

export const fmtNum = n => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));

export const fmtTime = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: DESK_TZ,
  });
};

/**
 * Every timestamp on the desk renders in one fixed zone, not the viewer's.
 *
 * The trader compares against Sofascore and the ITF site in Pacific, so showing
 * the browser's zone made the same match appear at two different times.
 */
export const DESK_TZ = 'America/Los_Angeles';

const clock = d => d.toLocaleTimeString('en-US',
  { hour: '2-digit', minute: '2-digit', timeZone: DESK_TZ });

/** Calendar day in the desk's zone, for "today / tomorrow" comparisons. */
const deskDay = d => d.toLocaleDateString('en-CA', { timeZone: DESK_TZ });

/**
 * Scheduled start, in the viewer's own timezone, with the day made explicit so
 * "14:00" is never ambiguous about which day it means.
 *
 * Kalshi publishes a half-hour scheduling slot rather than a first-serve time, so
 * callers should present this as scheduled rather than exact.
 */
export const fmtMatchTime = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';

  const dayDiff = Math.round(
    (Date.parse(deskDay(d)) - Date.parse(deskDay(new Date()))) / 86_400_000);

  if (dayDiff === 0) return clock(d);
  if (dayDiff === 1) return `Tomorrow ${clock(d)}`;
  if (dayDiff === -1) return `Yesterday ${clock(d)}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: DESK_TZ })} ${clock(d)}`;
};

/** Short zone label, e.g. "PDT". */
export const deskZoneLabel = () => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: DESK_TZ, timeZoneName: 'short' })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? 'PT';
  } catch { return 'PT'; }
};

/** Compact "in 3h 21m" / "started" for the same timestamp. */
export const fmtCountdown = iso => {
  if (!iso) return null;
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (Number.isNaN(mins)) return null;
  if (mins <= 0) return 'started';
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `in ${h}h ${mins % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
};

/** Retained name; always the desk zone now, never the viewer's. */
export const localZone = () => `${DESK_TZ.split('/')[1].replace('_', ' ')} (${deskZoneLabel()})`;
