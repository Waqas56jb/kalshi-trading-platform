import { useState } from 'react';
import { Panel, Tag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { api, fmtNum, fmtUsd } from '../../../lib/api';
import { PageHead } from '../PageHead';
import { ErrorBox } from '../Notices';

/**
 * The shadow desk.
 *
 * Rejected decisions are given equal billing with approved ones, deliberately.
 * A filter that drops opportunities silently is how the old 0.5 UTR minimum ran
 * for a fortnight while it was costing 68 signals a day and nobody could see it.
 */
export default function Shadow() {
  const [tab, setTab] = useState('placed');
  const { data, error } = usePoll(() => api.shadowSummary(), { intervalMs: 20000 });
  const { data: decisions } = usePoll(
    () => api.shadowDecisions(tab === 'placed' ? 'true' : 'false'),
    { intervalMs: 20000, deps: [tab] },
  );

  const s = data?.summary;
  const mode = data?.mode;
  const rows = decisions?.decisions ?? [];

  return (
    <div className="animate-page-in">
      <PageHead
        title="Shadow desk"
        sub="The risk engine on live markets and real prices — approved entries are placed automatically"
      />

      {error && <ErrorBox error={error} />}

      {mode && (
        <div className="flex flex-wrap gap-2 mb-5">
          <Tag className={mode.shadow ? 'bg-ace-dim text-ace' : 'bg-danger/15 text-danger'}>
            {mode.shadow ? 'SIMULATED — NO REAL ORDERS' : 'LIVE TRADING'}
          </Tag>
          <Tag className="bg-panel border border-line">BANKROLL {fmtUsd(mode.bankroll)}</Tag>
          <Tag className="bg-panel border border-line">{mode.cashReservePct}% CASH RESERVE</Tag>
          <Tag
            className="bg-panel border border-line"
            title="No big underdogs: ask and fair both ≥ this. 35–50¢ band still trades."
          >
            FLOOR {mode.minPriceCents}¢ ASK+FAIR
          </Tag>
          <Tag className="bg-panel border border-line">
            BOOKS {mode.crossMarket && mode.oddsFeed ? 'CONFIRMING'
              : mode.oddsFeed ? 'CONNECTED — GATE OFF' : 'NOT CONNECTED'}
          </Tag>
          {mode.deskSince && (
            <Tag className="bg-panel border border-line" title="Pre-era placed bets archived out of P&L">
              DESK SINCE {new Date(mode.deskSince).toLocaleDateString()}
            </Tag>
          )}
        </div>
      )}

      <div className="mb-5 rounded-card border border-line2 bg-panel p-3.5 text-[12.5px] text-muted">
        Buys use the <span className="text-text">ask only</span> (bid / spread irrelevant, pre-match).
        No big underdogs: <span className="text-text">ask and fair ≥ {mode?.minPriceCents ?? 35}¢</span>
        {' '}— 35–50¢ band and favourites stay in.
        Fair gap is <span className="text-text">50% singles UTR + 50% 3-month UTR</span>.
        Both players need <span className="text-text">&gt;{s?.minUtrMatches12m ?? 15} competitive UTR matches</span>
        {' '}(within {s?.competitiveUtrGap ?? 2} UTR, last year) or we hold.
        Odds checker is optional on ITF — full stake with or without books.
      </div>

      {s?.formulaAdapt && (
        <div className="mb-5 rounded-card border border-line2 bg-panel p-3.5 text-[12.5px] text-muted">
          <span className="text-text font-semibold">Formula adapt:</span>{' '}
          {s.formulaAdapt.status === 'ready_to_review' ? (
            <span className="text-amber">{s.formulaAdapt.note}</span>
          ) : (
            <>{s.formulaAdapt.note} Need ≥{s.formulaAdapt.minSettledPerBand} settled per band.</>
          )}
        </div>
      )}

      {(s?.monitors?.length > 0) && (
        <div className="mb-5 rounded-card border border-danger/40 bg-danger/10 p-3.5 text-[12.5px]">
          <div className="font-semibold text-danger mb-2">Desk monitors</div>
          <ul className="space-y-1 text-muted">
            {s.monitors.map(m => (
              <li key={m.id}>
                <span className={m.severity === 'error' ? 'text-danger' : m.severity === 'info' ? 'text-muted' : 'text-amber'}>
                  {m.severity === 'error' ? '●' : '○'}
                </span>
                {' '}{m.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Placed" value={s ? fmtNum(s.placed) : '—'} sub={`${fmtNum(s?.heldBack ?? 0)} held (24h)`} />
        <Stat label="Settled" value={s ? fmtNum(s.settled) : '—'}
          sub={s?.winRate != null ? `${Math.round(s.winRate * 100)}% won` : 'none yet'} />
        <Stat label="Staked" value={s ? fmtUsd(s.staked) : '—'} sub={`${fmtUsd(s?.atRisk ?? 0)} at risk`} />
        <Stat label="P&L" value={s ? fmtUsd(s.pnl) : '—'}
          sub={s?.roi != null ? `${s.roi > 0 ? '+' : ''}${s.roi}% ROI` : 'awaiting settlement'}
          tone={s?.pnl > 0 ? 'up' : s?.pnl < 0 ? 'down' : null} />
      </div>

      <Panel title="By UTR bracket">
        <div className="text-muted text-[12.5px] mb-3">
          The four brackets the client asked to collect on. The old rule blocked everything
          under a 0.5 gap; this is what fills in now that it is gone.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[520px]">
            <thead className="text-muted text-[11.5px] uppercase tracking-wide">
              <tr>
                <Th>Bracket</Th><Th right>Placed</Th><Th right>Settled</Th>
                <Th right>Win rate</Th><Th right>Staked</Th><Th right>P&L</Th><Th right>ROI</Th>
              </tr>
            </thead>
            <tbody>
              {(s?.brackets ?? []).map(b => (
                <tr key={b.bracket} className="border-t border-line">
                  <Td>{b.bracket}</Td>
                  <Td right>{fmtNum(b.placed)}</Td>
                  <Td right>{fmtNum(b.settled)}</Td>
                  <Td right>{b.winRate != null ? `${Math.round(b.winRate * 100)}%` : '—'}</Td>
                  <Td right>{fmtUsd(b.staked)}</Td>
                  <Td right className={b.pnl > 0 ? 'text-ace' : b.pnl < 0 ? 'text-danger' : ''}>
                    {fmtUsd(b.pnl)}
                  </Td>
                  <Td right>{b.roi != null ? `${b.roi}%` : '—'}</Td>
                </tr>
              ))}
              {!s?.brackets?.length && (
                <tr><Td colSpan={7}><span className="text-muted">No bracket data yet.</span></Td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Favourite / underdog tilt audit">
        <div className="text-muted text-[12.5px] mb-3">
          Where the engine's entries sit on the price ladder, each band judged on its own P&L.
          {s?.underdogStakeShare != null && (
            <> Right now <strong className="text-ink">{s.underdogStakeShare}%</strong> of stake
            is below 50¢ — the engine's price floor and per-band exposure caps are what keep
            this from drifting toward longshots.</>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[520px]">
            <thead className="text-muted text-[11.5px] uppercase tracking-wide">
              <tr>
                <Th>Entry price</Th><Th right>Placed</Th><Th right>Settled</Th>
                <Th right>Win rate</Th><Th right>Staked</Th><Th right>P&L</Th><Th right>ROI</Th>
              </tr>
            </thead>
            <tbody>
              {(s?.priceBands ?? []).map(b => (
                <tr key={b.band} className="border-t border-line">
                  <Td>{b.band}</Td>
                  <Td right>{fmtNum(b.placed)}</Td>
                  <Td right>{fmtNum(b.settled)}</Td>
                  <Td right>{b.winRate != null ? `${Math.round(b.winRate * 100)}%` : '—'}</Td>
                  <Td right>{fmtUsd(b.staked)}</Td>
                  <Td right className={b.pnl > 0 ? 'text-ace' : b.pnl < 0 ? 'text-danger' : ''}>
                    {fmtUsd(b.pnl)}
                  </Td>
                  <Td right>{b.roi != null ? `${b.roi}%` : '—'}</Td>
                </tr>
              ))}
              {!s?.priceBands?.length && (
                <tr><Td colSpan={7}><span className="text-muted">No entries to audit yet.</span></Td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Decisions"
        tools={[
          <button key="p" onClick={() => setTab('placed')}
            className={`btn btn-sm ${tab === 'placed' ? 'btn-ace' : ''}`}>Placed</button>,
          <button key="h" onClick={() => setTab('held')}
            className={`btn btn-sm ${tab === 'held' ? 'btn-ace' : ''}`}>Held back</button>,
        ]}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[760px]">
            <thead className="text-muted text-[11.5px] uppercase tracking-wide">
              <tr>
                <Th>Player</Th><Th>Bracket</Th><Th right>Ask</Th><Th right>Model</Th>
                <Th right>Shrunk</Th><Th right>Edge</Th><Th right>ROI</Th>
                <Th right>{tab === 'placed' ? 'Stake' : ''}</Th>
                <Th>{tab === 'placed' ? 'Result' : 'Why not'}</Th>
                {tab === 'placed' && <Th>Score</Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(d => (
                <tr key={d.ticker} className="border-t border-line align-top">
                  <Td>
                    <div className="font-medium">{d.player_name}</div>
                    <div className="text-muted text-[11.5px]">v {d.opponent_name ?? '—'}</div>
                  </Td>
                  <Td><span className="text-muted">{d.utr_bracket ?? '—'}</span></Td>
                  <Td right>{d.best_ask_cents != null ? `${d.best_ask_cents}¢` : '—'}</Td>
                  <Td right>{pct(d.model_probability)}</Td>
                  <Td right>{pct(d.conservative_prob)}</Td>
                  <Td right className={Number(d.net_edge) > 0 ? 'text-ace' : ''}>{pp(d.net_edge)}</Td>
                  <Td right>{d.expected_roi != null ? `${(Number(d.expected_roi) * 100).toFixed(0)}%` : '—'}</Td>
                  <Td right>{tab === 'placed' ? fmtUsd(d.stake_usd) : ''}</Td>
                  <Td>
                    <span className="text-muted text-[12px]">
                      {tab === 'placed'
                        ? (d.result ? `${String(d.result).toUpperCase()}${d.limiting_constraint ? ` · ${d.limiting_constraint}` : ''}`
                          : (d.limiting_constraint ?? '—'))
                        : d.rejection_reason}
                    </span>
                  </Td>
                  {tab === 'placed' && (
                    <Td>
                      <span className="font-mono text-[12px] text-muted">{d.match_score || '—'}</span>
                    </Td>
                  )}
                </tr>
              ))}
              {!rows.length && (
                <tr><Td colSpan={tab === 'placed' ? 10 : 9}>
                  <span className="text-muted">
                    {tab === 'placed' ? 'Nothing has cleared the risk rules yet.' : 'Nothing held back.'}
                  </span>
                </Td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Most common reasons for holding back">
        <div className="flex flex-col gap-2">
          {(s?.heldBackReasons ?? []).map((r, i) => (
            <div key={i} className="flex items-baseline justify-between gap-4 text-[13px]">
              <span className="min-w-0 truncate">{r.rejection_reason}</span>
              <span className="text-muted whitespace-nowrap">
                {r.limiting_constraint} · {fmtNum(r.n)}
              </span>
            </div>
          ))}
          {!s?.heldBackReasons?.length && <span className="text-muted text-[13px]">Nothing held back yet.</span>}
        </div>
      </Panel>
    </div>
  );
}

const pct = v => (v == null ? '—' : `${(Number(v) * 100).toFixed(0)}%`);
const pp = v => (v == null ? '—' : `${Number(v) > 0 ? '+' : ''}${(Number(v) * 100).toFixed(1)}pp`);

function Th({ children, right }) {
  return <th className={`py-2 font-semibold ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}
function Td({ children, right, colSpan, className = '' }) {
  return (
    <td colSpan={colSpan} className={`py-2.5 ${right ? 'text-right' : ''} ${className}`}>
      {children}
    </td>
  );
}
function Stat({ label, value, sub, tone }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2 min-w-0">
      <div className="text-muted text-[11.5px] uppercase tracking-wide truncate">{label}</div>
      <div className={`font-display text-lg font-bold truncate ${
        tone === 'up' ? 'text-ace' : tone === 'down' ? 'text-danger' : ''}`}>{value}</div>
      {sub && <div className="text-muted text-[11.5px] truncate">{sub}</div>}
    </div>
  );
}
