import { useEffect, useState } from 'react';
import Landing from './components/landing/Landing';
import Login from './components/Login';
import Dashboard from './components/dashboard/Dashboard';
import { ToastProvider, useToast } from './components/Toasts';
import { buildAlerts, buildMatches, buildTrades } from './lib/data';

function Shell() {
  const toast = useToast();
  const [view, setView] = useState('landing');

  const [matches, setMatches] = useState(buildMatches);
  const [alerts, setAlerts] = useState(() => buildAlerts(matches));
  const [trades, setTrades] = useState(() => buildTrades(matches));

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [view]);

  const doLogin = creds => {
    if (!creds) {
      toast('Missing details', 'Enter your email and password to continue.', 'tdown');
      return;
    }
    setView('dash');
    toast('Welcome back', 'Kalshi WebSocket connected · 184 markets subscribed.', 'tup');
  };

  const logout = () => {
    setView('landing');
    toast('Signed out', 'Your session was closed. The bot keeps scanning server-side.');
  };

  if (view === 'login') {
    return <Login onSubmit={doLogin} onBack={() => setView('landing')} />;
  }
  if (view === 'dash') {
    return (
      <Dashboard
        matches={matches} setMatches={setMatches}
        alerts={alerts} setAlerts={setAlerts}
        trades={trades} setTrades={setTrades}
        onHome={() => setView('landing')} onLogout={logout}
      />
    );
  }
  return <Landing onLogin={() => setView('login')} matches={matches} />;
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
