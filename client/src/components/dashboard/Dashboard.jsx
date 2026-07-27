import { useState } from 'react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import ConfirmModal from './ConfirmModal';
import Overview from './pages/Overview';
import Markets from './pages/Markets';
import Alerts from './pages/Alerts';
import Trades from './pages/Trades';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
import { useInterval } from '../../hooks/useUi';
import { recalc, ri } from '../../lib/data';
import { useToast } from '../Toasts';

export default function Dashboard({
  matches, setMatches, alerts, setAlerts, trades, setTrades, onHome, onLogout,
}) {
  const toast = useToast();
  const [page, setPage] = useState('overview');
  const [sbOpen, setSbOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [botOn, setBotOn] = useState(true);
  const [latency, setLatency] = useState(42);
  const [flash, setFlash] = useState({});
  const [modalCtx, setModalCtx] = useState(null);

  const goPage = (name, close = true) => {
    if (name !== page) setPage(name);
    if (close) setSbOpen(false);
  };

  /* ---- live market simulation ---- */
  useInterval(() => {
    const i = ri(0, matches.length - 1);
    const dir = Math.random() < 0.5 ? -1 : 1;
    setMatches(prev => prev.map((m, j) =>
      j === i ? recalc({ ...m, mkt: Math.max(8, Math.min(96, m.mkt + dir)) }) : m,
    ));
    setFlash(f => ({ ...f, [i]: { dir: dir > 0 ? 'up' : 'down', seq: (f[i]?.seq ?? 0) + 1 } }));
    setLatency(ri(31, 88));
  }, 1500);

  /* ---- occasionally spawn a new alert ---- */
  useInterval(() => {
    if (alerts.length >= 6 || Math.random() < 0.5) return;
    const pool = matches.filter(m => m.hot && !alerts.find(a => a.p === m.p));
    if (!pool.length) return;
    const m = pool[ri(0, pool.length - 1)];
    setAlerts(v => [{ ...m, id: Date.now(), ago: 'just now' }, ...v]);
    toast('New mispricing 🔔', `${m.p} — market ${m.mkt}¢ vs fair ${m.fair}¢ (+${m.ev}% EV).`);
  }, 12000);

  const dismissAlert = id => {
    setAlerts(v => v.filter(a => a.id !== id));
    toast('Alert dismissed', 'Removed from the queue. The engine keeps watching this market.');
  };
  const clearAlerts = () => {
    setAlerts([]);
    toast('Queue cleared', 'All alerts dismissed.');
  };

  const confirmTrade = a => {
    setModalCtx(null);
    setAlerts(v => v.filter(x => x.id !== a.id));
    setTrades(v => [
      { time: 'Just now', match: a.p, side: 'YES', entry: a.mkt, fair: a.fair, size: 250, ev: a.ev, res: 'open', pnl: 0 },
      ...v,
    ]);
    toast('Order filled ⚡', `Swept ${a.vol.toLocaleString()} contracts on ${a.p} @ ${a.mkt}¢ (fair ${a.fair}¢).`, 'tup');
  };

  const toggleBot = () => {
    const on = !botOn;
    setBotOn(on);
    toast(on ? 'Bot resumed' : 'Bot paused',
      on ? 'Scanning all ITF markets for edges.' : 'Execution paused. You will still receive alerts.');
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar
        open={sbOpen} page={page} onPage={goPage} onClose={() => setSbOpen(false)}
        onHome={onHome} onLogout={onLogout}
        alertCount={alerts.length} botOn={botOn} onToggleBot={toggleBot}
      />

      <div className="flex-1 ml-[248px] flex flex-col min-w-0 max-[980px]:ml-0">
        <Topbar
          query={query} onQuery={setQuery} latency={latency}
          onBurger={() => setSbOpen(v => !v)}
          onAlerts={() => goPage('alerts')}
        />

        <div className="p-[clamp(16px,2.5vw,30px)] max-w-[1440px] w-full mx-auto">
          {page === 'overview' && (
            <Overview matches={matches} alerts={alerts} onPage={goPage} onTrade={setModalCtx} />
          )}
          {page === 'markets' && (
            <Markets matches={matches} query={query} flash={flash} onTrade={setModalCtx} />
          )}
          {page === 'alerts' && (
            <Alerts alerts={alerts} onDismiss={dismissAlert} onClear={clearAlerts} onTrade={setModalCtx} />
          )}
          {page === 'trades' && <Trades trades={trades} />}
          {page === 'analytics' && <Analytics />}
          {page === 'settings' && (
            <Settings onSave={() => toast('Settings saved', 'All changes applied to the live engine.', 'tup')} />
          )}
        </div>
      </div>

      <ConfirmModal ctx={modalCtx} onClose={() => setModalCtx(null)} onConfirm={confirmTrade} />
    </div>
  );
}
