import { useEffect, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import Overview from './pages/Overview';
import Markets from './pages/Markets';
import Trades from './pages/Trades';
import Analytics from './pages/Analytics';
import Shadow from './pages/Shadow';
import Model from './pages/Model';
import Settings from './pages/Settings';
import { usePoll } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useToast } from '../Toasts';

export default function Dashboard({ user, onUserChange, onHome, onLogout }) {
  const toast = useToast();
  const [page, setPage] = useState('overview');
  const [sbOpen, setSbOpen] = useState(false);
  const [query, setQuery] = useState('');

  const health = usePoll(() => api.health(), { intervalMs: 15000 });
  const settings = usePoll(() => api.settings(), {});

  /* Drives the sync from the browser, on its own timer, results ignored. The
     server holds the lock and skips when the data is already fresh, so several
     open tabs cost nothing. Phone browsers pause timers when the screen locks —
     so we also tick on visibilitychange when the tab comes back. */
  const ticking = useRef(false);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped || ticking.current) return;
      ticking.current = true;
      try { await api.tick(); } catch { /* a failed tick must not disturb the UI */ }
      finally {
        ticking.current = false;
        if (!stopped) await health.refresh({ quiet: true }).catch(() => {});
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goPage = (name, close = true) => {
    if (name !== page) setPage(name);
    if (close) setSbOpen(false);
  };

  const h = health.data ?? null;
  const cfg = settings.data?.settings ?? null;
  const botEnabled = cfg?.bot_enabled ?? true;

  const toggleBot = async () => {
    const next = !botEnabled;
    try {
      await api.saveSettings({ bot_enabled: next });
      await settings.refresh({ quiet: true });
      toast(next ? 'Engine resumed' : 'Engine paused',
        next ? 'Shadow desk scanning and placing its own trades.' : 'Scanning paused.');
    } catch (e) {
      toast('Could not update', e.message, 'tdown');
    }
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar
        open={sbOpen} page={page} onPage={goPage} onClose={() => setSbOpen(false)}
        onHome={onHome} onLogout={onLogout}
        botOn={botEnabled} onToggleBot={toggleBot}
        health={h} user={user}
      />

      <div className="flex-1 ml-[248px] flex flex-col min-w-0 max-[980px]:ml-0">
        <Topbar
          query={query} onQuery={setQuery} health={h} user={user}
          onBurger={() => setSbOpen(v => !v)}
          onAccount={() => goPage('settings')}
        />

        <div className="p-[clamp(16px,2.5vw,30px)] max-w-[1440px] w-full mx-auto">
          {page === 'overview' && (
            <Overview health={h} user={user} settings={cfg} onPage={goPage} />
          )}
          {page === 'markets' && <Markets search={query} />}
          {page === 'trades' && <Trades user={user} />}
          {page === 'analytics' && <Analytics />}
          {page === 'shadow' && <Shadow />}
          {page === 'model' && <Model />}
          {page === 'settings' && (
            <Settings state={settings} user={user} onUserChange={onUserChange} />
          )}
        </div>
      </div>
    </div>
  );
}
