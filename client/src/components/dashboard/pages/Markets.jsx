import { useState } from 'react';
import { ChipBtn, StatusTag, Tag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { api, DESK_TZ, fmtMatchTime, fmtNum, fmtPct, localZone } from '../../../lib/api';
import { PageHead } from '../PageHead';
import { Empty, ErrorBox, Loading } from '../Notices';

/* Upcoming first and selected by default: the trader's words were "I don't get
   mistaken by matches that have already happened". */
const FILTERS = [['upcoming', 'Upcoming'], ['mispriced', 'Mispriced'],
  ['underdog', 'Underdogs'], ['favourite', 'Favourites'],
  ['inplay', 'In play'], ['all', 'All']];
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
/**
 * Match day plus whether play has begun.
 *
 * Kalshi publishes no start time, so instead of showing a clock it cannot support,
 * the desk reports what it can actually establish: the day, from the ticker, and
 * the play state, inferred from the order book. Measured on live data, markets in
 * play had grown tens of thousands of contracts of volume over three hours while
 * markets yet to start had grown none.
 */
function StartCell({ matchDate, playState, volumeGrowth }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: DESK_TZ });
  const day = matchDate ? String(matchDate).slice(0, 10) : null;
  const dayLabel = !day ? 'date unknown'
    : day === today ? 'Today'
    : day < today ? 'Past'
    : new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US',
        { month: 'short', day: 'numeric', timeZone: 'UTC' });

  const state = {
    not_started: ['Not started', 'text-up'],
    in_play: ['In play', 'text-down'],
    unknown: ['State unknown', 'text-muted2'],
  }[playState] ?? ['State unknown', 'text-muted2'];

  return (
    <span title={volumeGrowth != null
      ? `${Math.round(volumeGrowth).toLocaleString()} contracts traded in the last 3h`
      : undefined}>
      <span className={day && day < today ? 'text-down' : 'text-text'}>{dayLabel}</span>
      <span className={`block text-[10.5px] ${state[1]}`}>{state[0]}</span>
    </span>
  );
}

export default function Markets({ search, onTrade }) {
  const [filter, setFilter] = useState('upcoming');
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
          ? `${rows.length} ${filter === 'upcoming' ? 'yet to start' : 'shown'} · `
            + `${count.total} open ITF markets · ${count.priced} priced · ${localZone()}`
          : 'Streaming from the Kalshi Trade API'}
        action={
          <div className="flex gap-2 items-center flex-wrap max-sm:w-full">
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
        <b className="text-text">Kalshi does not publish match start times</b> — its timestamp is an
        expiry estimate that read 18:00 on a match which actually began at 13:27. Rather than show a
        clock time it cannot support, the desk reports the match day (from the ticker, reliable) and
        whether play has begun, read from the order book: a market in play trades thousands of
        contracts an hour, one yet to start trades almost none. Hover a row for its 3h volume.
        Exact clock times need a schedule feed — Sofascore and the ITF site both block server
        requests, so that means a data provider with an API.
      </div>

      <div className="bg-panel border border-line rounded-card overflow-hidden mb-5.5">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Player / match</th><th>Day / state</th><th>UTR</th><th>Δ</th><th>Fair</th>
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
                    <StartCell matchDate={m.match_date} playState={m.play_state} volumeGrowth={m.volume_growth_3h} />
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
                  <td>
                    <div className="flex flex-col gap-1 items-start">
                      <StatusTag m={m} />
                      {m.side_type === 'favourite' && <Tag className="bg-ace-dim text-ace">FAV</Tag>}
                      {m.side_type === 'underdog' && <Tag className="bg-amber/15 text-amber">DOG</Tag>}
                    </div>
                  </td>
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
