/**
 * Backend client. Every number rendered in this app comes through here —
 * there is no local sample data anywhere in the frontend.
 */
/**
 * In production the API is served from /api on the same origin, so the base is
 * empty and every path is relative. Locally the backend runs on its own port,
 * which client/.env supplies via VITE_API_URL.
 */
const BASE = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:8787' : ''))
  .replace(/\/$/, '');

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(
      `Cannot reach the API at ${BASE || window.location.origin}. Is the server running?`, 0, null);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }

  if (!res.ok) {
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
