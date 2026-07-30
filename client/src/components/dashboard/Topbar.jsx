import { LiveDot } from '../common';
import { IconBell, IconBurger, IconSearch } from '../Icons';

export default function Topbar({ query, onQuery, onBurger, onAlerts, health }) {
  const sync = health?.sync ?? null;
  const dbOk = health?.db?.ok ?? false;
  const latency = sync?.latency_ms ?? null;
  const connected = dbOk && sync?.status === 'ok';

  const label = !health ? 'CONNECTING…'
    : !dbOk ? 'DATABASE DOWN'
    : sync?.status === 'error' ? 'SYNC ERROR'
    : sync?.status === 'ok' ? 'KALSHI FEED · LIVE'
    : sync?.syncing ? 'FIRST SYNC RUNNING…'
    : 'SYNC PENDING';

  return (
    <div className="h-[66px] border-b border-line flex items-center gap-4 px-[clamp(14px,2.5vw,28px)]
                    bg-bg/75 backdrop-blur-[14px] sticky top-0 z-80">
      <button
        className="hidden max-[980px]:flex w-[38px] h-[38px] rounded-[10px] border border-line2 items-center justify-center"
        onClick={onBurger}
        aria-label="Menu"
      >
        <IconBurger />
      </button>

      <div className="flex-1 max-w-[380px] relative max-sm:hidden">
        <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-muted2" />
        <input
          type="text"
          placeholder="Search players, tournaments, tickers…"
          value={query}
          onChange={e => onQuery(e.target.value)}
          className="w-full bg-panel border border-line2 rounded-[11px] py-2.5 pr-3.5 pl-[38px] text-[13.5px]
                     text-text outline-none transition-all duration-250
                     focus:border-ace focus:shadow-[0_0_0_3px_var(--color-ace-dim)]"
        />
      </div>

      <div className="ml-auto flex items-center gap-3.5">
        <div className={`font-mono text-[11.5px] flex items-center gap-[7px] py-[7px] px-3 rounded-full border ${
          connected ? 'text-up bg-up/10 border-up/25' : 'text-amber bg-amber/10 border-amber/25'
        }`}>
          <LiveDot className={connected ? 'bg-up' : 'bg-amber'} />
          <span className="max-[980px]:hidden">{label}</span>
          {latency != null && <span className="font-mono">{latency}ms</span>}
        </div>
        <button
          className="w-[38px] h-[38px] rounded-[11px] border border-line2 flex items-center justify-center
                     text-muted relative transition-all duration-250 hover:text-ace hover:border-ace"
          onClick={onAlerts}
          aria-label="Alerts"
        >
          <IconBell width="17" height="17" />
          {(health?.sync?.alerts_created ?? 0) >= 0 && (
            <span className="absolute top-2 right-[9px] w-[7px] h-[7px] rounded-full bg-down border-2 border-bg" />
          )}
        </button>
        <div className="w-[38px] h-[38px] rounded-full bg-[linear-gradient(135deg,var(--color-ace),#6BA82E)]
                        flex items-center justify-center font-display font-extrabold text-sm text-[#0B0E03]">
          MD
        </div>
      </div>
    </div>
  );
}
