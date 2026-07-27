import { Tag } from '../../common';
import { PageHead } from '../PageHead';

export default function Alerts({ alerts, onDismiss, onClear, onTrade }) {
  return (
    <div className="animate-page-in">
      <PageHead
        title="Mispricing alerts"
        sub="Opportunities above your +8% EV threshold — approve to execute"
        action={<button className="btn btn-ghost btn-sm" onClick={onClear}>Dismiss all</button>}
      />

      <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4 max-sm:grid-cols-1">
        {alerts.map(a => (
          <div
            key={a.id}
            className={`relative overflow-hidden p-5 rounded-card animate-alert-in transition-all duration-300
                        ease-[cubic-bezier(.22,1,.36,1)] hover:-translate-y-1 hover:shadow-[0_16px_40px_rgba(0,0,0,.4)]
                        bg-[linear-gradient(160deg,var(--color-panel2),var(--color-panel))] border
                        ${a.ev >= 15 ? 'alert-hot border-down/40' : 'border-line2'}`}
          >
            <div className="flex justify-between items-start mb-3.5 gap-2.5">
              <div>
                <div className="font-mono text-[11px] text-muted2">{a.t}</div>
                <div className="font-display font-bold text-[15px] mt-[3px]">{a.p}</div>
              </div>
              {a.ev >= 15
                ? <Tag className="bg-down/15 text-down animate-hot-pulse">HIGH EV</Tag>
                : <Tag className="bg-amber/15 text-amber">EDGE</Tag>}
            </div>

            <div className="grid grid-cols-3 gap-2.5 mb-4">
              <Num v={`${a.mkt}¢`} l="Market" />
              <Num v={`${a.fair}¢`} l="Fair" className="text-ace" />
              <Num v={`+${a.ev}%`} l="EV" className="text-up" />
            </div>

            <div className="flex gap-2.5">
              <button className="btn btn-danger btn-sm flex-1 justify-center" onClick={() => onDismiss(a.id)}>Dismiss</button>
              <button className="btn btn-up btn-sm flex-1 justify-center" onClick={() => onTrade(a)}>Approve trade</button>
            </div>

            <div className="font-mono text-[11px] text-muted2 mt-3 text-right">
              Δ {a.gap} UTR · {a.vol.toLocaleString()} contracts · {a.ago}
            </div>
          </div>
        ))}
      </div>

      {!alerts.length && (
        <div className="text-center py-12.5 px-5 text-muted">
          <div className="text-[38px] mb-2.5">🎾</div>
          <b>No open alerts</b>
          <p>The engine is scanning. New edges will appear here the moment they open up.</p>
        </div>
      )}
    </div>
  );
}

const Num = ({ v, l, className = '' }) => (
  <div className="bg-bg2 border border-line rounded-[10px] p-2.5 text-center">
    <div className={`font-mono font-bold text-base ${className}`}>{v}</div>
    <div className="text-[10px] text-muted2 uppercase tracking-[.08em] mt-0.5">{l}</div>
  </div>
);
