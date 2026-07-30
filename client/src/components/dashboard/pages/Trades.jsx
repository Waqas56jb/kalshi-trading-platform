import { useState } from 'react';
import { ChipBtn, Tag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { api, fmtPct, fmtTime, fmtUsd } from '../../../lib/api';
import { PageHead } from '../PageHead';
import { Empty, ErrorBox, Loading } from '../Notices';

const FILTERS = [['all', 'All'], ['open', 'Open'], ['won', 'Won'], ['lost', 'Lost']];

const STATUS_TAG = {
  filled: ['bg-up/12 text-up', 'FILLED'],
  partial: ['bg-amber/15 text-amber', 'PARTIAL'],
  pending: ['bg-amber/15 text-amber', 'PENDING'],
  settled: ['bg-muted/12 text-muted', 'SETTLED'],
  cancelled: ['bg-muted/12 text-muted', 'CANCELLED'],
  failed: ['bg-down/15 text-down', 'FAILED'],
};

export default function Trades() {
  const [filter, setFilter] = useState('all');
  const { data, error, loading } = usePoll(() => api.trades(filter), {
    intervalMs: 15000, deps: [filter],
  });
  const rows = data?.trades ?? [];

  return (
    <div className="animate-page-in">
      <PageHead
        title="Trade history"
        sub="Every execution attempt, fill and settlement on this desk"
        action={
          <div className="flex gap-2">
            {FILTERS.map(([id, label]) => (
              <ChipBtn key={id} on={filter === id} onClick={() => setFilter(id)}>{label}</ChipBtn>
            ))}
          </div>
        }
      />

      {error && <ErrorBox error={error} />}

      <div className="bg-panel border border-line rounded-card overflow-hidden mb-5.5">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Placed</th><th>Player</th><th>Side</th><th>Entry</th><th>Fair</th>
                <th>Size</th><th>Stake</th><th>EV</th><th>Status</th><th>Result</th><th>P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(t => {
                const [cls, label] = STATUS_TAG[t.status] ?? ['bg-muted/12 text-muted', t.status.toUpperCase()];
                return (
                  <tr key={t.id} title={t.error ?? undefined}>
                    <td className="font-mono text-muted">{fmtTime(t.placed_at)}</td>
                    <td>
                      <div className="font-semibold text-[13.5px]">{t.player_name ?? t.ticker}</div>
                      {t.matchup && <div className="text-[11.5px] text-muted2 font-mono mt-0.5">{t.matchup}</div>}
                    </td>
                    <td><Tag className="bg-up/12 text-up">{t.side.toUpperCase()}</Tag></td>
                    <td className="font-mono font-semibold">{t.entry_cents != null ? `${t.entry_cents}¢` : '—'}</td>
                    <td className="font-mono font-semibold text-ace">{t.fair_cents != null ? `${t.fair_cents}¢` : '—'}</td>
                    <td className="font-mono">{t.size_contracts ?? '—'}</td>
                    <td className="font-mono">{fmtUsd(t.stake_usd)}</td>
                    <td className="font-mono font-bold text-up">{fmtPct(t.ev_pct)}</td>
                    <td><Tag className={cls}>{label}</Tag></td>
                    <td>
                      {t.result === 'won' && <Tag className="bg-up/12 text-up">WON</Tag>}
                      {t.result === 'lost' && <Tag className="bg-down/15 text-down">LOST</Tag>}
                      {t.result === 'void' && <Tag className="bg-muted/12 text-muted">VOID</Tag>}
                      {!t.result && <span className="text-muted2">—</span>}
                    </td>
                    <td className={`font-mono font-semibold ${
                      Number(t.pnl_usd) > 0 ? 'text-up' : Number(t.pnl_usd) < 0 ? 'text-down' : ''
                    }`}>
                      {t.status === 'settled' ? fmtUsd(t.pnl_usd, { sign: true }) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!rows.length && (loading
          ? <Loading label="Loading ledger…" />
          : <Empty icon="📓" title="No trades yet">
              Approve an alert to place your first order. Every attempt — including rejected ones —
              is recorded here.
            </Empty>)}
      </div>
    </div>
  );
}
