import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import ConfirmModal from './ConfirmModal';
import Overview from './pages/Overview';
import Markets from './pages/Markets';
import Alerts from './pages/Alerts';
import Trades from './pages/Trades';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
import { usePoll } from '../../hooks/useApi';
import { useAlertNotifier } from '../../hooks/useAlertNotifier';
import { api } from '../../lib/api';
import { useToast } from '../Toasts';

export default function Dashboard({ user, onUserChange, onHome, onLogout }) {
  const toast = useToast();
  const [page, setPage] = useState('overview');
  const [sbOpen, setSbOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [modalAlert, setModalAlert] = useState(null);
  const [alertSide, setAlertSide] = useState('all');
  const [executing, setExecuting] = useState(false);

  const health = usePoll(() => api.health(), { intervalMs: 15000 });
  const alerts = usePoll(() => api.alerts('open', alertSide === 'all' ? undefined : alertSide),
    { intervalMs: 10000, deps: [alertSide] });
  const settings = usePoll(() => api.settings(), {});

  /* Drives the sync from the browser, on its own timer, results ignored. The
     server holds the lock and skips when the data is already fresh, so several
     open tabs cost nothing. This is what keeps the desk current without a manual
     button and without a cron tier that only fires once a day. */
  const ticking = useRef(false);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped || ticking.current) return;
      ticking.current = true;
      try { await api.tick(); } catch { /* a failed tick must not disturb the UI */ }
      finally {
        ticking.current = false;
        if (!stopped) {
          await Promise.all([
            health.refresh({ quiet: true }),
            alerts.refresh({ quiet: true }),
          ]).catch(() => {});
        }
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => { stopped = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goPage = (name, close = true) => {
    if (name !== page) setPage(name);
    if (close) setSbOpen(false);
  };

  const openAlerts = alerts.data?.alerts ?? [];
  const h = health.data ?? null;
  const cfg = settings.data?.settings ?? null;
  const botEnabled = cfg?.bot_enabled ?? true;

  /* Chime + desktop notification when a genuinely new alert lands. */
  useAlertNotifier(openAlerts, {
    enabled: cfg?.sound_enabled !== false,
    onNotify: fresh => {
      const a = fresh[0];
      toast(
        fresh.length === 1 ? 'New mispricing 🔔' : `${fresh.length} new mispricings 🔔`,
        a ? `${a.player_name} — ${a.market_cents}¢ vs fair ${a.fair_cents}¢`
          : 'Check the alert queue.',
      );
    },
  });

  const toggleBot = async () => {
    const next = !botEnabled;
    try {
      await api.saveSettings({ bot_enabled: next });
      await settings.refresh({ quiet: true });
      toast(next ? 'Engine resumed' : 'Engine paused',
        next ? 'Scanning all configured ITF series for edges.' : 'Scanning paused. Existing alerts remain.');
    } catch (e) {
      toast('Could not update', e.message, 'tdown');
    }
  };

  const dismissAlert = async id => {
    try {
      await api.dismissAlert(id);
      await alerts.refresh({ quiet: true });
      toast('Alert dismissed', 'Removed from the queue. The engine keeps watching this market.');
    } catch (e) {
      toast('Could not dismiss', e.message, 'tdown');
    }
  };

  const dismissAll = async () => {
    try {
      const r = await api.dismissAllAlerts();
      await alerts.refresh({ quiet: true });
      toast('Queue cleared', `${r.dismissed} alert${r.dismissed === 1 ? '' : 's'} dismissed.`);
    } catch (e) {
      toast('Could not clear', e.message, 'tdown');
    }
  };

  /** Sends the real order. Surfaces the exchange's own reason on refusal. */
  const confirmExecute = useCallback(async alert => {
    setExecuting(true);
    try {
      const r = await api.executeAlert(alert.id);
      setModalAlert(null);
      await alerts.refresh({ quiet: true });
      toast(r.paper ? 'Paper position opened' : 'Order filled ⚡',
        r.message ?? `${r.trade.size_contracts} contracts on ${r.trade.player_name} @ ${r.trade.entry_cents}¢.`,
        'tup');
    } catch (e) {
      setModalAlert(null);
      const detail = e.body?.detail ?? e.message;
      toast('Order not placed', detail, 'tdown');
      // a failed attempt is still recorded server-side — refresh so it shows
      await alerts.refresh({ quiet: true });
    } finally {
      setExecuting(false);
    }
  }, [alerts, toast]);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        open={sbOpen} page={page} onPage={goPage} onClose={() => setSbOpen(false)}
        onHome={onHome} onLogout={onLogout}
        alertCount={openAlerts.length}
        botOn={botEnabled} onToggleBot={toggleBot}
        health={h} user={user}
      />

      <div className="flex-1 ml-[248px] flex flex-col min-w-0 max-[980px]:ml-0">
        <Topbar
          query={query} onQuery={setQuery} health={h} user={user}
          alertCount={openAlerts.length}
          onBurger={() => setSbOpen(v => !v)}
          onAlerts={() => goPage('alerts')}
          onAccount={() => goPage('settings')}
        />

        <div className="p-[clamp(16px,2.5vw,30px)] max-w-[1440px] w-full mx-auto">
          {page === 'overview' && (
            <Overview
              alerts={openAlerts} health={h} user={user}
              settings={cfg}
              onPage={goPage} onTrade={setModalAlert}
              onRefresh={() => alerts.refresh({ quiet: true })}
            />
          )}
          {page === 'markets' && <Markets search={query} onTrade={setModalAlert} />}
          {page === 'alerts' && (
            <Alerts
              state={alerts} side={alertSide} onSide={setAlertSide}
              onDismiss={dismissAlert} onDismissAll={dismissAll}
              onTrade={setModalAlert} health={h} settings={cfg}
            />
          )}
          {page === 'trades' && <Trades user={user} />}
          {page === 'analytics' && <Analytics />}
          {page === 'settings' && (
            <Settings state={settings} user={user} onUserChange={onUserChange} />
          )}
        </div>
      </div>

      <ConfirmModal
        alert={modalAlert} busy={executing} health={h}
        paper={cfg?.paper_trading ?? true}
        onClose={() => setModalAlert(null)} onConfirm={confirmExecute}
      />
    </div>
  );
}
