import { useState } from 'react';
import { ChipBtn, Panel, StatusTag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { useCanvas } from '../../../hooks/useUi';
import { api, fmtCountdown, fmtMatchTime, fmtNum, fmtPct, fmtUsd } from '../../../lib/api';
import { drawLineArea } from '../../../lib/charts';
import { PageHead } from '../PageHead';
import { AuthNotice, ErrorBox, PaperNotice } from '../Notices';

export default function Overview({ health, settings, onPage }) {
  const [days, setDays] = useState(30);
  const { data, error, loading, refresh } = usePoll(() => api.overview(days), {
    intervalMs: 15000, deps: [days],
  });
  const hot = usePoll(() => api.markets({ filter: 'mispriced', limit: 5 }), { intervalMs: 15000 });
  const shadow = usePoll(() => api.shadowSummary(), { intervalMs: 30000 });

  const s = data?.stats ?? null;
  const desk = s?.desk ?? null;
  const pnl = data?.pnl ?? [];
  const tradingLive = health?.kalshi?.trading === 'ok';
  const syncAge = data?.sync?.finished_at
    ? Math.round((Date.now() - new Date(data.sync.finished_at).getTime()) / 1000) : null;
  const paper = settings?.paper_trading ?? true;
  const autoPlace = settings?.shadow_auto_place !== false;
  const balanceAgeMins = s?.balance_at
    ? Math.round((Date.now() - new Date(s.balance_at).getTime()) / 60000) : null;
  const mode = shadow.data?.mode ?? null;
  const overall = shadow.data?.summary ?? null;

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
            + (syncAge != null && syncAge > 180
              ? ' — open the app / unlock phone to resume (or wait for background cron)'
              : '')
          : 'Connecting to the desk…'}
        action={
          <button className="btn btn-ace btn-sm" onClick={() => onPage('shadow')}>
            Shadow desk
          </button>
        }
      />

      {error && <ErrorBox error={error} onRetry={refresh} />}
      {paper && <PaperNotice kalshiOk={tradingLive} />}
      {!tradingLive && !paper && <AuthNotice health={health} />}

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
          label="Engine entries"
          value={overall ? fmtNum(overall.placed) : '—'}
          valueClass={overall?.placed ? 'text-ace' : ''}
          delta={autoPlace
            ? (mode?.oddsFeed && mode?.crossMarket ? 'auto-place · books confirming' : 'auto-place on')
            : 'auto-place off — turn on in Settings'}
          deltaClass={autoPlace ? 'text-up' : 'text-amber'}
        />
      </div>

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
          title="Shadow desk"
          tools={<ChipBtn onClick={() => onPage('shadow')}>Open →</ChipBtn>}
          bodyClass="py-2.5 px-3.5"
        >
          <div className="text-[13px] text-muted space-y-3 p-2">
            <p>
              The risk engine places its own trades. There is no alert queue and no
              manual override — sizing and approval both come from the shadow desk.
            </p>
            {overall ? (
              <div className="font-mono text-[12.5px] space-y-1.5">
                <div className="flex justify-between"><span>Placed</span><span className="text-text">{fmtNum(overall.placed)}</span></div>
                <div className="flex justify-between"><span>Held back</span><span className="text-text">{fmtNum(overall.heldBack)}</span></div>
                <div className="flex justify-between"><span>Settled P&L</span>
                  <span className={Number(overall.pnl) > 0 ? 'text-up' : Number(overall.pnl) < 0 ? 'text-down' : 'text-text'}>
                    {fmtUsd(overall.pnl, { sign: true })}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-muted2">
                {shadow.loading || loading ? 'Loading…' : 'No shadow decisions yet.'}
              </div>
            )}
          </div>
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
              <tr><th>Match</th><th>Starts</th><th>UTR Δ</th><th>Fair</th><th>Ask</th><th>Edge</th><th>EV</th><th>Status</th></tr>
            </thead>
            <tbody>
              {(hot.data?.markets ?? []).map(m => (
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
                </tr>
              ))}
              {!(hot.data?.markets ?? []).length && (
                <tr><td colSpan={8} className="text-center text-muted py-8">
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
