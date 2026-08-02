import { useState } from 'react';
import { Panel, Tag } from '../../common';
import { usePoll } from '../../../hooks/useApi';
import { api, fmtTime } from '../../../lib/api';
import { setSession } from '../../../lib/auth';
import { useToast } from '../../Toasts';
import ConfirmDialog from '../ConfirmDialog';

const Label = ({ children, htmlFor }) => (
  <label htmlFor={htmlFor} className="block text-xs font-semibold tracking-[.05em] uppercase text-muted mb-2">
    {children}
  </label>
);

/** Change your own name, email or password. */
export function MyAccountPanel({ user, onUserChange }) {
  const toast = useToast();
  const [name, setName] = useState(user.name ?? '');
  const [email, setEmail] = useState(user.email ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== (user.email ?? '').toLowerCase();
  const nameChanged = (name.trim() || null) !== (user.name ?? null);
  const wantsPassword = Boolean(next || confirm);
  const dirty = emailChanged || nameChanged || wantsPassword;

  const save = async () => {
    if (wantsPassword && next !== confirm) {
      toast('Passwords do not match', 'Retype the new password.', 'tdown');
      return;
    }
    if ((emailChanged || wantsPassword) && !current) {
      toast('Current password required',
        'Confirm your current password to change your email or password.', 'tdown');
      return;
    }

    setBusy(true);
    try {
      const patch = { currentPassword: current || undefined };
      if (nameChanged) patch.name = name.trim();
      if (emailChanged) patch.email = email.trim();
      if (wantsPassword) patch.password = next;

      const r = await api.updateMe(patch);
      setSession(null, r.user);
      onUserChange(r.user);
      setCurrent(''); setNext(''); setConfirm('');
      toast('Account updated',
        wantsPassword ? 'Your password has been changed.' : 'Your details have been saved.', 'tup');
    } catch (e) {
      toast('Could not update', e.message, 'tdown');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="My account"
      tools={<Tag className={user.role === 'admin' ? 'bg-ace-dim text-ace' : 'bg-up/12 text-up'}>
        {user.role === 'admin' ? 'ADMINISTRATOR' : 'TRADER'}
      </Tag>}
    >
      <div className="fld mb-4.5">
        <Label htmlFor="acc-name">Display name</Label>
        <input id="acc-name" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
      </div>
      <div className="fld mb-4.5">
        <Label htmlFor="acc-email">Email</Label>
        <input id="acc-email" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" />
      </div>

      <div className="border-t border-line pt-4.5 mt-1">
        <div className="fld mb-4.5">
          <Label htmlFor="acc-cur">Current password</Label>
          <input
            id="acc-cur" type="password" value={current} onChange={e => setCurrent(e.target.value)}
            autoComplete="current-password" placeholder="required to change email or password"
          />
        </div>
        <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
          <div className="fld">
            <Label htmlFor="acc-new">New password</Label>
            <input
              id="acc-new" type="password" value={next} onChange={e => setNext(e.target.value)}
              autoComplete="new-password" placeholder="at least 8 characters"
            />
          </div>
          <div className="fld">
            <Label htmlFor="acc-conf">Repeat new password</Label>
            <input
              id="acc-conf" type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>
        {wantsPassword && next && confirm && next !== confirm && (
          <p className="text-[12.5px] text-down mt-2">Passwords do not match.</p>
        )}
      </div>

      <button className="btn btn-ace btn-sm mt-5" onClick={save} disabled={busy || !dirty}>
        {busy ? 'Saving…' : dirty ? 'Save account changes' : 'Saved'}
      </button>
    </Panel>
  );
}

/** Admin-only: list, create, enable/disable and remove desk accounts. */
export function TeamPanel({ user }) {
  const toast = useToast();
  const state = usePoll(() => api.users(), {});
  const [form, setForm] = useState({ email: '', password: '', name: '', role: 'trader' });
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState(null);
  const [resetPw, setResetPw] = useState('');
  const [deleteFor, setDeleteFor] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const users = state.data?.users ?? [];

  const create = async () => {
    setBusy(true);
    try {
      await api.createUser({
        email: form.email.trim(), password: form.password,
        name: form.name.trim() || undefined, role: form.role,
      });
      setForm({ email: '', password: '', name: '', role: 'trader' });
      await state.refresh({ quiet: true });
      toast('Account created', `${form.email.trim()} can now sign in.`, 'tup');
    } catch (e) {
      toast('Could not create account', e.message, 'tdown');
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn, okTitle, okMsg) => {
    try {
      await fn();
      await state.refresh({ quiet: true });
      toast(okTitle, okMsg, 'tup');
    } catch (e) {
      toast('Action failed', e.message, 'tdown');
    }
  };

  return (
    <>
      <Panel title="Desk accounts" tools={<Tag className="bg-white/6 text-muted">{users.length} TOTAL</Tag>} bodyClass="">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td className="font-semibold text-[13.5px]">
                    {u.email}
                    {u.id === user.id && <span className="ml-2 font-mono text-[10.5px] text-ace">you</span>}
                  </td>
                  <td className="text-muted">{u.name ?? '—'}</td>
                  <td>
                    <Tag className={u.role === 'admin' ? 'bg-ace-dim text-ace' : 'bg-up/12 text-up'}>
                      {u.role.toUpperCase()}
                    </Tag>
                  </td>
                  <td>
                    {u.is_active
                      ? <Tag className="bg-up/12 text-up">ACTIVE</Tag>
                      : <Tag className="bg-down/15 text-down">DISABLED</Tag>}
                  </td>
                  <td className="font-mono text-muted">{u.last_login_at ? fmtTime(u.last_login_at) : 'never'}</td>
                  <td>
                    <div className="flex gap-2 justify-end">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setResetFor(u); setResetPw(''); }}
                      >
                        Reset password
                      </button>
                      {u.id !== user.id && (
                        <>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => act(
                              () => api.updateUser(u.id, { role: u.role === 'admin' ? 'trader' : 'admin' }),
                              'Role changed', `${u.email} is now ${u.role === 'admin' ? 'a trader' : 'an administrator'}.`)}
                          >
                            {u.role === 'admin' ? 'Make trader' : 'Make admin'}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => act(
                              () => api.updateUser(u.id, { is_active: !u.is_active }),
                              u.is_active ? 'Account disabled' : 'Account enabled', u.email)}
                          >
                            {u.is_active ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => setDeleteFor(u)}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!users.length && (
                <tr><td colSpan={6} className="text-center text-muted py-8">
                  {state.loading ? 'Loading accounts…' : 'No accounts.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <ConfirmDialog
        open={Boolean(deleteFor)}
        title="Delete this account?"
        message="This removes the account and its access immediately. It cannot be undone."
        rows={deleteFor ? [
          ['Email', deleteFor.email],
          ['Name', deleteFor.name ?? '—'],
          ['Role', deleteFor.role.toUpperCase()],
        ] : []}
        confirmLabel="Delete account"
        busy={deleting}
        onClose={() => setDeleteFor(null)}
        onConfirm={async () => {
          setDeleting(true);
          try {
            await act(() => api.deleteUser(deleteFor.id), 'Account removed', deleteFor.email);
          } finally {
            setDeleting(false);
            setDeleteFor(null);
          }
        }}
      />

      {resetFor && (
        <Panel title={`Reset password — ${resetFor.email}`}>
          <div className="fld mb-4">
            <Label htmlFor="rst">New password</Label>
            <input
              id="rst" type="password" value={resetPw} onChange={e => setResetPw(e.target.value)}
              autoComplete="new-password" placeholder="at least 8 characters"
            />
          </div>
          <div className="flex gap-3">
            <button className="btn btn-ghost btn-sm" onClick={() => setResetFor(null)}>Cancel</button>
            <button
              className="btn btn-ace btn-sm"
              disabled={resetPw.length < 8}
              onClick={async () => {
                await act(() => api.updateUser(resetFor.id, { password: resetPw }),
                  'Password reset', `${resetFor.email} must use the new password.`);
                setResetFor(null); setResetPw('');
              }}
            >
              Set password
            </button>
          </div>
        </Panel>
      )}

      <Panel title="Add an account">
        <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
          <div className="fld">
            <Label htmlFor="nu-email">Email</Label>
            <input
              id="nu-email" type="email" value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="trader@example.com"
            />
          </div>
          <div className="fld">
            <Label htmlFor="nu-name">Display name</Label>
            <input
              id="nu-name" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="optional"
            />
          </div>
          <div className="fld">
            <Label htmlFor="nu-pw">Password</Label>
            <input
              id="nu-pw" type="password" value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              autoComplete="new-password" placeholder="at least 8 characters"
            />
          </div>
          <div className="fld">
            <Label htmlFor="nu-role">Role</Label>
            <select
              id="nu-role" value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
            >
              <option value="trader">Trader — can trade and change settings they own</option>
              <option value="admin">Administrator — can manage accounts and strategy</option>
            </select>
          </div>
        </div>
        <button
          className="btn btn-ace btn-sm mt-5"
          onClick={create}
          disabled={busy || !form.email.trim() || form.password.length < 8}
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <p className="text-[12.5px] text-muted mt-3">
          The password is hashed with scrypt before it is stored. Nobody, including an administrator,
          can read it back — use “Reset password” if it is forgotten.
        </p>
      </Panel>
    </>
  );
}
