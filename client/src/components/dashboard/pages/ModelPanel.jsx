import { Panel, Tag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { api, fmtNum } from '../../../lib/api';

/**
 * What the model works out for itself, shown read-only.
 *
 * Robbie's point was a fair one: if the algorithm derives these, a text box
 * beside them is an invitation to overrule it by hand. So the derived values now
 * live here, where they can be inspected and not edited, and Settings keeps only
 * the handful of figures that are genuinely decisions — bankroll, cash reserve,
 * price floor — which no amount of data can settle on the owner's behalf.
 */
export function ModelPanel() {
  const { data } = usePoll(() => api.calibration(), { intervalMs: 60000 });
  const buckets = data?.buckets ?? [];
  const curve = data?.curve ?? [];

  return (
    <>
      <FormulaLab />

      <Panel title="Fitted rating curve">
        <div className="text-muted text-[12.5px] mb-4">
          Refitted from settled matches on every sync. Each bracket sits at the mean gap
          actually observed inside it, thin brackets are pulled toward the original curve,
          and the whole thing is forced to rise — a larger rating gap can never price lower
          than a smaller one.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[480px]">
            <thead className="text-muted text-[11.5px] uppercase tracking-wide">
              <tr>
                <Th>UTR gap</Th><Th right>Matches</Th><Th right>Mean gap</Th>
                <Th right>Raw win rate</Th><Th right>Fair value</Th>
              </tr>
            </thead>
            <tbody>
              {curve.map(c => (
                <tr key={c.bracket} className="border-t border-line">
                  <Td>{c.bracket}</Td>
                  <Td right>{fmtNum(c.sampleSize)}</Td>
                  <Td right>{c.meanGap?.toFixed(2) ?? '—'}</Td>
                  <Td right className="text-muted">
                    {c.rawWinRate != null ? `${Math.round(c.rawWinRate * 100)}%` : '—'}
                  </Td>
                  <Td right className="font-display font-bold">{c.fittedCents}¢</Td>
                </tr>
              ))}
              {!curve.length && (
                <tr><Td colSpan={5}>
                  <span className="text-muted">
                    Not enough settled matches yet — the original curve is in use.
                  </span>
                </Td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Calibration">
        <div className="text-muted text-[12.5px] mb-4">
          How the model's own predictions actually resolved. A bucket must be verified
          before the engine will size a position on it more aggressively, so a thin
          sample cannot buy trust it has not earned.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[520px]">
            <thead className="text-muted text-[11.5px] uppercase tracking-wide">
              <tr>
                <Th>Model said</Th><Th right>Sample</Th><Th right>Predicted</Th>
                <Th right>Actual</Th><Th right>Error</Th><Th right>Status</Th>
              </tr>
            </thead>
            <tbody>
              {buckets.map(b => {
                const err = Number(b.calibration_error);
                return (
                  <tr key={b.bucket} className="border-t border-line">
                    <Td>{b.bucket}</Td>
                    <Td right>{fmtNum(b.sample_size)}</Td>
                    <Td right>{(Number(b.mean_predicted) * 100).toFixed(1)}%</Td>
                    <Td right>{(Number(b.actual_rate) * 100).toFixed(1)}%</Td>
                    <Td right className={err > 0.04 ? 'text-danger' : ''}>
                      {(err * 100).toFixed(1)}pp
                    </Td>
                    <Td right>
                      <Tag className={b.verified ? 'bg-ace-dim text-ace' : 'bg-panel border border-line'}>
                        {b.verified ? 'VERIFIED' : 'THIN'}
                      </Tag>
                    </Td>
                  </tr>
                );
              })}
              {!buckets.length && (
                <tr><Td colSpan={6}><span className="text-muted">No settled predictions yet.</span></Td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

/**
 * Max's ask, verbatim: "simulate P and L of three different weighted formulas
 * so we can see how our formula needs to adjust". Every settled match is
 * replayed at its last pre-close ask under each formula, fees included, and
 * the favourite/underdog split shows where the money actually comes from.
 */
function FormulaLab() {
  const { data, error } = usePoll(() => api.simulateFormulas(), { intervalMs: 120000 });
  const rows = data?.formulas ?? [];

  const pnl = v => (
    <span className={v > 0 ? 'text-up' : v < 0 ? 'text-down' : ''}>
      {v > 0 ? '+' : ''}{v?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );

  return (
    <Panel title="Formula lab — simulated P&L">
      <div className="text-muted text-[12.5px] mb-4">
        Every settled match replayed under three fair-value formulas, entered at the last
        recorded ask before the pre-match cutoff, $100 a bet, Kalshi fees included. Same
        matches, same prices — only the formula changes. The favourite/underdog split shows
        which side of the book each formula's profit depends on.
      </div>
      {error && <div className="text-danger text-[12.5px]">Could not load the simulation: {error.message}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] min-w-[640px]">
          <thead className="text-muted text-[11.5px] uppercase tracking-wide">
            <tr>
              <Th>Formula</Th><Th right>Bets</Th><Th right>Win rate</Th>
              <Th right>P&L ($)</Th><Th right>ROI</Th>
              <Th right>Favourites P&L</Th><Th right>Underdogs P&L</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(f => (
              <tr key={f.id} className="border-t border-line">
                <Td>{f.name}</Td>
                <Td right>{fmtNum(f.bets)}</Td>
                <Td right>{f.winRatePct != null ? `${f.winRatePct}%` : '—'}</Td>
                <Td right className="font-display font-bold">{pnl(f.pnlUsd)}</Td>
                <Td right>{f.roiPct != null ? `${f.roiPct}%` : '—'}</Td>
                <Td right>{pnl(f.favourite?.pnlUsd)} <span className="text-muted2">({fmtNum(f.favourite?.bets)})</span></Td>
                <Td right>{pnl(f.underdog?.pnlUsd)} <span className="text-muted2">({fmtNum(f.underdog?.bets)})</span></Td>
              </tr>
            ))}
            {!rows.length && !error && (
              <tr><Td colSpan={7}><span className="text-muted">Running the replay…</span></Td></tr>
            )}
          </tbody>
        </table>
      </div>
      {data && (
        <div className="text-muted2 text-[11.5px] font-mono mt-3">
          {fmtNum(data.sample)} settled matches with a recorded pre-match price ·
          fitted k = {data.logisticK?.toFixed(2)} · entry rule: edge ≥ {data.params?.minEdgeCents}¢,
          price ≥ {data.params?.floorCents}¢
        </div>
      )}
    </Panel>
  );
}

function Th({ children, right }) {
  return <th className={`py-2 font-semibold ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}
function Td({ children, right, colSpan, className = '' }) {
  return (
    <td colSpan={colSpan} className={`py-2.5 ${right ? 'text-right' : ''} ${className}`}>{children}</td>
  );
}
