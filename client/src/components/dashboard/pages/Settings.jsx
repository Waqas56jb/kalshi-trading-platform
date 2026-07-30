import { useEffect, useState } from 'react';
import { Panel, Tag } from '../../common';
import { api } from '../../../lib/api';
import { useToast } from '../../Toasts';
import { PageHead } from '../PageHead';
import { ErrorBox, Loading } from '../Notices';

const TOGGLES = [
  ['manual_approval', 'Manual approval required', 'Every order needs your tap before it fires'],
  ['sweep_full_volume', 'Sweep full volume at price', 'Cap size at the contracts available at the ask'],
  ['pushover_enabled', 'Pushover alerts', 'Instant push to your phone on every edge'],
  ['sms_fallback', 'Twilio SMS fallback', 'SMS if push is not delivered in 5s'],
  ['inplay_enabled', 'In-play markets', 'Also price matches that are already under way'],
];

const NUMBERS = [
  ['stake_per_trade', 'Stake per trade (USD)', 10, 10],
  ['max_exposure_per_match', 'Max exposure per match (USD)', 50, 50],
];

export default function Settings({ state }) {
  const toast = useToast();
  const saved = state.data?.settings ?? null;
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (saved && !form) setForm(saved); }, [saved, form]);

  if (state.error) return <ErrorBox error={state.error} onRetry={state.refresh} />;
  if (!form) return <Loading label="Loading settings…" />;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const dirty = saved && Object.keys(form).some(k => String(form[k]) !== String(saved[k]));

  const save = async () => {
    setSaving(true);
    try {
      const patch = {
        min_ev_threshold: Number(form.min_ev_threshold),
        min_utr_gap: Number(form.min_utr_gap),
        stake_per_trade: Number(form.stake_per_trade),
        max_exposure_per_match: Number(form.max_exposure_per_match),
        ...Object.fromEntries(TOGGLES.map(([k]) => [k, !!form[k]])),
      };
      const r = await api.saveSettings(patch);
      setForm(r.settings);
      await state.refresh({ quiet: true });
      toast('Settings saved', 'Applied to the live engine — next sync uses these values.', 'tup');
    } catch (e) {
      toast('Could not save', e.message, 'tdown');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="animate-page-in">
      <PageHead
        title="Settings"
        sub="Strategy, execution and connectivity"
        action={
          <button className="btn btn-ace btn-sm" onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
        <Panel title="Strategy">
          <div className="fld mb-4.5">
            <Label>Minimum EV threshold</Label>
            <div className="slider-row flex items-center gap-4">
              <input
                type="range" min="2" max="60" step="1"
                value={form.min_ev_threshold}
                onChange={e => set('min_ev_threshold', e.target.value)}
              />
              <span className="font-mono font-bold text-ace min-w-[64px] text-right text-[15px]">
                +{Number(form.min_ev_threshold).toFixed(0)}%
              </span>
            </div>
            <p className="text-[11.5px] text-muted2 mt-2 font-mono">
              Percentage EV inflates on cheap contracts — a 1¢ error on a 3¢ ask reads as +33%.
              Sort by the Edge column to judge in cents.
            </p>
          </div>

          <div className="fld mb-4.5">
            <Label>UTR gap — minimum to price</Label>
            <div className="slider-row flex items-center gap-4">
              <input
                type="range" min="0" max="3" step="0.1"
                value={form.min_utr_gap}
                onChange={e => set('min_utr_gap', e.target.value)}
              />
              <span className="font-mono font-bold text-ace min-w-[64px] text-right text-[15px]">
                Δ {Number(form.min_utr_gap).toFixed(1)}
              </span>
            </div>
          </div>

          {NUMBERS.map(([k, label, min, step]) => (
            <div className="fld mb-4.5" key={k}>
              <Label>{label}</Label>
              <input
                type="number" min={min} step={step}
                value={form[k]}
                onChange={e => set(k, e.target.value)}
              />
            </div>
          ))}
        </Panel>

        <Panel title="Execution & alerts">
          {TOGGLES.map(([k, title, desc]) => (
            <div key={k} className="flex items-center justify-between gap-3.5 py-[15px] border-b border-line last:border-b-0">
              <div>
                <div className="font-semibold text-sm">{title}</div>
                <div className="text-muted text-[12.5px] mt-0.5">{desc}</div>
              </div>
              <button
                className={`tgl ${form[k] ? 'on' : ''}`}
                onClick={() => set(k, !form[k])}
                aria-label={title}
              />
            </div>
          ))}
        </Panel>
      </div>

      <Panel
        title="Connectivity"
        tools={<ConnTag state={state} />}
      >
        <div className="grid grid-cols-2 gap-5 max-[980px]:grid-cols-1">
          <Info label="Series tracked" value={(form.series_tickers ?? []).join(', ') || '—'} />
          <Info label="Table prefix" value="kalshi_" />
          <Info
            label="Credentials"
            value="Server-side only — never sent to the browser"
          />
          <Info label="Last updated" value={new Date(form.updated_at).toLocaleString()} />
        </div>
        <p className="text-[12.5px] text-muted mt-4">
          API keys live in <span className="font-mono text-ace">server/.env</span> and are read only by the
          backend. This page cannot display or change them by design.
        </p>
      </Panel>
    </div>
  );
}

function ConnTag({ state }) {
  const ok = !state.error && state.data;
  return ok
    ? <Tag className="bg-up/12 text-up">API CONNECTED</Tag>
    : <Tag className="bg-down/15 text-down">API UNREACHABLE</Tag>;
}

const Label = ({ children }) => (
  <label className="block text-xs font-semibold tracking-[.05em] uppercase text-muted mb-2">{children}</label>
);

const Info = ({ label, value }) => (
  <div>
    <Label>{label}</Label>
    <div className="font-mono text-[13px] bg-bg2 border border-line2 rounded-[11px] px-[15px] py-[13px] text-muted">
      {value}
    </div>
  </div>
);
