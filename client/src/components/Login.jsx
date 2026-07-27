import { useEffect, useRef, useState } from 'react';
import { CourtLines, Logo } from './common';
import { IconArrow } from './Icons';

export default function Login({ onSubmit, onBack }) {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [shake, setShake] = useState(false);
  const emailRef = useRef(null);

  useEffect(() => {
    const id = setTimeout(() => emailRef.current?.focus(), 300);
    return () => clearTimeout(id);
  }, []);

  const submit = () => {
    if (!email.trim() || !pass) {
      setShake(true);
      setTimeout(() => setShake(false), 450);
      onSubmit(null);
      return;
    }
    onSubmit({ email: email.trim(), pass });
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

          <div className="fld mb-4.5">
            <Label htmlFor="email">Email</Label>
            <input
              ref={emailRef} id="email" type="email" placeholder="trader@courtedge.io" autoComplete="off"
              value={email} onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div className="fld mb-4.5">
            <Label htmlFor="pass">Password</Label>
            <input
              id="pass" type="password" placeholder="••••••••••"
              value={pass} onChange={e => setPass(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            />
          </div>

          <button className="btn btn-ace w-full justify-center py-3.5 text-[15px] mt-1.5" onClick={submit}>
            Enter the terminal <IconArrow />
          </button>

          <div className="flex justify-between text-[13px] text-muted mt-5">
            <a href="#" onClick={e => e.preventDefault()} className="hover:text-ace">Forgot password?</a>
            <a href="#" onClick={e => { e.preventDefault(); onBack(); }} className="hover:text-ace">← Back to site</a>
          </div>

          <div className="mt-5.5 text-center font-mono text-xs text-muted2 bg-bg2 border border-dashed border-line2 p-2.5 rounded-[10px]">
            Demo mode — any email &amp; password works. Try <b className="text-ace">demo@courtedge.io</b>
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
