import { useState } from 'react';
import { useToast } from '../../Toasts';
import { ChipBtn, Tag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { api, fmtPct, fmtTime, fmtUsd } from '../../../lib/api';
import { PageHead } from '../PageHead';
import { Empty, ErrorBox, Loading } from '../Notices';
import ConfirmDialog from '../ConfirmDialog';

const FILTERS = [['all', 'All'], ['open', 'Open'], ['won', 'Won'], ['lost', 'Lost']];

const STATUS_TAG = {
  filled: ['bg-up/12 text-up', 'FILLED'],
  partial: ['bg-amber/15 text-amber', 'PARTIAL'],
  pending: ['bg-amber/15 text-amber', 'PENDING'],
  settled: ['bg-muted/12 text-muted', 'SETTLED'],
  cancelled: ['bg-muted/12 text-muted', 'CANCELLED'],
  failed: ['bg-down/15 text-down', 'FAILED'],
};

export default function Trades({ user }) {
  const toast = useToast();
  const [filter, setFilter] = useState('all');
  const [settling, setSettling] = useState(false);
  const [closing, setClosing] = useState(null);
  const { data, error, loading, refresh } = usePoll(() => api.trades(filter), {
    intervalMs: 8000, deps: [filter],
  });
  /* Engine decisions (newest first) — fills also land in this ledger when
     auto-place runs; this strip shows holds/approvals even before a fill row. */
  const engine = usePoll(() => api.shadowDecisions('all', 25), { intervalMs: 10000 });
  const rows = data?.trades ?? [];
  const engineRows = engine.data?.decisions ?? [];
  const isAdmin = user?.role === 'admin';

  /** Asks Kalshi whether any held market has resolved, and books the result. */
  const settleNow = async () => {
    setSettling(true);
    try {
      const r = await api.reconcileTrades();
      await refresh({ quiet: true });
      const n = r.settlement?.settled ?? 0;
      toast(n ? 'Positions settled' : 'Nothing to settle',
        n ? `${n} position${n === 1 ? '' : 's'} booked against the Kalshi result.`
          : `Checked ${r.settlement?.checked ?? 0} open position(s); none have resolved yet.`,
        n ? 'tup' : '');
    } catch (e) {
      toast('Settlement failed', e.message, 'tdown');
    } finally {
      setSettling(false);
    }
  };

  /* Closing sells real contracts at the current bid, so the click goes
     through a confirmation first — the barrier the client asked for between
     a tap and money moving. */
  const [confirmClose, setConfirmClose] = useState(null);

  const close = async t => {
    setClosing(t.id);
    try {
      const r = await api.closePosition(t.id);
      await refresh({ quiet: true });
      toast('Position closed', r.message, 'tup');
    } catch (e) {
      toast('Could not close', e.message, 'tdown');
    } finally {
      setClosing(null);
      setConfirmClose(null);
    }
  };

  /* Only offer Sell early while the position is truly live. Once Kalshi (or our
     markets table) has yes/no, settle books WON/LOST — Sell early on a finished
     match was the Lopez Montagud bug. */
  const canSellEarly = t => ['filled', 'partial'].includes(t.status)
    && !t.result
    && t.market_result !== 'yes'
    && t.market_result !== 'no';
  const awaitingSettle = t => ['filled', 'partial'].includes(t.status)
    && !t.result
    && (t.market_result === 'yes' || t.market_result === 'no');

  return (
    <div className="animate-page-in">
      <PageHead
        title="Trade history"
        sub="Paper/live fills from auto-place · engine decisions refresh below every few seconds"
        action={
          <div className="flex gap-2 items-center flex-wrap max-sm:w-full">
            {FILTERS.map(([id, label]) => (
              <ChipBtn key={id} on={filter === id} onClick={() => setFilter(id)}>{label}</ChipBtn>
            ))}
            {isAdmin && (
              <button className="btn btn-ghost btn-sm ml-1" onClick={settleNow} disabled={settling}>
                {settling ? 'Settling…' : 'Settle now'}
              </button>
            )}
          </div>
        }
      />

      {error && <ErrorBox error={error} />}

      {engineRows.length > 0 && (
        <div className="bg-panel border border-line rounded-card overflow-hidden mb-5.5">
          <div className="px-4 py-3 border-b border-line text-[12.5px] text-muted">
            <span className="text-text font-semibold">Latest engine activity</span>
            {' '}(approvals + holds · newest first — also on Shadow desk)
          </div>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th><th>Player</th><th>Ask</th><th>Δ</th><th>Decision</th><th>Why</th>
                </tr>
              </thead>
              <tbody>
                {engineRows.slice(0, 12).map((d, i) => (
                  <tr key={`${d.ticker}-${d.created_at}-${i}`}>
                    <td className="font-mono text-muted whitespace-nowrap">{fmtTime(d.created_at)}</td>
                    <td>
                      <div className="font-semibold text-[13px]">{d.player_name}</div>
                      {d.opponent_name && (
                        <div className="text-[11px] text-muted2 font-mono">vs {d.opponent_name}</div>
                      )}
                    </td>
                    <td className="font-mono">{d.best_ask_cents != null ? `${d.best_ask_cents}¢` : '—'}</td>
                    <td className="font-mono text-ace">{d.utr_gap != null ? `Δ ${d.utr_gap}` : '—'}</td>
                    <td>
                      {d.approved
                        ? <Tag className="bg-up/12 text-up">APPROVED</Tag>
                        : <Tag className="bg-amber/15 text-amber">HELD</Tag>}
                    </td>
                    <td className="text-[12px] text-muted max-w-[280px]">
                      {d.approved
                        ? (d.stake_usd != null ? `${fmtUsd(d.stake_usd)} · ${d.contracts ?? '—'}c` : 'placed')
                        : (d.limiting_constraint || d.rejection_reason || '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-panel border border-line rounded-card overflow-hidden mb-5.5">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Placed</th><th>Mode</th><th>Player</th><th>Side</th><th>Entry</th><th>Fair</th>
                <th>Size</th><th>Stake</th><th>Exit</th><th>Status</th><th>Result</th><th>P&amp;L</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map(t => {
                const [cls, label] = STATUS_TAG[t.status] ?? ['bg-muted/12 text-muted', t.status.toUpperCase()];
                return (
                  <tr key={t.id} title={t.error ?? undefined}>
                    <td className="font-mono text-muted">{fmtTime(t.placed_at)}</td>
                    <td>
                      {t.mode === 'paper'
                        ? <Tag className="bg-amber/15 text-amber">PAPER</Tag>
                        : <Tag className="bg-ace-dim text-ace">LIVE</Tag>}
                    </td>
                    <td>
                      <div className="font-semibold text-[13.5px]">{t.player_name ?? t.ticker}</div>
                      {t.matchup && <div className="text-[11.5px] text-muted2 font-mono mt-0.5">{t.matchup}</div>}
                      {t.sizing_note && /faulty_era|alert_path/i.test(t.sizing_note) && (
                        <span title={t.sizing_note} className="inline-block mt-1">
                          <Tag className="bg-amber/15 text-amber">FAULTY ERA · charted as $20</Tag>
                        </span>
                      )}
                    </td>
                    <td><Tag className="bg-up/12 text-up">{t.side.toUpperCase()}</Tag></td>
                    <td className="font-mono font-semibold">{t.entry_cents != null ? `${t.entry_cents}¢` : '—'}</td>
                    <td className="font-mono font-semibold text-ace">{t.fair_cents != null ? `${t.fair_cents}¢` : '—'}</td>
                    <td className="font-mono">{t.size_contracts ?? '—'}</td>
                    <td className="font-mono">
                      {fmtUsd(t.stake_usd)}
                      {t.reporting_stake_usd != null && Number(t.reporting_stake_usd) !== Number(t.stake_usd) && (
                        <div className="text-[10.5px] text-muted2">desk {fmtUsd(t.reporting_stake_usd)}</div>
                      )}
                    </td>
                    <td className="font-mono">{t.exit_cents != null ? `${t.exit_cents}¢` : '—'}</td>
                    <td><Tag className={cls}>{label}</Tag></td>
                    <td>
                      {t.result === 'won' && <Tag className="bg-up/12 text-up">WON</Tag>}
                      {t.result === 'lost' && <Tag className="bg-down/15 text-down">LOST</Tag>}
                      {t.result === 'void' && <Tag className="bg-muted/12 text-muted">VOID</Tag>}
                      {!t.result && <span className="text-muted2">—</span>}
                    </td>
                    <td className={`font-mono font-semibold ${
                      Number(t.desk_pnl_usd ?? t.pnl_usd) > 0 ? 'text-up'
                        : Number(t.desk_pnl_usd ?? t.pnl_usd) < 0 ? 'text-down' : ''
                    }`}>
                      {t.status === 'settled'
                        ? fmtUsd(t.desk_pnl_usd ?? t.pnl_usd, { sign: true })
                        : '—'}
                    </td>
                    <td>
                      {canSellEarly(t) && (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => setConfirmClose(t)}
                          disabled={closing === t.id}
                          title="Optional early exit — sell at the current bid. Finished matches settle on their own (WON/LOST)."
                        >
                          {closing === t.id ? 'Selling…' : 'Sell early'}
                        </button>
                      )}
                      {awaitingSettle(t) && (
                        <Tag className="bg-amber/15 text-amber">BOOKING P&L</Tag>
                      )}
                      {t.exit_reason === 'auto_fair_value' && (
                        <Tag className="bg-ace-dim text-ace">AUTO</Tag>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!rows.length && (loading
          ? <Loading label="Loading ledger…" />
          : <Empty icon="📓" title="No fills in the ledger yet">
              Auto-place writes paper/live fills here when the engine approves. Holds and near-misses
              show in Latest engine activity above and on the Shadow desk.
            </Empty>)}
      </div>

      <ConfirmDialog
        open={Boolean(confirmClose)}
        title="Sell this position early?"
        message="Optional early exit at the current bid. Finished matches do not need this — they book WON/LOST automatically once Kalshi resolves."
        rows={confirmClose ? [
          ['Player', confirmClose.player_name ?? confirmClose.ticker],
          ['Size', `${confirmClose.size_contracts ?? '—'} contracts`],
          ['Entry', confirmClose.entry_cents != null ? `${confirmClose.entry_cents}¢` : '—'],
          ['Stake', fmtUsd(confirmClose.stake_usd)],
          ['Mode', confirmClose.mode === 'paper' ? 'Paper' : 'Live', confirmClose.mode === 'paper' ? 'text-amber' : 'text-ace'],
        ] : []}
        confirmLabel="Sell at bid"
        busy={Boolean(closing)}
        onClose={() => setConfirmClose(null)}
        onConfirm={() => close(confirmClose)}
      />
    </div>
  );
}
