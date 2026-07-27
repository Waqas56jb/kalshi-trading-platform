import { useState } from 'react';
import { Panel, Tag } from '../../common';
import { PageHead } from '../PageHead';

const EXECUTION = [
  ['Manual approval required', 'Every order needs your tap before it fires', true],
  ['Sweep full volume at price', 'Capture all contracts at or better than EV price', true],
  ['Pushover alerts', 'Instant push to your phone on every edge', true],
  ['Twilio SMS fallback', 'SMS if push is not delivered in 5s', false],
  ['In-play markets', 'Also price matches that are live in play', true],
];

const KEYS = [
  ['Kalshi API key', 'kx_live_9f83hd93hd93h'],
  ['Kalshi API secret', 'secret_demo_value_123'],
  ['UTR session token', 'utr_tok_demo_88231'],
  ['Pushover user key', 'po_demo_key_5521'],
];

export default function Settings({ onSave }) {
  const [ev, setEv] = useState(8);
  const [toggles, setToggles] = useState(EXECUTION.map(r => r[2]));

  return (
    <div className="animate-page-in">
      <PageHead
        title="Settings"
        sub="Strategy, execution and connectivity"
        action={<button className="btn btn-ace btn-sm" onClick={onSave}>Save changes</button>}
      />

      <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
        <Panel title="Strategy">
          <div className="fld mb-4.5">
            <Label>Minimum EV threshold</Label>
            <div className="slider-row flex items-center gap-4">
              <input type="range" min="2" max="30" value={ev} onChange={e => setEv(+e.target.value)} />
              <span className="font-mono font-bold text-ace min-w-[64px] text-right text-[15px]">+{ev}%</span>
            </div>
          </div>
          <div className="fld mb-4.5">
            <Label>Stake per trade (USD)</Label>
            <input type="number" defaultValue={250} min="10" step="10" />
          </div>
          <div className="fld mb-4.5">
            <Label>Max exposure per match (USD)</Label>
            <input type="number" defaultValue={600} min="50" step="50" />
          </div>
          <div className="fld">
            <Label>UTR gap — minimum to price</Label>
            <select defaultValue="Δ 0.5">
              <option>Δ 0.3</option><option>Δ 0.5</option><option>Δ 1.0</option><option>Δ 2.0</option>
            </select>
          </div>
        </Panel>

        <Panel title="Execution & alerts">
          {EXECUTION.map(([t, d], i) => (
            <div key={t} className="flex items-center justify-between gap-3.5 py-[15px] border-b border-line last:border-b-0">
              <div>
                <div className="font-semibold text-sm">{t}</div>
                <div className="text-muted text-[12.5px] mt-0.5">{d}</div>
              </div>
              <button
                className={`tgl ${toggles[i] ? 'on' : ''}`}
                onClick={() => setToggles(v => v.map((x, j) => (j === i ? !x : x)))}
                aria-label={t}
              />
            </div>
          ))}
        </Panel>
      </div>

      <Panel
        title="API connectivity"
        tools={<Tag className="bg-up/12 text-up">ALL SYSTEMS GO</Tag>}
      >
        <div className="grid grid-cols-2 gap-5 max-[980px]:grid-cols-1">
          {KEYS.map(([label, val]) => (
            <div className="fld" key={label}>
              <Label>{label}</Label>
              <input type="password" defaultValue={val} />
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

const Label = ({ children }) => (
  <label className="block text-xs font-semibold tracking-[.05em] uppercase text-muted mb-2">{children}</label>
);
