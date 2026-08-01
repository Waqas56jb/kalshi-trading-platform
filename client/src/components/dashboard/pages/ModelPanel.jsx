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

function Th({ children, right }) {
  return <th className={`py-2 font-semibold ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}
function Td({ children, right, colSpan, className = '' }) {
  return (
    <td colSpan={colSpan} className={`py-2.5 ${right ? 'text-right' : ''} ${className}`}>{children}</td>
  );
}
