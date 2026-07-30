import { useEffect, useRef, useState } from 'react';
import { CourtLines, LiveDot } from '../common';
import { IconArrow } from '../Icons';
import { useCountUp } from '../../hooks/useUi';
import { drawLineArea } from '../../lib/charts';
import { api, fmtPct } from '../../lib/api';

/**
 * Landing hero. The preview card shows a genuine top-EV market pulled from the
 * backend, with its real recorded price history. Nothing here is fabricated —
 * when the API is unreachable the card renders its unknown state instead.
 */
export default function Hero({ onLogin, feed }) {
  const { markets = [], count, loading, error } = feed;

  // headline market = highest EV we can actually price, else deepest book
  const lead = markets[0] ?? null;
  const edges = markets.slice(0, 4);

  const chartRef = useRef(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (!lead?.ticker) return;
    let alive = true;
    api.priceHistory(lead.ticker, 60)
      .then(r => { if (alive) setHistory((r.history ?? []).map(h => h.mid_cents ?? h.yes_ask_cents)); })
      .catch(() => { if (alive) setHistory([]); });
    return () => { alive = false; };
  }, [lead?.ticker]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    const draw = () => drawLineArea(c, history, '#D8F651', {
      fillAlpha: 0.2, dot: true, emptyLabel: 'Awaiting ticks',
    });
    draw();
    window.addEventListener('resize', draw, { passive: true });
    return () => window.removeEventListener('resize', draw);
  }, [history]);

  const marketsTracked = useCountUp(count?.total ?? 0);
  const priced = useCountUp(count?.priced ?? 0);

  return (
    <section
      id="top"
      className="relative isolate overflow-hidden text-center
                 px-[clamp(18px,4vw,56px)]
                 pt-[calc(72px+clamp(56px,8vw,104px))] pb-[clamp(70px,7vw,104px)]
                 max-sm:pt-[calc(72px+44px)] max-sm:pb-16"
    >
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
          <Proof value={error ? '—' : marketsTracked} label="ITF markets tracked live" />
          <Proof value={error ? '—' : priced} label="priced by the UTR model" />
          <Proof value="24/7" label="market surveillance" />
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
              courtedge · live desk{lead?.tournament ? ` — ${lead.tournament}` : ''}
            </span>
            <span className="ml-auto font-mono text-[11px] text-ace bg-ace-dim border border-ace/25 py-[5px] px-[11px] rounded-full inline-flex gap-[7px] items-center whitespace-nowrap shrink-0">
              <LiveDot />{lead?.is_actionable ? 'MISPRICED' : loading ? 'LOADING' : 'LIVE'}
            </span>
          </div>

          <div className="grid grid-cols-[minmax(0,.82fr)_minmax(0,1.18fr)] max-[860px]:grid-cols-[minmax(0,1fr)]">
            <div className="border-r border-line p-2 min-w-0 max-[860px]:hidden">
              <div className="font-mono text-[10px] tracking-[.16em] uppercase text-muted2 pt-2.5 px-3 pb-2">
                Live edges
              </div>
              {edges.length ? edges.map((e, i) => (
                <div
                  key={e.ticker}
                  className={`flex items-center gap-3 py-[11px] px-3 rounded-[10px] min-w-0 transition-colors duration-200 ${
                    i === 0 ? 'bg-ace-dim shadow-[inset_2px_0_0_var(--color-ace)]' : 'hover:bg-white/3'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <b className="block text-[13px] font-semibold tracking-[-.01em] overflow-hidden text-ellipsis whitespace-nowrap">
                      {e.matchup ?? e.player_name}
                    </b>
                    <span className="block font-mono text-[10.5px] text-muted2 mt-[3px]">
                      {e.utr_gap != null ? `Δ ${Math.abs(e.utr_gap).toFixed(1)} UTR` : e.tour_level ?? 'ITF'}
                    </span>
                  </span>
                  <span className={`font-mono text-[13px] font-bold shrink-0 ${
                    e.ev_pct == null ? 'text-muted2' : e.ev_pct >= 8 ? 'text-ace' : e.ev_pct > 0 ? 'text-up' : 'text-muted2'
                  }`}>
                    {e.ev_pct == null ? '—' : fmtPct(e.ev_pct)}
                  </span>
                </div>
              )) : (
                <div className="px-3 py-6 text-[12.5px] text-muted2">
                  {loading ? 'Loading live markets…' : 'No markets available'}
                </div>
              )}
            </div>

            <div className="pt-1 pb-3 min-w-0">
              <div className="flex justify-between items-start gap-3.5 pt-4.5 px-5.5 pb-1 max-sm:py-[15px] max-sm:px-4 max-sm:pb-1">
                <div>
                  <div className="font-display font-bold text-[clamp(15px,1.3vw,18px)] tracking-[-.015em]">
                    {lead?.matchup ?? (loading ? 'Loading…' : 'No live market')}
                  </div>
                  <div className="font-mono text-[11.5px] text-muted mt-1">
                    {lead?.player_utr != null && lead?.opponent_utr != null
                      ? `UTR ${lead.player_utr} · ${lead.opponent_utr}  Δ ${Math.abs(lead.utr_gap).toFixed(1)}`
                      : lead?.tournament ?? '—'}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono text-[clamp(25px,2.3vw,32px)] font-bold text-ace leading-none max-[430px]:text-2xl">
                    {lead?.yes_ask_cents != null ? `${lead.yes_ask_cents}¢` : '—'}
                  </div>
                  <div className="text-[10.5px] text-muted2 tracking-[.08em] mt-[5px]">
                    {lead?.player_name ? `YES · ${lead.player_name.split(' ').pop().toUpperCase()}` : 'YES'}
                  </div>
                </div>
              </div>

              <div className="pt-1.5 px-3 relative max-sm:pt-1 max-sm:px-2">
                <canvas ref={chartRef} height="150" className="w-full" />
              </div>

              <div className="pt-0.5 px-3 max-sm:px-1.5">
                <Row l="Fair value (UTR model)">
                  <span className="text-ace">{lead?.fair_cents != null ? `${lead.fair_cents}¢` : '—'}</span>
                </Row>
                <Row l="Market ask">{lead?.yes_ask_cents != null ? `${lead.yes_ask_cents}¢` : '—'}</Row>
                <Row l="Expected value">
                  {lead?.ev_pct != null ? (
                    <span className={`py-[3px] px-2.5 rounded-full text-xs font-bold font-mono whitespace-nowrap ${
                      lead.ev_pct > 0 ? 'bg-up/15 text-up' : 'bg-white/5 text-muted2'
                    }`}>
                      {fmtPct(lead.ev_pct)} EV
                    </span>
                  ) : <span className="text-muted2">unrated</span>}
                </Row>
                <Row l="Volume at ask">
                  {lead?.yes_ask_size != null ? `${Number(lead.yes_ask_size).toLocaleString()} contracts` : '—'}
                </Row>
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
