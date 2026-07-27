import { useState } from 'react';
import { ChipBtn, Tag } from '../../common';
import { PageHead } from '../PageHead';

const FILTERS = [['all', 'All'], ['won', 'Won'], ['lost', 'Lost'], ['open', 'Open']];

export default function Trades({ trades }) {
  const [filter, setFilter] = useState('all');
  const rows = trades.filter(t => filter === 'all' || t.res === filter);

  return (
    <div className="animate-page-in">
      <PageHead
        title="Trade history"
        sub="Every execution, fill and settlement on this desk"
        action={
          <div className="flex gap-2">
            {FILTERS.map(([id, label]) => (
              <ChipBtn key={id} on={filter === id} onClick={() => setFilter(id)}>{label}</ChipBtn>
            ))}
          </div>
        }
      />
      <div className="bg-panel border border-line rounded-card overflow-hidden mb-5.5">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr><th>Time</th><th>Match</th><th>Side</th><th>Entry</th><th>Fair</th><th>Size</th><th>EV</th><th>Result</th><th>P&amp;L</th></tr>
            </thead>
            <tbody>
              {rows.map((t, i) => (
                <tr key={`${t.match}-${t.time}-${i}`}>
                  <td className="font-mono font-semibold text-muted">{t.time}</td>
                  <td><div className="font-semibold text-[13.5px]">{t.match}</div></td>
                  <td><Tag className="bg-up/12 text-up">{t.side}</Tag></td>
                  <td className="font-mono font-semibold">{t.entry}¢</td>
                  <td className="font-mono font-semibold text-ace">{t.fair}¢</td>
                  <td className="font-mono font-semibold">${t.size}</td>
                  <td className="font-mono font-bold text-up">+{t.ev}%</td>
                  <td>
                    {t.res === 'won' && <Tag className="bg-up/12 text-up">WON</Tag>}
                    {t.res === 'lost' && <Tag className="bg-down/15 text-down">LOST</Tag>}
                    {t.res === 'open' && <Tag className="bg-amber/15 text-amber">OPEN</Tag>}
                  </td>
                  <td className={`font-mono font-semibold ${t.pnl > 0 ? 'text-up' : t.pnl < 0 ? 'text-down' : ''}`}>
                    {t.res === 'open' ? '—' : t.pnl > 0 ? `+$${t.pnl}` : `-$${Math.abs(t.pnl)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
