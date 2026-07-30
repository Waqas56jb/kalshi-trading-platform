/**
 * Session storage for the desk.
 *
 * The token is a short-lived HS256 JWT issued by the backend. It lives in
 * localStorage because the frontend and API are on different origins, which
 * makes a cookie session awkward; the trade-off is that it is readable by any
 * script on the page, so keep third-party scripts off this app.
 */
const TOKEN_KEY = 'courtedge.token';
const USER_KEY = 'courtedge.user';

const listeners = new Set();
const notify = () => listeners.forEach(fn => fn());

export const onSessionChange = fn => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
};

export const getCachedUser = () => {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

export function setSession(token, user) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch { /* private browsing — session lasts for this page only */ }
  notify();
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch { /* ignore */ }
  notify();
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
