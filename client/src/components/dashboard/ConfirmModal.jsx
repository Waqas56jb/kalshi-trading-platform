export default function ConfirmModal({ ctx, onClose, onConfirm }) {
  if (!ctx) return null;

  const rows = [
    ['Match', ctx.p],
    ['Side', 'YES · favourite'],
    ['Market price', `${ctx.mkt}¢`],
    ['Fair value', `${ctx.fair}¢`, 'text-ace'],
    ['Expected value', `+${ctx.ev}%`, 'text-up'],
    ['Volume to sweep', `${ctx.vol.toLocaleString()} contracts`],
    ['Stake', '$250'],
  ];

  return (
    <div
      className="fixed inset-0 bg-[rgba(4,6,9,.7)] backdrop-blur-[6px] z-200 flex items-center justify-center p-5 animate-fade-in"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-[440px] bg-[linear-gradient(165deg,var(--color-panel2),var(--color-panel))]
                      border border-line2 rounded-[20px] p-7.5 animate-modal-in">
        <h3 className="font-display text-[19px] font-extrabold mb-1">Confirm execution</h3>
        <p className="text-muted text-[13.5px] mb-5">
          Order goes to Kalshi the moment you confirm. Sweep captures all volume at or better than this price.
        </p>

        <div className="bg-bg2 border border-line rounded-[13px] py-1.5 px-4 mb-5">
          {rows.map(([l, r, tone]) => (
            <div key={l} className="flex justify-between py-[11px] border-b border-line last:border-b-0 text-[13.5px]">
              <span className="text-muted">{l}</span>
              <span className={`font-mono font-semibold ${tone || ''}`}>{r}</span>
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <button className="btn btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
          <button className="btn btn-ace flex-1 justify-center" onClick={() => onConfirm(ctx)}>Execute sweep ⚡</button>
        </div>
      </div>
    </div>
  );
}
