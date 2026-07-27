import { useState } from 'react';
import { ChipBtn, Panel, StatusTag } from '../../common';
import { useCanvas, useCountUp } from '../../../hooks/useUi';
import { drawLineArea, seriesRandomWalk } from '../../../lib/charts';
import { PageHead } from '../PageHead';

export default function Overview({ matches, alerts, onPage, onTrade }) {
  const [days, setDays] = useState(30);

  const pnlRef = useCanvas(c => {
    const data = seriesRandomWalk(days, 0, 52, 120).map(v => Math.max(v, -200));
    drawLineArea(c, data, '#34D399', 0.22, true, false);
  }, [days]);

  const hot = matches.filter(m => m.hot).slice(0, 5);

  return (
    <div className="animate-page-in">
      <PageHead
        title="Overview"
        sub="Monday, July 27 — desk is live"
        action={
          <button className="btn btn-ace btn-sm" onClick={() => onPage('alerts')}>
            Review {alerts.length} open alerts
          </button>
        }
      />

      <div className="grid grid-cols-4 gap-4 mb-5.5 max-[1180px]:grid-cols-2 max-[420px]:grid-cols-1">
        <StatCard label="Bankroll" value={<>$<Count n={12480} /></>} delta="▲ +$1,240 this week" spark="up" />
        <StatCard label="Today's P&L" value={<>+$<Count n={386} /></>} valueClass="text-up" delta="▲ +3.2% on deployed" spark="up" />
        <StatCard label="Open positions" value={<Count n={6} />} delta="$2,140 at risk" deltaClass="text-muted" spark="flat" />
        <StatCard label="Hit rate (30d)" value={<><Count n={78} />%</>} delta="▲ 43 of 55 settled" spark="up" />
      </div>

      <div className="grid grid-cols-[2fr_1fr] gap-4 max-[980px]:grid-cols-1">
        <Panel
          title="Cumulative P&L"
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
                {a.p}<br />
                <span className="text-muted2 text-[11px] font-mono">{a.t}</span>
              </span>
              <span className="bg-up/15 text-up py-[3px] px-2.5 rounded-full text-xs font-bold font-mono whitespace-nowrap">
                +{a.ev}%
              </span>
            </div>
          )) : <div className="text-center py-6 text-muted">No open alerts</div>}
        </Panel>
      </div>

      <Panel
        title="Hottest edges right now"
        tools={<ChipBtn onClick={() => onPage('markets')}>All markets →</ChipBtn>}
        bodyClass=""
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Match</th><th>UTR Δ</th><th>Fair</th><th>Market</th><th>EV</th><th>Status</th><th /></tr></thead>
            <tbody>
              {hot.map(m => (
                <tr key={m.p}>
                  <td>
                    <div className="font-semibold text-[13.5px]">{m.p}</div>
                    <div className="text-[11.5px] text-muted2 font-mono mt-0.5">{m.t}</div>
                  </td>
                  <td className="font-mono font-semibold text-ace">Δ {m.gap}</td>
                  <td className="font-mono font-semibold">{m.fair}¢</td>
                  <td className="font-mono font-semibold">{m.mkt}¢</td>
                  <td className="font-mono font-semibold text-up">+{m.ev}%</td>
                  <td><StatusTag m={m} /></td>
                  <td><button className="btn btn-up btn-sm" onClick={() => onTrade(m)}>Trade</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Count({ n }) {
  return <>{useCountUp(n)}</>;
}

function StatCard({ label, value, valueClass = '', delta, deltaClass = 'text-up', spark }) {
  const ref = useCanvas(c => {
    const data = seriesRandomWalk(24, 10, spark === 'up' ? 0.5 : 0, 1.4);
    drawLineArea(c, data, spark === 'up' ? '#34D399' : '#8B98A8', 0.15, false, false);
  });

  return (
    <div className="bg-[linear-gradient(160deg,var(--color-panel2),var(--color-panel))] border border-line
                    rounded-card p-5 relative overflow-hidden transition-all duration-300
                    ease-[cubic-bezier(.22,1,.36,1)] hover:-translate-y-1 hover:border-line2">
      <div className="text-xs text-muted tracking-[.04em] uppercase font-semibold flex justify-between items-center">
        {label}
      </div>
      <div className={`font-mono text-[27px] font-bold mt-2 tracking-[-.01em] ${valueClass}`}>{value}</div>
      <div className={`font-mono text-xs mt-[5px] inline-flex gap-[5px] items-center ${deltaClass}`}>{delta}</div>
      <canvas ref={ref} height="36" className="absolute right-0 bottom-0 left-0 opacity-50" />
    </div>
  );
}
