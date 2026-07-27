import { useState } from 'react';
import { ChipBtn, StatusTag } from '../../common';
import { PageHead } from '../PageHead';

const FILTERS = [['all', 'All'], ['hot', 'Mispriced'], ['live', 'In play']];

export default function Markets({ matches, query, flash, onTrade }) {
  const [filter, setFilter] = useState('all');
  const q = query.toLowerCase();

  const rows = matches
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => {
      if (filter === 'hot' && !m.hot) return false;
      if (filter === 'live' && !m.live) return false;
      if (q && !(m.p + m.t).toLowerCase().includes(q)) return false;
      return true;
    });

  return (
    <div className="animate-page-in">
      <PageHead
        title="Live markets"
        sub={`${rows.length} ITF markets · streaming via Kalshi WebSocket`}
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
              <tr><th>Match</th><th>UTR</th><th>Δ</th><th>Fair</th><th>Market</th><th>EV</th><th>Vol</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map(({ m, i }) => (
                <tr key={m.p}>
                  <td>
                    <div className="font-semibold text-[13.5px]">{m.p}</div>
                    <div className="text-[11.5px] text-muted2 font-mono mt-0.5">{m.t}</div>
                  </td>
                  <td className="font-mono font-semibold">{m.u1} · {m.u2}</td>
                  <td className="font-mono font-semibold text-ace">Δ {m.gap}</td>
                  <td className="font-mono font-semibold">{m.fair}¢</td>
                  <td
                    key={`${i}-${flash[i]?.seq ?? 0}`}
                    className={`font-mono font-bold transition-colors duration-300 ${
                      flash[i]?.dir === 'up' ? 'animate-flash-up' : flash[i]?.dir === 'down' ? 'animate-flash-down' : ''
                    }`}
                  >
                    {m.mkt}¢
                  </td>
                  <td className={`font-mono font-semibold ${m.ev > 0 ? 'text-up font-bold' : 'text-muted2'}`}>
                    {m.ev > 0 ? '+' : ''}{m.ev}%
                  </td>
                  <td className="font-mono font-semibold text-muted">{m.vol.toLocaleString()}</td>
                  <td><StatusTag m={m} /></td>
                  <td>{m.hot && <button className="btn btn-up btn-sm" onClick={() => onTrade(m)}>Trade</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
