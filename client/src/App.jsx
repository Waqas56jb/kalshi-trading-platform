import { useEffect, useState } from 'react';
import Landing from './components/landing/Landing';
import Login from './components/Login';
import Dashboard from './components/dashboard/Dashboard';
import { ToastProvider, useToast } from './components/Toasts';

function Shell() {
  const toast = useToast();
  const [view, setView] = useState('landing');

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [view]);

  const doLogin = creds => {
    if (!creds) {
      toast('Missing details', 'Enter your email and password to continue.', 'tdown');
      return;
    }
    setView('dash');
  };

  const logout = () => {
    setView('landing');
    toast('Signed out', 'Your session was closed. The engine keeps scanning server-side.');
  };

  if (view === 'login') {
    return <Login onSubmit={doLogin} onBack={() => setView('landing')} />;
  }
  if (view === 'dash') {
    return <Dashboard onHome={() => setView('landing')} onLogout={logout} />;
  }
  return <Landing onLogin={() => setView('login')} />;
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
