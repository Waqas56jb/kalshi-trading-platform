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
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
