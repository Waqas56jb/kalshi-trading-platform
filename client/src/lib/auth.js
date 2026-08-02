/**
 * Session storage for the desk.
 *
 * The real session is an httpOnly cookie set by the backend at login, which no
 * script on this page can read. The short-lived HS256 JWT the login response
 * also returns is kept in memory, with sessionStorage as the reload fallback
 * for browsers (Safari) that refuse a cookie set by a different site — the
 * frontend and API are separate Vercel projects. Nothing secret touches
 * localStorage any more; only the display-user cache lives there, so a
 * returning visitor does not get a login-screen flash while the cookie is
 * revalidated.
 */
const TOKEN_KEY = 'courtedge.token';
const USER_KEY = 'courtedge.user';

let memoryToken = null;

/* One-time migration: sessions issued before the cookie change kept the token
   in localStorage. Move it out so it stops being readable, without logging
   anyone out on deploy. */
try {
  const legacy = localStorage.getItem(TOKEN_KEY);
  if (legacy) {
    sessionStorage.setItem(TOKEN_KEY, legacy);
    localStorage.removeItem(TOKEN_KEY);
  }
} catch { /* storage unavailable — cookie or in-memory session only */ }

const listeners = new Set();
/* 'updated' on login/refresh, 'cleared' on logout or a dead session. The event
   matters because a cookie-only session has no local token, so "is there a
   token?" no longer answers "are we signed in?". */
const notify = event => listeners.forEach(fn => fn(event));

export const onSessionChange = fn => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getToken = () => {
  if (memoryToken) return memoryToken;
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
};

export const getCachedUser = () => {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

export function setSession(token, user) {
  if (token) {
    memoryToken = token;
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* in-memory only */ }
  }
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch { /* private browsing — session lasts for this page only */ }
  notify('updated');
}

export function clearSession() {
  memoryToken = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
  notify('cleared');
}

/** Initials for the avatar, from the name if present, else the email. */
export function initialsFor(user) {
  if (!user) return '··';
  const src = (user.name ?? '').trim() || (user.email ?? '');
  const words = src.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '··';
  const letters = words.length === 1
    ? words[0].slice(0, 2)
    : words[0][0] + words[words.length - 1][0];
  return letters.toUpperCase();
}
