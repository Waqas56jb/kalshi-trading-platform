import { useEffect, useState } from 'react';
import { ChipBtn, Panel, Tag } from '../../common';
import { api } from '../../../lib/api';
import { ModelPanel } from './ModelPanel';
import { useToast } from '../../Toasts';
import { PageHead } from '../PageHead';
import { ErrorBox, Loading } from '../Notices';
import { MyAccountPanel, TeamPanel } from './AccountPanels';




/* Liquidity and sanity guards. Without these the actionable queue fills with
   decided matches: a 0/1c quote against a strong favourite is what a withdrawal
   looks like, and no ratings model can see one. */


export default function Settings({ state, user, onUserChange }) {
  const toast = useToast();
  const saved = state.data?.settings ?? null;
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('strategy');

  useEffect(() => { if (saved && !form) setForm(saved); }, [saved, form]);

  if (state.error) return <ErrorBox error={state.error} onRetry={state.refresh} />;
  if (!form) return <Loading label="Loading settings…" />;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const dirty = saved && Object.keys(form).some(k => String(form[k]) !== String(saved[k]));

  const save = async () => {
    setSaving(true);
    try {
      /* Only capital and mode. Every threshold this page used to send is now
         measured from settled results, so writing one here would be overruling
         the engine by hand — which is precisely what the client asked to make
         impossible. */
      const patch = {
        simulated_bankroll_usd: Number(form.simulated_bankroll_usd),
        minimum_free_cash_fraction: Number(form.minimum_free_cash_fraction),
        shadow_mode: form.shadow_mode !== false,
        shadow_auto_place: form.shadow_auto_place !== false,
        cross_market_enabled: form.cross_market_enabled === true,
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

  const isAdmin = user?.role === 'admin';

  return (
    <div className="animate-page-in">
      <PageHead
        title="Settings"
        sub={tab === 'strategy' ? 'How much capital the desk may use. The engine works out the rest.'
          : tab === 'model' ? 'Measured from settled matches. Read-only by design.'
          : 'Your account and desk access'}
        action={tab === 'strategy' && (
          <button className="btn btn-ace btn-sm" onClick={save} disabled={saving || !dirty || !isAdmin}>
            {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
        )}
      />

      <div className="flex gap-2 mb-5.5">
        <ChipBtn on={tab === 'strategy'} onClick={() => setTab('strategy')}>Bankroll</ChipBtn>
        <ChipBtn on={tab === 'model'} onClick={() => setTab('model')}>What the model works out</ChipBtn>
        <ChipBtn on={tab === 'account'} onClick={() => setTab('account')}>
          {isAdmin ? 'Account & team' : 'My account'}
        </ChipBtn>
      </div>

      {tab === 'model' && (
        <>
          <div className="text-muted text-[13px] mb-5">
            These are derived from settled results, not typed in. They refresh on every sync
            and cannot be edited — a box beside a number the algorithm computes is just an
            invitation to overrule it by hand.
          </div>
          <ModelPanel />
        </>
      )}

      {tab === 'account' && (
        <>
          <MyAccountPanel user={user} onUserChange={onUserChange} />
          {isAdmin && <TeamPanel user={user} />}
          {!isAdmin && (
            <Panel title="Desk accounts">
              <p className="text-[13px] text-muted">
                Only administrators can add or remove accounts. Ask an administrator if you need
                another sign-in created.
              </p>
            </Panel>
          )}
        </>
      )}

      {tab === 'strategy' && (
        <>
          {!isAdmin && (
            <div className="mb-5 rounded-card border border-line2 bg-panel p-4 text-[13px] text-muted">
              These are read-only for traders — an administrator changes them.
            </div>
          )}

          <div className="mb-5 text-[13px] text-muted">
            The only numbers left here are the ones no algorithm can settle for you: how much
            capital the desk may put at risk. Every threshold that used to live on this page —
            edge floors, the UTR gap, exposure caps, the minimum price — is now measured from
            settled results and shown, read-only, under{' '}
            <strong className="text-ink">What the model works out</strong>.
          </div>

          <Panel title="Capital">
            <div className="fld mb-4.5">
              <Label>Bankroll ($)</Label>
              <input
                type="number" min="100" step="100"
                value={form.simulated_bankroll_usd ?? ''}
                onChange={e => set('simulated_bankroll_usd', e.target.value)}
              />
              <p className="text-[11.5px] text-muted2 mt-2 font-mono">
                What the desk sizes against. No real money moves while shadow mode is on.
              </p>
            </div>

            <div className="fld mb-4.5">
              <Label>Cash reserve — never deployed</Label>
              <div className="slider-row flex items-center gap-4">
                <input
                  type="range" min="0" max="95" step="5"
                  value={Math.round(Number(form.minimum_free_cash_fraction ?? 0.6) * 100)}
                  onChange={e => set('minimum_free_cash_fraction', Number(e.target.value) / 100)}
                />
                <span className="font-mono font-bold text-ace min-w-[64px] text-right text-[15px]">
                  {Math.round(Number(form.minimum_free_cash_fraction ?? 0.6) * 100)}%
                </span>
              </div>
              <p className="text-[11.5px] text-muted2 mt-2 font-mono">
                At 60%, a $10,000 bankroll leaves the engine $4,000 to size against.
              </p>
            </div>
          </Panel>

          <Panel title="Mode">
            {[
              ['shadow_mode', 'Shadow mode',
                'Evaluates and records every decision but sends no order to Kalshi. Turning this off commits real money.'],
              ['shadow_auto_place', 'Place trades automatically',
                'No pings to accept — the engine takes every position that clears its own rules.'],
              ['cross_market_enabled', 'Confirm against sportsbooks',
                'When books have a line they must agree Kalshi is mispriced (full stake). '
                + 'If ITF has no line yet, the engine can still enter at half stake.'],
            ].map(([key, label, help]) => (
              <label key={key} className="flex items-start gap-3 mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={key === 'cross_market_enabled'
                    ? form[key] === true
                    : form[key] !== false}
                  onChange={e => set(key, e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium">{label}</span>
                  <span className="block text-[11.5px] text-muted2 font-mono mt-1">{help}</span>
                </span>
              </label>
            ))}
          </Panel>
        </>
      )}
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
