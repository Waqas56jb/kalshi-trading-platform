import { useState } from 'react';
import { ChipBtn, Panel, StatusTag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { useCanvas } from '../../../hooks/useUi';
import { api, fmtPct, fmtUsd } from '../../../lib/api';
import { drawLineArea } from '../../../lib/charts';
import { PageHead } from '../PageHead';
import { AuthNotice, ErrorBox } from '../Notices';

export default function Overview({ alerts, health, onPage, onTrade }) {
  const [days, setDays] = useState(30);
  const { data, error, loading } = usePoll(() => api.overview(days), {
    intervalMs: 15000, deps: [days],
  });
  const hot = usePoll(() => api.markets({ filter: 'mispriced', limit: 5 }), { intervalMs: 15000 });

  const s = data?.stats ?? null;
  const pnl = data?.pnl ?? [];
  const tradingLive = health?.kalshi?.trading === 'ok';

  const pnlRef = useCanvas(c => {
    drawLineArea(c, pnl.map(p => p.cumulative), '#34D399', {
      fillAlpha: 0.22, emptyLabel: 'No settled trades yet',
    });
  }, [pnl.length, days, pnl[pnl.length - 1]?.cumulative]);

  return (
    <div className="animate-page-in">
      <PageHead
        title="Overview"
        sub={data?.sync?.finished_at
          ? `Desk is live · last sync ${new Date(data.sync.finished_at).toLocaleTimeString()}`
          : 'Connecting to the desk…'}
        action={
          <button className="btn btn-ace btn-sm" onClick={() => onPage('alerts')}>
            {alerts.length ? `Review ${alerts.length} open alert${alerts.length === 1 ? '' : 's'}` : 'No open alerts'}
          </button>
        }
      />

      {error && <ErrorBox error={error} />}
      {!tradingLive && <AuthNotice health={health} />}

      <div className="grid grid-cols-4 gap-4 mb-5.5 max-[1180px]:grid-cols-2 max-[420px]:grid-cols-1">
        <StatCard
          label="Kalshi balance"
          value={s?.balance_cents != null ? fmtUsd(s.balance_cents / 100) : '—'}
          delta={s?.balance_cents != null ? 'live from Kalshi' : 'needs API credentials'}
          deltaClass={s?.balance_cents != null ? 'text-up' : 'text-muted2'}
        />
        <StatCard
          label="Today's realised P&L"
          value={s ? fmtUsd(s.pnl_today, { sign: true }) : '—'}
          valueClass={s?.pnl_today > 0 ? 'text-up' : s?.pnl_today < 0 ? 'text-down' : ''}
          delta={s ? `${fmtUsd(s.pnl_7d, { sign: true })} over 7 days` : '—'}
          deltaClass={s?.pnl_7d >= 0 ? 'text-up' : 'text-down'}
        />
        <StatCard
          label="Open positions"
          value={s ? String(s.open_positions) : '—'}
          delta={s ? `${fmtUsd(s.at_risk)} at risk` : '—'}
          deltaClass="text-muted"
        />
        <StatCard
          label="Hit rate"
          value={s?.hit_rate != null ? `${s.hit_rate}%` : '—'}
          delta={s ? (s.settled ? `${s.won} of ${s.settled} settled` : 'no settled trades yet') : '—'}
          deltaClass={s?.settled ? 'text-up' : 'text-muted2'}
        />
      </div>

      <div className="grid grid-cols-[2fr_1fr] gap-4 max-[980px]:grid-cols-1">
        <Panel
          title="Cumulative realised P&L"
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
              {loading ? 'Loading…' : 'No open alerts — the engine is scanning.'}
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
              <tr><th>Match</th><th>UTR Δ</th><th>Fair</th><th>Ask</th><th>Edge</th><th>EV</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {(hot.data?.markets ?? []).map(m => (
                <tr key={m.ticker}>
                  <td>
                    <div className="font-semibold text-[13.5px]">{m.player_name}</div>
                    <div className="text-[11.5px] text-muted2 font-mono mt-0.5">{m.tournament ?? m.matchup}</div>
                  </td>
                  <td className="font-mono font-semibold text-ace">
                    {m.utr_gap != null ? `Δ ${m.utr_gap}` : '—'}
                  </td>
                  <td className="font-mono font-semibold">{m.fair_cents != null ? `${m.fair_cents}¢` : '—'}</td>
                  <td className="font-mono font-semibold">{m.yes_ask_cents != null ? `${m.yes_ask_cents}¢` : '—'}</td>
                  <td className="font-mono font-bold text-ace">{m.edge_cents != null ? `+${m.edge_cents}¢` : '—'}</td>
                  <td className="font-mono font-semibold text-up">{fmtPct(m.ev_pct)}</td>
                  <td><StatusTag m={m} /></td>
                  <td>
                    <button
                      className="btn btn-up btn-sm"
                      onClick={() => onTrade(alerts.find(a => a.ticker === m.ticker) ?? null)}
                      disabled={!alerts.some(a => a.ticker === m.ticker)}
                      title={alerts.some(a => a.ticker === m.ticker) ? 'Review and execute' : 'No open alert for this market'}
                    >
                      Trade
                    </button>
                  </td>
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

function StatCard({ label, value, valueClass = '', delta, deltaClass = 'text-up' }) {
  return (
    <div className="bg-[linear-gradient(160deg,var(--color-panel2),var(--color-panel))] border border-line
                    rounded-card p-5 relative overflow-hidden transition-all duration-300
                    ease-[cubic-bezier(.22,1,.36,1)] hover:-translate-y-1 hover:border-line2">
      <div className="text-xs text-muted tracking-[.04em] uppercase font-semibold flex justify-between items-center">
        {label}
      </div>
      <div className={`font-mono text-[27px] font-bold mt-2 tracking-[-.01em] ${valueClass}`}>{value}</div>
      <div className={`font-mono text-xs mt-[5px] inline-flex gap-[5px] items-center ${deltaClass}`}>{delta}</div>
    </div>
  );
}
