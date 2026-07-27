import { Logo } from '../common';
import { useReveal, useScrolled } from '../../hooks/useUi';
import { IconActivity, IconBell, IconBolt, IconCheck, IconClock, IconLayout } from '../Icons';
import Hero from './Hero';

const FEATURES = [
  { Ic: IconActivity, h: 'Live market surveillance', p: 'WebSocket feed across every ITF market on Kalshi. Every tick, every book update, streamed in real time.' },
  { Ic: IconClock, h: 'UTR fair-value engine', p: 'Rating gaps mapped to win probability — Δ2.0 → 99%, Δ1.0 → 85–90%, Δ0.5 → 65% — repriced on every update.' },
  { Ic: IconBell, h: 'Instant mispricing alerts', p: 'Push notifications the moment market price drifts past your EV threshold. Never watch a screen again.' },
  { Ic: IconCheck, h: 'Manual approval, always', p: 'You stay in control. Review the numbers, approve the trade, and only then does an order leave the desk.' },
  { Ic: IconBolt, h: 'One-tap volume capture', p: 'A single button sweeps all available contracts at or better than your EV price — before the book moves.' },
  { Ic: IconLayout, h: 'Full trade ledger', p: 'Every fill logged with entry, fair value, EV and settlement — your P&L and hit-rate, always current.' },
];

const STEPS = [
  { n: '01 · WATCH', h: 'Track every ITF market', p: 'The engine subscribes to all live Kalshi tennis markets and mirrors the order book in memory.' },
  { n: '02 · PRICE', h: 'Compute fair value', p: 'UTR gaps are converted to win probability and compared against the live market price, tick by tick.' },
  { n: '03 · ALERT', h: 'Get pinged on edge', p: 'When EV clears your threshold, a push alert lands on your phone with all the numbers you need.' },
  { n: '04 · EXECUTE', h: 'Approve & sweep', p: 'One tap places the order and captures every contract available at your price. The ledger updates instantly.' },
];

const UTR_ROWS = [
  ['Δ 2.0+', '~99%', '99¢', true],
  ['Δ 1.0', '85–90%', '87¢', true],
  ['Δ 0.5', '~65%', '65¢', true],
  ['Δ 0.0', '~50%', '50¢', false],
];

export default function Landing({ onLogin, matches }) {
  const scrolled = useScrolled();

  return (
    <div className="animate-view-in">
      <header
        className={`fixed top-0 left-0 right-0 z-100 px-[clamp(16px,4vw,48px)] h-[72px] flex items-center
                    justify-between transition-all duration-350 max-[420px]:px-3.5
                    ${scrolled ? 'bg-bg/82 backdrop-blur-[18px] border-b border-line' : ''}`}
      >
        <Logo />
        <nav className="flex gap-8 text-sm text-muted max-[980px]:hidden">
          <a className="transition-colors duration-200 hover:text-ace" href="#features">Features</a>
          <a className="transition-colors duration-200 hover:text-ace" href="#how">How it works</a>
          <a className="transition-colors duration-200 hover:text-ace" href="#edge">The edge</a>
        </nav>
        <div className="flex gap-3 items-center">
          <button className="btn btn-ghost btn-sm max-[420px]:hidden" onClick={onLogin}>Log in</button>
          <button className="btn btn-ace btn-sm" onClick={onLogin}>Launch terminal</button>
        </div>
      </header>

      <Hero onLogin={onLogin} />

      <Tape matches={matches} />

      {/* ===== FEATURES ===== */}
      <Section id="features">
        <Reveal>
          <Eyebrow>// Capabilities</Eyebrow>
          <SecTitle>A full trading desk, built for one strategy.</SecTitle>
          <SecSub>Everything between a rating gap and a filled order — surveillance, pricing, alerting, and one-tap execution.</SecSub>
        </Reveal>
        <div className="grid grid-cols-3 gap-4.5 max-[1180px]:grid-cols-2 max-sm:grid-cols-1">
          {FEATURES.map(({ Ic, h, p }) => (
            <Reveal
              key={h}
              className="feat relative overflow-hidden bg-panel border border-line rounded-card pt-7 px-6.5 pb-7
                         transition-all duration-350 ease-[cubic-bezier(.22,1,.36,1)]
                         hover:-translate-y-1.5 hover:border-line2 hover:shadow-[0_18px_44px_rgba(0,0,0,.45)]"
            >
              <div className="w-[46px] h-[46px] rounded-xl bg-ace-dim flex items-center justify-center mb-4.5 text-ace">
                <Ic />
              </div>
              <h3 className="font-display text-[17px] font-bold mb-2">{h}</h3>
              <p className="text-muted text-sm">{p}</p>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ===== HOW IT WORKS ===== */}
      <Section id="how" className="bg-bg2 border-y border-line">
        <Reveal>
          <Eyebrow>// Workflow</Eyebrow>
          <SecTitle>From rating gap to filled order in four moves.</SecTitle>
        </Reveal>
        <div className="grid grid-cols-4 gap-4.5 max-[1180px]:grid-cols-2 max-sm:grid-cols-1">
          {STEPS.map(s => (
            <Reveal
              key={s.n}
              className="bg-panel border border-line rounded-card p-6.5 relative transition-all duration-350
                         ease-[cubic-bezier(.22,1,.36,1)] hover:-translate-y-[5px] hover:border-ace/35"
            >
              <div className="step-n font-mono text-xs text-ace tracking-[.1em] mb-3.5 flex items-center gap-2.5">{s.n}</div>
              <h4 className="font-display text-base font-bold mb-2">{s.h}</h4>
              <p className="text-muted text-[13.5px]">{s.p}</p>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ===== THE EDGE ===== */}
      <Section id="edge">
        <Reveal
          className="relative overflow-hidden bg-panel border border-line2 rounded-[22px]
                     bg-[linear-gradient(120deg,rgba(216,246,81,.07),transparent_55%)]
                     p-[clamp(34px,5vw,64px)] grid grid-cols-2 gap-[clamp(28px,4vw,64px)] items-center
                     max-[980px]:grid-cols-1"
        >
          <div>
            <Eyebrow>// The model</Eyebrow>
            <h2 className="font-display font-extrabold tracking-[-.02em] leading-[1.15] mb-4 text-[clamp(24px,3vw,36px)]">
              Rating gaps are destiny.
            </h2>
            <p className="text-muted mb-6.5">
              Across ITF-level tennis, UTR differentials predict outcomes with remarkable consistency. When the
              market prices a Δ1.2 favourite at 61¢, that's not a price — that's a gift.
            </p>
            <button className="btn btn-ace" onClick={onLogin}>Start finding edges</button>
          </div>
          <div>
            <table className="utr-table">
              <thead><tr><th>UTR gap</th><th>Historical win rate</th><th>Fair price</th></tr></thead>
              <tbody>
                {UTR_ROWS.map(([gap, rate, price, win]) => (
                  <tr key={gap}>
                    <td>{gap}</td>
                    <td className={win ? 'text-ace font-bold' : ''}>{rate}</td>
                    <td>{price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </Section>

      {/* ===== FINAL CTA ===== */}
      <section className="text-center px-[clamp(16px,4vw,48px)] pt-5 pb-[clamp(80px,9vw,130px)] relative">
        <Reveal className="max-w-[1240px] mx-auto">
          <h2 className="font-display font-extrabold text-[clamp(30px,4vw,52px)] tracking-[-.02em] mb-4.5">
            The market blinks.<br /><span className="text-ace">You don't have to.</span>
          </h2>
          <p className="text-muted mb-8.5">Log in to the terminal and let the surveillance engine do the watching.</p>
          <button className="btn btn-ace py-[15px] px-8.5 text-[15px]" onClick={onLogin}>Launch CourtEdge</button>
        </Reveal>
      </section>

      {/* ===== FOOTER ===== */}
      <footer className="border-t border-line pt-13.5 px-[clamp(16px,4vw,48px)] pb-8.5 bg-bg2">
        <div className="max-w-[1240px] mx-auto grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-8.5 mb-11 max-[980px]:grid-cols-2 max-sm:grid-cols-1">
          <div>
            <Logo />
            <p className="text-muted text-[13.5px] mt-3.5 max-w-[280px]">
              A private trading terminal for UTR-driven mispricings on Kalshi ITF markets. Built for speed,
              discipline, and edge.
            </p>
          </div>
          <FootCol h="Product" links={[
            ['Features', '#features'], ['Workflow', '#how'], ['The model', '#edge'],
            ['Terminal login', null],
          ]} onLogin={onLogin} />
          <FootCol h="Resources" links={[['Documentation'], ['API status'], ['Changelog'], ['Support']]} />
          <FootCol h="Legal" links={[['Terms of use'], ['Privacy'], ['Risk disclosure']]} />
        </div>
        <div className="max-w-[1240px] mx-auto border-t border-line pt-6.5 flex justify-between text-muted2 text-[13px] flex-wrap gap-2.5">
          <span>© 2026 CourtEdge. Trading involves risk of loss.</span>
          <span className="font-mono text-xs">v1.0.0 · Phase 1 — Frontend</span>
        </div>
      </footer>
    </div>
  );
}

function Tape({ matches }) {
  /* rendered twice so the -50% keyframe loops seamlessly */
  const loop = [...matches, ...matches];
  return (
    <div className="tape border-y border-line bg-bg2 overflow-hidden py-[13px] relative">
      <div className="tape-track">
        {loop.map((m, i) => (
          <span key={`${m.p}-${i}`} className="flex gap-[9px] items-center whitespace-nowrap">
            <b className="text-text font-semibold">{m.p.split(' vs.')[0].toUpperCase()}</b>
            {m.mkt}¢
            <span className={m.ev > 0 ? 'text-up' : 'text-down'}>
              {m.ev > 0 ? '▲' : '▼'} {Math.abs(m.ev)}% EV
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Section({ id, className = '', children }) {
  return (
    <section id={id} className={`py-[clamp(70px,9vw,120px)] px-[clamp(16px,4vw,48px)] relative ${className}`}>
      <div className="max-w-[1240px] mx-auto">{children}</div>
    </section>
  );
}

function Reveal({ className = '', children }) {
  const ref = useReveal();
  return <div ref={ref} className={`reveal ${className}`}>{children}</div>;
}

const Eyebrow = ({ children }) => (
  <div className="font-mono text-xs tracking-[.16em] uppercase text-ace mb-3.5">{children}</div>
);
const SecTitle = ({ children }) => (
  <h2 className="font-display text-[clamp(28px,3.4vw,42px)] font-extrabold tracking-[-.02em] leading-[1.15] max-w-[640px] mb-4">
    {children}
  </h2>
);
const SecSub = ({ children }) => <p className="text-muted max-w-[560px] mb-13">{children}</p>;

function FootCol({ h, links, onLogin }) {
  return (
    <div>
      <h5 className="font-mono text-[11px] tracking-[.14em] uppercase text-muted2 mb-4">{h}</h5>
      {links.map(([label, href]) => (
        <a
          key={label}
          href={href || '#'}
          onClick={href ? undefined : e => { e.preventDefault(); if (onLogin) onLogin(); }}
          className="block text-muted text-sm py-[5px] transition-colors duration-200 hover:text-ace"
        >
          {label}
        </a>
      ))}
    </div>
  );
}
