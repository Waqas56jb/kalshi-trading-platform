import { useState } from 'react';
import { Tag } from '../../common';
import { notificationsAllowed, requestNotificationPermission, soundUnlocked, unlockSound, playAlertChime } from '../../../lib/alertSound';
import { api, fmtNum, fmtPct, fmtTime } from '../../../lib/api';
import { PageHead } from '../PageHead';
import { AuthNotice, Empty, ErrorBox, Loading } from '../Notices';

/** Minutes until first serve, or null when unknown. */
function minutesToStart(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

function Countdown({ iso }) {
  const mins = minutesToStart(iso);
  if (mins == null) return <span className="text-muted2">start time unknown</span>;
  if (mins <= 0) return <span className="text-down">already started</span>;
  const h = Math.floor(mins / 60);
  return (
    <span className={mins <= 30 ? 'text-amber' : 'text-muted'}>
      starts in {h ? `${h}h ${mins % 60}m` : `${mins}m`}
    </span>
  );
}

export default function Alerts({ state, onDismiss, onDismissAll, onTrade, health, settings }) {
  const [alertsOn, setAlertsOn] = useState(() => soundUnlocked() && notificationsAllowed());

  /* Browsers block audio until the page has been interacted with, so this has to
     be an explicit click rather than something done on mount. */
  const enableAlerts = async () => {
    const sound = unlockSound();
    const notif = await requestNotificationPermission();
    setAlertsOn(sound || notif);
    if (sound) playAlertChime();
  };
  const alerts = state.data?.alerts ?? [];
  const tradingLive = health?.kalshi?.trading === 'ok';
  const threshold = health?.settings?.min_ev_threshold;

  return (
    <div className="animate-page-in">
      <PageHead
        title="Mispricing alerts"
        sub={settings?.prematch_only !== false
          ? `Pre-match only · at least ${settings?.alert_lead_minutes ?? 10} minutes before first serve`
          : 'Opportunities above your EV threshold — approve to execute'}
        action={
          <div className="flex gap-2.5 items-center">
            {!alertsOn && (
              <button className="btn btn-ghost btn-sm" onClick={enableAlerts}>
                🔔 Enable sound &amp; notifications
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={onDismissAll} disabled={!alerts.length}>
              Dismiss all
            </button>
          </div>
        }
      />

      {state.error && <ErrorBox error={state.error} onRetry={state.refresh} />}
      {!tradingLive && <AuthNotice health={health} />}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4 max-sm:grid-cols-1">
        {alerts.map(a => {
          const bigEdge = (a.edge_cents ?? 0) >= 15;
          return (
            <div
              key={a.id}
              className={`relative overflow-hidden p-5 rounded-card animate-alert-in transition-all duration-300
                          ease-[cubic-bezier(.22,1,.36,1)] hover:-translate-y-1 hover:shadow-[0_16px_40px_rgba(0,0,0,.4)]
                          bg-[linear-gradient(160deg,var(--color-panel2),var(--color-panel))] border
                          ${bigEdge ? 'alert-hot border-down/40' : 'border-line2'}`}
            >
              <div className="flex justify-between items-start mb-3.5 gap-2.5">
                <div className="min-w-0">
                  <div className="font-mono text-[11px] text-muted2 truncate">
                    {a.tournament ?? '—'}{a.round ? ` · ${a.round}` : ''}
                  </div>
                  <div className="font-display font-bold text-[15px] mt-[3px]">{a.player_name}</div>
                  <div className="font-mono text-[11px] text-muted mt-0.5">
                    {a.opponent_name ? `vs ${a.opponent_name}` : a.matchup}
                  </div>
                </div>
                {bigEdge
                  ? <Tag className="bg-down/15 text-down animate-hot-pulse">BIG EDGE</Tag>
                  : <Tag className="bg-amber/15 text-amber">EDGE</Tag>}
              </div>

              <div className="grid grid-cols-3 gap-2.5 mb-3">
                <Num v={a.market_cents != null ? `${a.market_cents}¢` : '—'} l="Ask" />
                <Num v={a.fair_cents != null ? `${a.fair_cents}¢` : '—'} l="Fair" className="text-ace" />
                <Num
                  v={a.edge_cents != null ? `+${a.edge_cents}¢` : '—'}
                  l="Edge"
                  className={bigEdge ? 'text-down' : 'text-up'}
                />
              </div>

              <div className="font-mono text-[11px] text-muted2 mb-3.5 grid grid-cols-2 gap-y-1">
                <span>UTR Δ {a.utr_gap ?? '—'}</span>
                <span className="text-right">EV {fmtPct(a.ev_pct)}</span>
                <span>spread {a.spread_cents != null ? `${a.spread_cents}¢` : '—'}</span>
                <span className="text-right">{fmtNum(a.volume_available)} at ask</span>
              </div>

              <div className="flex gap-2.5">
                <button className="btn btn-danger btn-sm flex-1 justify-center" onClick={() => onDismiss(a.id)}>
                  Dismiss
                </button>
                <button className="btn btn-up btn-sm flex-1 justify-center" onClick={() => onTrade(a)}>
                  Approve trade
                </button>
              </div>

              <div className="font-mono text-[11px] mt-3 flex justify-between gap-2">
                <Countdown iso={a.starts_at ?? a.market_starts_at} />
                <span className="text-muted2">opened {fmtTime(a.created_at)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {!alerts.length && (state.loading
        ? <Loading label="Loading alert queue…" />
        : <Empty icon="🎾" title="No open alerts">
            The engine is scanning every open ITF market. New edges appear here the moment the book
            drifts past your {threshold ? `+${threshold}%` : ''} EV threshold.
          </Empty>)}
    </div>
  );
}

const Num = ({ v, l, className = '' }) => (
  <div className="bg-bg2 border border-line rounded-[10px] p-2.5 text-center">
    <div className={`font-mono font-bold text-base ${className}`}>{v}</div>
    <div className="text-[10px] text-muted2 uppercase tracking-[.08em] mt-0.5">{l}</div>
  </div>
);
