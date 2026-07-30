import { useState } from 'react';
import { ChipBtn, StatusTag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { api, DESK_TZ, fmtMatchTime, fmtNum, fmtPct, localZone } from '../../../lib/api';
import { PageHead } from '../PageHead';
import { Empty, ErrorBox, Loading } from '../Notices';

const FILTERS = [['all', 'All'], ['mispriced', 'Mispriced'], ['rated', 'Priced'], ['inplay', 'Past days']];
const SORTS = [['edge', 'Edge'], ['starts', 'Start time'], ['ev', 'EV %']];

/**
 * Scheduled start plus how far away it is. Kalshi gives a half-hour slot rather
 * than a first-serve time, so a match may begin later than shown — the countdown
 * turns amber close to the slot and red once it has passed.
 */
/**
 * Match day, plus Kalshi's expiry estimate clearly labelled as such.
 *
 * Kalshi publishes no start time: its `occurrence_datetime` is identical to
 * `expected_expiration_time` and ran 4h33m past the real first serve on a checked
 * match. So the day — which the ticker gets right — is shown as the fact, and the
 * exchange's timestamp is shown only as an expiry estimate, never as a start.
 */
function StartCell({ matchDate, iso }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: DESK_TZ });
  const day = matchDate ? String(matchDate).slice(0, 10) : null;
  const label = !day ? 'date unknown'
    : day === today ? 'Today'
    : day < today ? 'Past'
    : new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US',
        { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <span title={iso ? `Kalshi expiry estimate: ${new Date(iso).toString()}` : undefined}>
      <span className={day && day < today ? 'text-down' : 'text-text'}>{label}</span>
      {iso && (
        <span className="block text-[9.5px] text-muted2">
          est. settle {fmtMatchTime(iso)}
        </span>
      )}
      <span className="block text-[9.5px] text-amber/70">start time n/a</span>
    </span>
  );
}

export default function Markets({ search, onTrade }) {
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('edge');
  const { data, error, loading } = usePoll(
    () => api.markets({ filter, search, limit: 300, sort }),
    { intervalMs: 12000, deps: [filter, search, sort] },
  );

  const rows = data?.markets ?? [];
  const count = data?.count ?? null;

  return (
    <div className="animate-page-in">
      <PageHead
        title="Live markets"
        sub={count
          ? `${rows.length} shown · ${count.total} open ITF markets · ${count.priced} priced · `
            + `${localZone()} — Kalshi publishes no start times, see note below`
          : 'Streaming from the Kalshi Trade API'}
        action={
          <div className="flex gap-2 items-center flex-wrap">
            {FILTERS.map(([id, label]) => (
              <ChipBtn key={id} on={filter === id} onClick={() => setFilter(id)}>{label}</ChipBtn>
            ))}
            <span className="text-[11px] text-muted2 font-mono ml-1 mr-0.5">sort</span>
            {SORTS.map(([id, label]) => (
              <ChipBtn key={id} on={sort === id} onClick={() => setSort(id)}>{label}</ChipBtn>
            ))}
          </div>
        }
      />

      {error && <ErrorBox error={error} />}

      <div className="mb-5 rounded-card border border-line2 bg-panel p-4 text-[12.5px] text-muted">
        <b className="text-text">Kalshi does not publish match start times.</b>{' '}
        Its timestamp is an expiry estimate — on a checked ITF match it read 18:00 while play
        actually began at 13:27. The match <i>day</i> comes from the ticker and is reliable; the clock
        time is not shown as a start. Pre-match alerting therefore relies on the day plus the book
        itself (an extreme or fast-moving quote means play has begun). Wiring a real schedule source
        would give exact times.
      </div>

      <div className="bg-panel border border-line rounded-card overflow-hidden mb-5.5">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Player / match</th><th>Match day</th><th>UTR</th><th>Δ</th><th>Fair</th>
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
                  <td className="font-mono whitespace-nowrap">
                    <StartCell matchDate={m.match_date} iso={m.occurrence_datetime} />
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
