import { useState } from 'react';
import { ChipBtn, StatusTag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { api, fmtNum, fmtPct } from '../../../lib/api';
import { PageHead } from '../PageHead';
import { Empty, ErrorBox, Loading } from '../Notices';

const FILTERS = [['all', 'All'], ['mispriced', 'Mispriced'], ['rated', 'Priced'], ['inplay', 'In play']];

export default function Markets({ search, onTrade }) {
  const [filter, setFilter] = useState('all');
  const { data, error, loading } = usePoll(
    () => api.markets({ filter, search, limit: 300 }),
    { intervalMs: 12000, deps: [filter, search] },
  );

  const rows = data?.markets ?? [];
  const count = data?.count ?? null;

  return (
    <div className="animate-page-in">
      <PageHead
        title="Live markets"
        sub={count
          ? `${rows.length} shown · ${count.total} open ITF markets · ${count.priced} priced by the UTR model`
          : 'Streaming from the Kalshi Trade API'}
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
                <th>Player / match</th><th>UTR</th><th>Δ</th><th>Fair</th>
                <th>Bid</th><th>Ask</th><th>Edge</th><th>EV</th><th>Vol</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(m => (
                <tr key={m.ticker}>
                  <td>
                    <div className="font-semibold text-[13.5px]">{m.player_name}</div>
                    <div className="text-[11.5px] text-muted2 font-mono mt-0.5">
                      {m.matchup}{m.tournament ? ` · ${m.tournament}` : ''}
                    </div>
                  </td>
                  <td className="font-mono font-semibold">
                    {m.player_utr != null
                      ? `${m.player_utr}${m.opponent_utr != null ? ` · ${m.opponent_utr}` : ''}`
                      : <span className="text-muted2">unrated</span>}
                  </td>
                  <td className="font-mono font-semibold text-ace">
                    {m.utr_gap != null ? `Δ ${m.utr_gap}` : '—'}
                  </td>
                  <td className="font-mono font-semibold">{m.fair_cents != null ? `${m.fair_cents}¢` : '—'}</td>
                  <td className="font-mono text-muted">{m.yes_bid_cents != null ? `${m.yes_bid_cents}¢` : '—'}</td>
                  <td className="font-mono font-bold">{m.yes_ask_cents != null ? `${m.yes_ask_cents}¢` : '—'}</td>
                  <td className={`font-mono font-bold ${
                    m.edge_cents == null ? 'text-muted2' : m.edge_cents > 0 ? 'text-ace' : 'text-muted2'
                  }`}>
                    {m.edge_cents != null ? `${m.edge_cents > 0 ? '+' : ''}${m.edge_cents}¢` : '—'}
                  </td>
                  <td className={`font-mono font-semibold ${
                    m.ev_pct == null ? 'text-muted2' : m.ev_pct > 0 ? 'text-up font-bold' : 'text-muted2'
                  }`}>
                    {fmtPct(m.ev_pct)}
                  </td>
                  <td className="font-mono text-muted">{fmtNum(m.volume)}</td>
                  <td><StatusTag m={m} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!rows.length && (loading
          ? <Loading label="Loading live markets…" />
          : <Empty icon="🎾" title="No markets match this filter">
              {search ? `Nothing matches “${search}”.` : 'Try a different filter.'}
            </Empty>)}
      </div>
    </div>
  );
}
