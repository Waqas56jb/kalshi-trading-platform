import { useState } from 'react';
import { ChipBtn, Panel, StatusTag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { useCanvas } from '../../../hooks/useUi';
import { api, fmtCountdown, fmtMatchTime, fmtNum, fmtPct, fmtUsd } from '../../../lib/api';
import { drawLineArea } from '../../../lib/charts';
import { useToast } from '../../Toasts';
import { PageHead } from '../PageHead';
import { AuthNotice, ErrorBox, PaperNotice } from '../Notices';

export default function Overview({ alerts, health, settings, onPage, onTrade, onRefresh, user }) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const { data, error, loading, refresh } = usePoll(() => api.overview(days), {
    intervalMs: 15000, deps: [days],
  });
  const hot = usePoll(() => api.markets({ filter: 'mispriced', limit: 5 }), { intervalMs: 15000 });

  const s = data?.stats ?? null;
  const desk = s?.desk ?? null;
  const pnl = data?.pnl ?? [];
  const tradingLive = health?.kalshi?.trading === 'ok';
  const syncAge = data?.sync?.finished_at
    ? Math.round((Date.now() - new Date(data.sync.finished_at).getTime()) / 1000) : null;
  const paper = settings?.paper_trading ?? true;
  const balanceAgeMins = s?.balance_at
    ? Math.round((Date.now() - new Date(s.balance_at).getTime()) / 60000) : null;

  const pnlRef = useCanvas(c => {
    drawLineArea(c, pnl.map(p => p.cumulative), '#34D399', {
      fillAlpha: 0.22, emptyLabel: 'No settled positions yet',
    });
  }, [pnl.length, days, pnl[pnl.length - 1]?.cumulative]);

  return (
    <div className="animate-page-in">
      <PageHead
        title="Overview"
        sub={data?.sync?.finished_at
          ? `Desk is live · syncing automatically · updated ${syncAge == null ? 'just now'
              : syncAge < 60 ? `${syncAge}s ago` : `${Math.round(syncAge / 60)}m ago`}`
          : 'Connecting to the desk…'}
        action={
          <button className="btn btn-ace btn-sm" onClick={() => onPage('alerts')}>
            {alerts.length ? `Review ${alerts.length} open alert${alerts.length === 1 ? '' : 's'}` : 'No open alerts'}
          </button>
        }
      />

      {error && <ErrorBox error={error} onRetry={refresh} />}
      {paper && <PaperNotice kalshiOk={tradingLive} />}
      {!tradingLive && !paper && <AuthNotice health={health} />}

      {/* live desk metrics — these work from the first sync, before any trade */}
      <div className="grid grid-cols-4 gap-4 mb-4 max-[1180px]:grid-cols-2 max-[420px]:grid-cols-1">
        <StatCard
          label="Markets priced"
          value={s ? `${fmtNum(s.markets.priced)}` : '—'}
          delta={s ? `of ${fmtNum(s.markets.total)} open ITF markets` : '—'}
          deltaClass="text-muted"
        />
        <StatCard
          label="Actionable edges"
          value={desk ? fmtNum(desk.actionable) : '—'}
          valueClass={desk?.actionable ? 'text-ace' : ''}
          delta={desk?.avg_actionable_ev ? `avg ${fmtPct(desk.avg_actionable_ev)} EV` : 'none above threshold'}
          deltaClass={desk?.actionable ? 'text-up' : 'text-muted2'}
        />
        <StatCard
          label="Best edge"
          value={desk?.best_edge_cents ? `+${desk.best_edge_cents}¢` : '—'}
          valueClass={desk?.best_edge_cents ? 'text-ace' : ''}
          delta={desk?.edge_cents_available ? `${fmtNum(desk.edge_cents_available)}¢ total available` : '—'}
          deltaClass="text-muted"
        />
        <StatCard
          label="Open alerts"
          value={s ? fmtNum(s.open_alerts) : '—'}
          valueClass={s?.open_alerts ? 'text-down' : ''}
          delta={s?.open_alerts ? 'awaiting your approval' : 'queue is clear'}
          deltaClass={s?.open_alerts ? 'text-down' : 'text-muted2'}
        />
      </div>

      {/* position + P&L metrics — need trades before they mean anything */}
      <div className="grid grid-cols-4 gap-4 mb-5.5 max-[1180px]:grid-cols-2 max-[420px]:grid-cols-1">
        <StatCard
          label={paper ? 'Desk paper P&L (today)' : "Desk realised P&L (today)"}
          value={s ? fmtUsd(s.pnl_today, { sign: true }) : '—'}
          valueClass={s?.pnl_today > 0 ? 'text-up' : s?.pnl_today < 0 ? 'text-down' : ''}
          delta={s ? `${fmtUsd(s.pnl_7d, { sign: true })} over 7 days` : '—'}
          deltaClass={s?.pnl_7d >= 0 ? 'text-up' : 'text-down'}
          badge={paper ? 'PAPER' : null}
        />
        <StatCard
          label="Kalshi positions"
          value={s?.kalshi_open_positions != null ? fmtNum(s.kalshi_open_positions) : '—'}
          delta={s?.kalshi_exposure_cents != null
            ? `${fmtUsd(s.kalshi_exposure_cents / 100)} exposure`
            : 'needs a portfolio sync'}
          deltaClass="text-muted"
        />
        <StatCard
          label="Kalshi realised P&L"
          value={s?.kalshi_realised_cents != null ? fmtUsd(s.kalshi_realised_cents / 100, { sign: true }) : '—'}
          valueClass={s?.kalshi_realised_cents > 0 ? 'text-up' : s?.kalshi_realised_cents < 0 ? 'text-down' : ''}
          delta="whole account, from Kalshi"
          deltaClass="text-muted"
        />
        <StatCard
          label="Kalshi balance"
          value={s?.balance_cents != null ? fmtUsd(s.balance_cents / 100) : '—'}
          /* Never call this "live": it is the last snapshot, refreshed on sync.
             It once sat six hours stale showing $2,979 against a real $39. */
          delta={s?.balance_cents == null ? 'needs working API credentials'
            : balanceAgeMins == null ? 'from Kalshi'
            : balanceAgeMins < 2 ? 'just now'
            : balanceAgeMins < 60 ? `as of ${balanceAgeMins}m ago`
            : `as of ${Math.round(balanceAgeMins / 60)}h ago — run a sync`}
          deltaClass={s?.balance_cents == null ? 'text-muted2'
            : balanceAgeMins != null && balanceAgeMins > 60 ? 'text-amber' : 'text-muted'}
        />
      </div>

      <div className="grid grid-cols-[2fr_1fr] gap-4 max-[980px]:grid-cols-1">
        <Panel
          title={paper ? 'Cumulative paper P&L' : 'Cumulative realised P&L'}
          tools={[7, 30, 90].map(d => (
            <ChipBtn key={d} on={days === d} onClick={() => setDays(d)}>{d}D</ChipBtn>
          ))}
        >
          <canvas ref={pnlRef} height="240" />
        </Panel>

        <Panel
          title="Latest alerts"
          tools={<ChipBtn onClick={() => onPage('alerts')}>View all</ChipBtn>}
          bodyClass="py-2.5 px-3.5"
        >
          {alerts.length ? alerts.slice(0, 4).map(a => (
            <div
              key={a.id}
              onClick={() => onTrade(a)}
              className="flex justify-between items-center gap-3 p-2.5 rounded-[10px] text-[13px]
                         cursor-pointer transition-colors duration-300 hover:bg-white/3"
            >
              <span className="text-text font-semibold">
                {a.player_name}<br />
                <span className="text-muted2 text-[11px] font-mono">{a.tournament ?? a.matchup}</span>
              </span>
              <span className="bg-up/15 text-up py-[3px] px-2.5 rounded-full text-xs font-bold font-mono whitespace-nowrap">
                {a.edge_cents != null ? `+${a.edge_cents}¢` : fmtPct(a.ev_pct)}
              </span>
            </div>
          )) : (
            <div className="text-center py-8 text-muted text-[13px]">
              {loading ? 'Loading…' : 'No open alerts — the desk is scanning.'}
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Hottest edges right now"
        tools={<ChipBtn onClick={() => onPage('markets')}>All markets →</ChipBtn>}
        bodyClass=""
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr><th>Match</th><th>Starts</th><th>UTR Δ</th><th>Fair</th><th>Ask</th><th>Edge</th><th>EV</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {(hot.data?.markets ?? []).map(m => {
                const alert = alerts.find(a => a.ticker === m.ticker);
                return (
                  <tr key={m.ticker}>
                    <td>
                      <div className="font-semibold text-[13.5px]">{m.player_name}</div>
                      <div className="text-[11.5px] text-muted2 font-mono mt-0.5">{m.tournament ?? m.matchup}</div>
                    </td>
                    <td className="font-mono whitespace-nowrap">
                      {m.occurrence_datetime ? (
                        <span title={new Date(m.occurrence_datetime).toString()}>
                          <span className="text-text">{fmtMatchTime(m.occurrence_datetime)}</span>
                          <span className="block text-[10.5px] text-muted">{fmtCountdown(m.occurrence_datetime)}</span>
                        </span>
                      ) : <span className="text-muted2">—</span>}
                    </td>
                    <td className="font-mono font-semibold text-ace">{m.utr_gap != null ? `Δ ${m.utr_gap}` : '—'}</td>
                    <td className="font-mono font-semibold">{m.fair_cents != null ? `${m.fair_cents}¢` : '—'}</td>
                    <td className="font-mono font-semibold">{m.yes_ask_cents != null ? `${m.yes_ask_cents}¢` : '—'}</td>
                    <td className="font-mono font-bold text-ace">{m.edge_cents != null ? `+${m.edge_cents}¢` : '—'}</td>
                    <td className="font-mono font-semibold text-up">{fmtPct(m.ev_pct)}</td>
                    <td><StatusTag m={m} /></td>
                    <td>
                      <button
                        className="btn btn-up btn-sm"
                        onClick={() => onTrade(alert)}
                        disabled={!alert}
                        title={alert ? 'Review and execute' : 'No open alert for this market'}
                      >
                        Trade
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!(hot.data?.markets ?? []).length && (
                <tr><td colSpan={9} className="text-center text-muted py-8">
                  {hot.loading ? 'Loading markets…' : 'No mispriced markets above your EV threshold right now.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function StatCard({ label, value, valueClass = '', delta, deltaClass = 'text-up', badge }) {
  return (
    <div className="bg-[linear-gradient(160deg,var(--color-panel2),var(--color-panel))] border border-line
                    rounded-card p-5 relative overflow-hidden transition-all duration-300
                    ease-[cubic-bezier(.22,1,.36,1)] hover:-translate-y-1 hover:border-line2">
      <div className="text-xs text-muted tracking-[.04em] uppercase font-semibold flex justify-between items-center gap-2">
        <span>{label}</span>
        {badge && (
          <span className="font-mono text-[9.5px] tracking-[.1em] bg-amber/15 text-amber px-1.5 py-0.5 rounded shrink-0">
            {badge}
          </span>
        )}
      </div>
      <div className={`font-mono text-[27px] font-bold mt-2 tracking-[-.01em] ${valueClass}`}>{value}</div>
      <div className={`font-mono text-xs mt-[5px] inline-flex gap-[5px] items-center ${deltaClass}`}>{delta}</div>
    </div>
  );
}
