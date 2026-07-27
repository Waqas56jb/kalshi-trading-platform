import { useEffect, useRef, useState } from 'react';
import { CourtLines, LiveDot } from '../common';
import { IconArrow } from '../Icons';
import { useCountUp } from '../../hooks/useUi';
import { drawLineArea, seriesRandomWalk } from '../../lib/charts';
import { rnd } from '../../lib/data';

const EDGES = [
  { p: 'Costa vs. Bergs', gap: '1.2', ev: '+26.0%', tone: 'text-ace', on: true },
  { p: 'Navone vs. Trungelliti', gap: '0.9', ev: '+14.2%', tone: 'text-up' },
  { p: 'Kirchheimer vs. Boyer', gap: '0.6', ev: '+9.4%', tone: 'text-up' },
  { p: 'Vrbensky vs. Forejtek', gap: '0.3', ev: '+2.1%', tone: 'text-muted2' },
];

/** Live price chart in the preview card — the only looping motion in the hero,
 *  and it is data, not decoration. */
function useHeroPrice() {
  const ref = useRef(null);
  const [price, setPrice] = useState(61);

  useEffect(() => {
    const data = seriesRandomWalk(46, 58, 0.18, 2.2);
    let alive = true, raf, timer;
    const loop = () => {
      const c = ref.current;
      if (c && c.offsetParent !== null) {
        data.push(data[data.length - 1] + rnd(-1.6, 1.9));
        data.shift();
        setPrice(Math.max(35, Math.min(92, Math.round(data[data.length - 1]))));
        drawLineArea(c, data, '#D8F651', 0.2, true, true);
      }
      if (alive) raf = requestAnimationFrame(() => { timer = setTimeout(loop, 90); });
    };
    loop();
    return () => { alive = false; cancelAnimationFrame(raf); clearTimeout(timer); };
  }, []);

  return { ref, price };
}

export default function Hero({ onLogin }) {
  const { ref: chartRef, price } = useHeroPrice();
  const markets = useCountUp(184);
  const latency = useCountUp(90);
  const hours = useCountUp(24);

  return (
    <section
      id="top"
      className="relative isolate overflow-hidden text-center
                 px-[clamp(18px,4vw,56px)]
                 pt-[calc(72px+clamp(56px,8vw,104px))] pb-[clamp(70px,7vw,104px)]
                 max-sm:pt-[calc(72px+44px)] max-sm:pb-16"
    >
      {/* photographic backdrop — static */}
      <div className="hero-bg-overlay absolute inset-0 -z-4 overflow-hidden">
        <img
          src="https://images.unsplash.com/photo-1554068865-24cecd4e34b8?auto=format&fit=crop&w=1920&q=72"
          alt="" aria-hidden="true" loading="eager" decoding="async" fetchPriority="high"
          onError={e => { e.currentTarget.style.display = 'none'; }}
          className="w-full h-full object-cover object-[50%_34%] opacity-30 max-sm:opacity-24
                     max-sm:object-[56%_34%] [filter:grayscale(.45)_contrast(1.05)_brightness(.55)_saturate(.85)]"
        />
      </div>

      <div
        className="absolute -top-[32%] left-1/2 -translate-x-1/2 -z-3 pointer-events-none
                   w-[min(140vw,1500px)] aspect-[2/1] rounded-full blur-[50px]
                   bg-[radial-gradient(ellipse_at_center,rgba(216,246,81,.15),transparent_62%)]"
      />
      <CourtLines className="court-mask opacity-34 -z-2" />

      {/* ---- copy column ---- */}
      <div className="relative max-w-[960px] mx-auto flex flex-col items-center max-[860px]:max-w-[660px]">
        <span
          className="opacity-0 animate-hero-up [animation-delay:.04s] inline-flex items-center gap-2.5 max-w-full
                     font-mono text-[clamp(10.5px,.85vw,12px)] tracking-[.14em] uppercase
                     text-ace bg-ace-dim border border-ace/25 py-2.5 px-4.5 rounded-full
                     mb-[clamp(22px,2.6vw,30px)]"
        >
          <LiveDot />ITF · Kalshi · UTR — Live
        </span>

        <h1
          className="opacity-0 animate-hero-up [animation-delay:.12s] font-display font-extrabold
                     text-[clamp(36px,5.6vw,74px)] leading-[1.05] tracking-[-.035em]
                     mb-[clamp(18px,2vw,26px)] max-w-[15ch] text-balance
                     max-sm:text-[clamp(31px,8.2vw,44px)] max-sm:tracking-[-.03em] max-sm:max-w-none"
        >
          Every tennis mispricing, <span className="text-ace">before the market corrects.</span>
        </h1>

        <p
          className="opacity-0 animate-hero-up [animation-delay:.2s] text-muted leading-[1.62]
                     text-[clamp(15.5px,1.25vw,19px)] max-w-[60ch] mb-[clamp(28px,3vw,38px)]
                     [text-wrap:pretty] max-sm:text-[15px]"
        >
          CourtEdge prices every ITF market on Kalshi straight from UTR rating gaps, and alerts you the
          instant the book drifts from fair value — so you approve the trade and take the volume first.
        </p>

        <div
          className="opacity-0 animate-hero-up [animation-delay:.28s] flex gap-3.5 flex-wrap justify-center
                     mb-[clamp(30px,3.4vw,44px)] max-sm:gap-[11px] max-sm:w-full"
        >
          <button className="btn btn-ace btn-lg max-sm:flex-[1_1_100%] max-sm:justify-center max-sm:py-3.5 max-sm:px-[22px]" onClick={onLogin}>
            Open the terminal <IconArrow width="17" height="17" />
          </button>
          <a className="btn btn-ghost btn-lg max-sm:flex-[1_1_100%] max-sm:justify-center max-sm:py-3.5 max-sm:px-[22px]" href="#how">
            See how it works
          </a>
        </div>

        <div
          className="opacity-0 animate-hero-up [animation-delay:.36s] flex flex-wrap justify-center
                     gap-[clamp(18px,3vw,44px)] text-muted2
                     max-sm:gap-x-5 max-sm:gap-y-2.5 max-sm:text-[12.5px]
                     max-[430px]:flex-col max-[430px]:items-center max-[430px]:gap-[9px]"
        >
          <Proof value={markets} label="markets tracked live" />
          <Proof value={<>&lt;{latency}<span className="text-ace">ms</span></>} label="alert latency" />
          <Proof value={`${hours}/7`} label="market surveillance" />
        </div>
      </div>

      {/* ---- product preview ---- */}
      <div
        className="relative max-w-[1140px] mx-auto mt-[clamp(52px,6vw,84px)] opacity-0
                   animate-[heroUp_1s_cubic-bezier(.22,1,.36,1)_.44s_forwards]
                   max-sm:mt-[clamp(38px,8vw,52px)]
                   before:content-[''] before:absolute before:inset-y-[12%] before:inset-x-[6%] before:-bottom-[6%] before:-z-1
                   before:blur-[48px] before:bg-[radial-gradient(ellipse_at_center,rgba(216,246,81,.14),transparent_68%)]"
      >
        <div
          className="gradient-ring relative text-left overflow-hidden rounded-[clamp(14px,1.4vw,20px)]
                     bg-[linear-gradient(168deg,rgba(20,28,38,.96),rgba(10,15,21,.98))]
                     border border-line2 shadow-xl"
        >
          <div className="flex items-center gap-3.5 py-[13px] px-[18px] border-b border-line bg-white/[.015] max-sm:py-[11px] max-sm:px-3.5 max-sm:gap-2.5">
            <span className="flex gap-[7px] shrink-0">
              <i className="w-[9px] h-[9px] rounded-full bg-line2" />
              <i className="w-[9px] h-[9px] rounded-full bg-line2" />
              <i className="w-[9px] h-[9px] rounded-full bg-line2" />
            </span>
            <span className="font-mono text-[11.5px] text-muted2 tracking-[.07em] overflow-hidden text-ellipsis whitespace-nowrap max-sm:hidden">
              courtedge · live desk — ITF M25 Santarem
            </span>
            <span className="ml-auto font-mono text-[11px] text-ace bg-ace-dim border border-ace/25 py-[5px] px-[11px] rounded-full inline-flex gap-[7px] items-center whitespace-nowrap shrink-0">
              <LiveDot />MISPRICED
            </span>
          </div>

          <div className="grid grid-cols-[minmax(0,.82fr)_minmax(0,1.18fr)] max-[860px]:grid-cols-[minmax(0,1fr)]">
            <div className="border-r border-line p-2 min-w-0 max-[860px]:hidden">
              <div className="font-mono text-[10px] tracking-[.16em] uppercase text-muted2 pt-2.5 px-3 pb-2">
                Live edges
              </div>
              {EDGES.map(e => (
                <div
                  key={e.p}
                  className={`flex items-center gap-3 py-[11px] px-3 rounded-[10px] min-w-0 transition-colors duration-200 ${
                    e.on ? 'bg-ace-dim shadow-[inset_2px_0_0_var(--color-ace)]' : 'hover:bg-white/3'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <b className="block text-[13px] font-semibold tracking-[-.01em] overflow-hidden text-ellipsis whitespace-nowrap">{e.p}</b>
                    <span className="block font-mono text-[10.5px] text-muted2 mt-[3px]">Δ {e.gap} UTR</span>
                  </span>
                  <span className={`font-mono text-[13px] font-bold shrink-0 ${e.tone}`}>{e.ev}</span>
                </div>
              ))}
            </div>

            <div className="pt-1 pb-3 min-w-0">
              <div className="flex justify-between items-start gap-3.5 pt-4.5 px-5.5 pb-1 max-sm:py-[15px] max-sm:px-4 max-sm:pb-1">
                <div>
                  <div className="font-display font-bold text-[clamp(15px,1.3vw,18px)] tracking-[-.015em]">Costa vs. Bergs</div>
                  <div className="font-mono text-[11.5px] text-muted mt-1">UTR 14.1 · 12.9 &nbsp;Δ 1.2</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono text-[clamp(25px,2.3vw,32px)] font-bold text-ace leading-none max-[430px]:text-2xl">{price}¢</div>
                  <div className="text-[10.5px] text-muted2 tracking-[.08em] mt-[5px]">YES · COSTA</div>
                </div>
              </div>

              <div className="pt-1.5 px-3 relative max-sm:pt-1 max-sm:px-2">
                <canvas ref={chartRef} height="150" className="w-full" />
              </div>

              <div className="pt-0.5 px-3 max-sm:px-1.5">
                <Row l="Fair value (UTR model)"><span className="text-ace">87¢</span></Row>
                <Row l="Market price">{price}¢</Row>
                <Row l="Expected value">
                  <span className="bg-up/15 text-up py-[3px] px-2.5 rounded-full text-xs font-bold font-mono whitespace-nowrap">
                    +26.0% EV
                  </span>
                </Row>
                <Row l="Volume at price">1,420 contracts</Row>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Proof({ value, label }) {
  return (
    <div className="flex items-baseline gap-[9px] text-[13.5px] max-sm:gap-[7px]">
      <span className="font-mono text-[clamp(17px,1.5vw,20px)] font-bold text-text tracking-[-.01em]">{value}</span>
      <span className="tracking-[.02em] text-[13px] max-sm:text-xs">{label}</span>
    </div>
  );
}

function Row({ l, children }) {
  return (
    <div className="flex justify-between items-center gap-3 p-2.5 rounded-[9px] text-[13px] transition-colors duration-200 hover:bg-white/3 max-sm:text-[12.4px] max-sm:py-[9px] max-sm:px-2">
      <span className="text-muted max-[430px]:text-xs">{l}</span>
      <span className="font-mono font-semibold whitespace-nowrap">{children}</span>
    </div>
  );
}
