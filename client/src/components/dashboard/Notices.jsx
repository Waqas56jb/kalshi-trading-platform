/**
 * Honest status banners. The desk never implies a connection it does not have.
 */

export function AuthNotice({ health }) {
  const k = health?.kalshi;
  const err = k?.authError;
  // `reachable: false` means we never got a verdict — a network fault, not a
  // credential problem. Saying "rejected" in that case would be wrong.
  const unreachable = k?.reachable === false;

  return (
    <div className="mb-5 rounded-card border border-amber/35 bg-amber/8 p-4 flex gap-3.5 items-start">
      <span className="text-amber text-lg leading-none mt-0.5">⚠</span>
      <div className="text-[13.5px]">
        {unreachable ? (
          <>
            <b className="font-display text-amber">Cannot reach Kalshi right now</b>
            <p className="text-muted mt-1">
              The exchange did not respond, so credentials could not be checked and orders cannot be
              placed. Stored market data below may be stale. This retries automatically.
            </p>
          </>
        ) : (
          <>
            <b className="font-display text-amber">Execution is disabled — Kalshi rejected the API credentials</b>
            <p className="text-muted mt-1">
              Live market data, the UTR model and alerting all work (they need no authentication).
              Placing orders does not. The private key does not match the public key registered against
              this API key id, so every order attempt is recorded as <span className="font-mono">failed</span>.
            </p>
          </>
        )}
        {err && <p className="font-mono text-[11.5px] text-muted2 mt-1.5">detail: {err}</p>}
      </div>
    </div>
  );
}

/** Paper mode must never be mistaken for live execution. */
export function PaperNotice({ kalshiOk }) {
  return (
    <div className="mb-5 rounded-card border border-amber/35 bg-amber/8 p-4 flex gap-3.5 items-start">
      <span className="font-mono text-[10px] tracking-[.1em] bg-amber/20 text-amber px-2 py-1 rounded mt-0.5 shrink-0">
        PAPER
      </span>
      <div className="text-[13.5px]">
        <b className="font-display text-amber">Paper trading — no orders reach the exchange</b>
        <p className="text-muted mt-1">
          Approving an alert records a position at the <b>real</b> ask, capped by the volume actually
          available, and settles against Kalshi&apos;s own result once the match finishes. The prices and
          outcomes are real; only the order is simulated.
          {!kalshiOk && ' Live execution stays unavailable until Kalshi accepts the API credentials.'}
        </p>
        <p className="text-muted2 text-[12.5px] mt-1.5">
          Turn this off in Settings → Strategy once a working key pair is in place.
        </p>
      </div>
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  return (
    <div className="mb-5 rounded-card border border-down/40 bg-down/8 p-4 flex gap-3.5 items-start">
      <span className="text-down text-lg leading-none mt-0.5">✕</span>
      <div className="text-[13.5px] flex-1">
        <b className="font-display text-down">Could not load data</b>
        <p className="text-muted mt-1 font-mono text-[12px]">{error?.message ?? String(error)}</p>
      </div>
      {onRetry && <button className="btn btn-ghost btn-sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function RatingsNotice({ ratings }) {
  if (!ratings || ratings.usable === ratings.total) return null;
  const unrated = ratings.total - ratings.usable;
  return (
    <div className="mb-5 rounded-card border border-line2 bg-panel p-4 text-[13px]">
      <b className="font-display">{ratings.usable} of {ratings.total} players have a usable UTR rating</b>
      <p className="text-muted mt-1">
        {unrated} competitor{unrated === 1 ? '' : 's'} could not be matched to a rated UTR profile, so their
        markets are shown unpriced rather than given a guessed fair value. Re-run{' '}
        <span className="font-mono text-ace">node cli/ratings.js --retry</span> to try again.
      </p>
    </div>
  );
}

export function Empty({ icon = '🎾', title, children }) {
  return (
    <div className="text-center py-12.5 px-5 text-muted">
      <div className="text-[38px] mb-2.5">{icon}</div>
      <b>{title}</b>
      {children && <p className="mt-1">{children}</p>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div className="text-center py-12.5 text-muted font-mono text-[13px]">{label}</div>;
}
