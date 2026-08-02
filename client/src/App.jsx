import { useCallback, useEffect, useState } from 'react';
import Landing from './components/landing/Landing';
import Login from './components/Login';
import Dashboard from './components/dashboard/Dashboard';
import { ToastProvider, useToast } from './components/Toasts';
import { api } from './lib/api';
import { clearSession, getCachedUser, getToken, onSessionChange, setSession } from './lib/auth';

function Shell() {
  const toast = useToast();
  const [view, setView] = useState('landing');
  const [user, setUser] = useState(getCachedUser);
  const [restoring, setRestoring] = useState(Boolean(getToken() || getCachedUser()));

  /* Revalidate the session on load. The cached user is shown immediately so a
     refresh does not flash the login screen, but the server has the last word:
     a revoked or expired session drops us back to signing in. A cached user
     with no local token is still worth trying — the session may live in the
     httpOnly cookie, which this page cannot see, only use. */
  useEffect(() => {
    if (!getToken() && !getCachedUser()) { setRestoring(false); return; }
    let alive = true;
    api.me()
      .then(r => {
        if (!alive) return;
        setUser(r.user);
        setSession(null, r.user);
        setView('dash');
      })
      .catch(() => { if (alive) { clearSession(); setUser(null); } })
      .finally(() => { if (alive) setRestoring(false); });
    return () => { alive = false; };
  }, []);

  /* api.js clears the session on any 401, so react to that centrally. The
     event matters: a cookie-only session has no local token, so the absence of
     one no longer means signed out. */
  useEffect(() => onSessionChange(event => {
    if (event === 'cleared') {
      setUser(prev => {
        if (prev) {
          setView('login');
          toast('Session ended', 'Please sign in again.', 'tdown');
        }
        return null;
      });
    }
  }), [toast]);

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [view]);

  const doLogin = useCallback(async ({ email, password }) => {
    const r = await api.login(email, password);       // throws -> Login shows the message
    setSession(r.token, r.user);
    setUser(r.user);
    setView('dash');
    toast('Signed in', `Welcome back, ${r.user.name || r.user.email}.`, 'tup');
  }, [toast]);

  const logout = useCallback(() => {
    api.logout().catch(() => {});   // clears the httpOnly cookie server-side
    clearSession();
    setUser(null);
    setView('landing');
    toast('Signed out', 'Your session was closed. The engine keeps scanning server-side.');
  }, [toast]);

  if (restoring) {
    return (
      <div className="min-h-screen grid place-items-center bg-bg">
        <div className="font-mono text-[13px] text-muted animate-blink">Restoring session…</div>
      </div>
    );
  }

  if (view === 'login') {
    return <Login onSubmit={doLogin} onBack={() => setView('landing')} />;
  }
  if (view === 'dash' && user) {
    return <Dashboard user={user} onUserChange={setUser} onHome={() => setView('landing')} onLogout={logout} />;
  }
  return <Landing onLogin={() => setView(user ? 'dash' : 'login')} signedIn={Boolean(user)} />;
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
