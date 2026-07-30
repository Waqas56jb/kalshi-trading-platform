import { useEffect, useRef, useState } from 'react';
import { CourtLines, Logo } from './common';
import { IconArrow } from './Icons';

export default function Login({ onSubmit, onBack }) {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const emailRef = useRef(null);

  useEffect(() => {
    const id = setTimeout(() => emailRef.current?.focus(), 300);
    return () => clearTimeout(id);
  }, []);

  const fail = msg => {
    setError(msg);
    setShake(true);
    setTimeout(() => setShake(false), 450);
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (!email.trim() || !pass) {
      fail('Enter your email and password to continue.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ email: email.trim(), password: pass });
    } catch (e) {
      fail(e.status === 0
        ? 'Cannot reach the server. Check your connection and try again.'
        : e.message);
      setPass('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="animate-view-in">
      <div className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden">
        <CourtLines className="opacity-35" full={false} />
        <div
          className={`relative w-full max-w-[420px] bg-[linear-gradient(165deg,var(--color-panel2),var(--color-panel))]
                      border border-line2 rounded-[22px] pt-10.5 px-9.5 pb-10.5 shadow-soft animate-login-in
                      ${shake ? 'animate-shake' : ''}`}
        >
          <Logo className="justify-center mb-2" href="#" onClick={e => { e.preventDefault(); onBack(); }} />
          <h2 className="font-display text-[22px] font-extrabold text-center mb-1.5">Terminal access</h2>
          <p className="text-center text-muted text-[13.5px] mb-7.5">Sign in to your trading desk</p>

          {error && (
            <div
              role="alert"
              className="mb-5 rounded-[11px] border border-down/40 bg-down/10 px-3.5 py-2.5 text-[13px] text-down"
            >
              {error}
            </div>
          )}

          <form onSubmit={e => { e.preventDefault(); submit(); }}>
            <div className="fld mb-4.5">
              <Label htmlFor="email">Email</Label>
              <input
                ref={emailRef} id="email" name="email" type="email" autoComplete="username"
                placeholder="you@example.com"
                value={email} onChange={e => setEmail(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="fld mb-4.5">
              <Label htmlFor="pass">Password</Label>
              <input
                id="pass" name="password" type="password" autoComplete="current-password"
                placeholder="••••••••••"
                value={pass} onChange={e => setPass(e.target.value)}
                disabled={busy}
              />
            </div>

            <button
              type="submit"
              className="btn btn-ace w-full justify-center py-3.5 text-[15px] mt-1.5"
              disabled={busy}
            >
              {busy ? 'Signing in…' : <>Enter the terminal <IconArrow /></>}
            </button>
          </form>

          <div className="flex justify-between text-[13px] text-muted mt-5">
            <span className="text-muted2">Accounts are created by an administrator</span>
            <a href="#" onClick={e => { e.preventDefault(); onBack(); }} className="hover:text-ace shrink-0">
              ← Back to site
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

const Label = ({ children, htmlFor }) => (
  <label htmlFor={htmlFor} className="block text-xs font-semibold tracking-[.05em] uppercase text-muted mb-2">
    {children}
  </label>
);
