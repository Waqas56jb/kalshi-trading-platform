import { useEffect, useState } from 'react';
import { Panel, Tag } from '../../common';
import { api, fmtNum } from '../../../lib/api';

const RANGES = [
  ['day', 'Today'],
  ['week', 'This week'],
  ['month', '30 days'],
  ['season', '180 days'],
  ['all', 'Everything'],
];

/**
 * Downloads the settled-match dataset for model training.
 *
 * The summary is shown before the buttons on purpose. An export that quietly
 * contains eleven rows, or every row from one side of the draw, is worse than no
 * export at all, so the row count, class balance and rating coverage are stated
 * up front and refresh as the range changes.
 */
export function DatasetExport() {
  const [range, setRange] = useState('week');
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let live = true;
    setSummary(null);
    setDone(null);
    api.datasetSummary(range)
      .then(r => { if (live) setSummary(r.summary); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [range]);

  const save = async format => {
    setBusy(format);
    setError(null);
    setDone(null);
    try {
      const bytes = await api.datasetExport(range, format);
      setDone(`Saved ${format.toUpperCase()} · ${(bytes / 1024).toFixed(0)} KB`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const empty = summary && summary.rows === 0;

  return (
    <Panel
      title="Training dataset"
      tools={RANGES.map(([key, label]) => (
        <button
          key={key}
          onClick={() => setRange(key)}
          className={`btn btn-sm ${range === key ? 'btn-ace' : ''}`}
        >
          {label}
        </button>
      ))}
    >
      <div className="text-muted text-[13px] mb-4">
        Settled matches with the outcome attached, for model training.
      </div>

      {summary ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Stat label="Rows" value={fmtNum(summary.rows)} sub={`${fmtNum(summary.matches)} matches`} />
          <Stat
            label="Win / lose"
            value={`${fmtNum(summary.wins)} / ${fmtNum(summary.losses)}`}
            sub={`balance ${summary.class_balance ?? '—'}`}
          />
          <Stat
            label="Both UTRs known"
            value={summary.rows ? `${Math.round((summary.complete_utr_pairs / summary.rows) * 100)}%` : '—'}
            sub={`${fmtNum(summary.complete_utr_pairs)} rows`}
          />
          <Stat
            label="Features"
            value={summary.feature_columns}
            sub={`target: ${summary.target}`}
          />
        </div>
      ) : (
        <div className="text-muted text-[13px] mb-4">Counting settled matches…</div>
      )}

      {summary?.first_match && (
        <div className="text-muted text-[12.5px] mb-4">
          Covers {summary.first_match} → {summary.last_match} · every match appears twice,
          once per player, so the two rows carry opposite labels.
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <button
          className="btn btn-ace btn-sm"
          disabled={busy != null || empty}
          onClick={() => save('csv')}
        >
          {busy === 'csv' ? 'Preparing…' : 'Download CSV'}
        </button>
        <button
          className="btn btn-sm"
          disabled={busy != null || empty}
          onClick={() => save('xlsx')}
        >
          {busy === 'xlsx' ? 'Preparing…' : 'Download Excel'}
        </button>
        {done && <Tag className="bg-ace/15 text-ace">{done}</Tag>}
        {empty && <span className="text-muted text-[13px]">No settled matches in this range yet.</span>}
      </div>

      {error && <div className="text-danger text-[13px] mt-3">{error}</div>}

      <div className="text-muted text-[12px] mt-4 leading-relaxed">
        <strong className="text-ink">Before training:</strong> the three
        {' '}<code>final_*</code> columns are the quote after the match settled, so they give the
        answer away — drop them. Everything prefixed <code>prematch_</code>, <code>open_</code>,
        {' '}<code>utr_</code> or <code>model_</code> was recorded at least three hours before the
        market closed and is safe. The target is <code>won</code> (1 = this player won).
      </div>
    </Panel>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2 min-w-0">
      <div className="text-muted text-[11.5px] uppercase tracking-wide truncate">{label}</div>
      <div className="font-display text-lg font-bold truncate">{value}</div>
      {sub && <div className="text-muted text-[11.5px] truncate">{sub}</div>}
    </div>
  );
}
