import { fmtNum, fmtPct } from '../../lib/api';

export default function ConfirmModal({ alert, busy, health, onClose, onConfirm }) {
  if (!alert) return null;

  const tradingLive = health?.kalshi?.trading === 'ok';
  const rows = [
    ['Player', alert.player_name],
    ['Match', alert.opponent_name ? `vs ${alert.opponent_name}` : alert.matchup],
    ['Tournament', alert.tournament ?? '—'],
    ['Side', 'YES · buy'],
    ['Market ask', alert.market_cents != null ? `${alert.market_cents}¢` : '—'],
    ['Fair value (UTR model)', alert.fair_cents != null ? `${alert.fair_cents}¢` : '—', 'text-ace'],
    ['Edge', alert.edge_cents != null ? `+${alert.edge_cents}¢` : '—', 'text-up'],
    ['Expected value', fmtPct(alert.ev_pct), 'text-up'],
    ['Volume at ask', `${fmtNum(alert.volume_available)} contracts`],
    ['Bid–ask spread', alert.spread_cents != null ? `${alert.spread_cents}¢` : '—'],
  ];

  return (
    <div
      className="fixed inset-0 bg-[rgba(4,6,9,.7)] backdrop-blur-[6px] z-200 flex items-center justify-center p-5 animate-fade-in"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="w-full max-w-[440px] bg-[linear-gradient(165deg,var(--color-panel2),var(--color-panel))]
                      border border-line2 rounded-[20px] p-7.5 animate-modal-in">
        <h3 className="font-display text-[19px] font-extrabold mb-1">Confirm execution</h3>
        <p className="text-muted text-[13.5px] mb-5">
          A fill-or-kill limit order goes to Kalshi at the ask the moment you confirm. Size is derived
          from your stake setting and capped by the volume available.
        </p>

        {!tradingLive && (
          <div className="mb-4 rounded-[11px] border border-amber/35 bg-amber/8 p-3 text-[12.5px]">
            <b className="text-amber font-display">This will not reach the exchange</b>
            <p className="text-muted mt-1">
              Kalshi is rejecting the configured API credentials. Confirming records the attempt as
              <span className="font-mono"> failed</span> in your ledger so nothing is lost, but no order is placed.
            </p>
          </div>
        )}

        <div className="bg-bg2 border border-line rounded-[13px] py-1.5 px-4 mb-5">
          {rows.map(([l, r, tone]) => (
            <div key={l} className="flex justify-between gap-4 py-[11px] border-b border-line last:border-b-0 text-[13.5px]">
              <span className="text-muted shrink-0">{l}</span>
              <span className={`font-mono font-semibold text-right ${tone || ''}`}>{r}</span>
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <button className="btn btn-ghost flex-1 justify-center" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-ace flex-1 justify-center"
            onClick={() => onConfirm(alert)}
            disabled={busy}
          >
            {busy ? 'Sending…' : 'Execute sweep ⚡'}
          </button>
        </div>
      </div>
    </div>
  );
}
