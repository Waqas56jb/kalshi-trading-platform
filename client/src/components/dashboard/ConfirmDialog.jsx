/**
 * The barrier between a click and something irreversible.
 *
 * Closing a position sells real contracts at the current bid; deleting an
 * account removes someone's access. Neither should happen because a finger
 * slipped on a phone, so both route through this dialog. Styled to match
 * ConfirmModal, which plays the same role for trade execution.
 */
export default function ConfirmDialog({ open, title, message, rows = [], confirmLabel, busy, danger = true, onClose, onConfirm }) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-[rgba(4,6,9,.7)] backdrop-blur-[6px] z-200 flex items-center justify-center p-5 animate-fade-in"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="w-full max-w-[420px] bg-[linear-gradient(165deg,var(--color-panel2),var(--color-panel))]
                      border border-line2 rounded-[20px] p-7.5 animate-modal-in">
        <h3 className="font-display text-[19px] font-extrabold mb-1">{title}</h3>
        <p className="text-muted text-[13.5px] mb-5">{message}</p>

        {rows.length > 0 && (
          <div className="bg-bg2 border border-line rounded-[13px] py-1.5 px-4 mb-5">
            {rows.map(([l, r, tone]) => (
              <div key={l} className="flex justify-between gap-4 py-[11px] border-b border-line last:border-b-0 text-[13.5px]">
                <span className="text-muted shrink-0">{l}</span>
                <span className={`font-mono font-semibold text-right ${tone || ''}`}>{r}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-3">
          <button className="btn btn-ghost flex-1 justify-center" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`${danger ? 'btn btn-danger' : 'btn btn-ace'} flex-1 justify-center`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
