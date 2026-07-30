import { Logo } from '../common';
import { IconActivity, IconBell, IconChart, IconGear, IconGrid, IconLogout, IconPie } from '../Icons';

const NAV = [
  { id: 'overview', label: 'Overview', Ic: IconGrid },
  { id: 'markets', label: 'Live markets', Ic: IconActivity },
  { id: 'alerts', label: 'Alerts', Ic: IconBell, badge: true },
  { id: 'trades', label: 'Trade history', Ic: IconChart },
  { id: 'analytics', label: 'Analytics', Ic: IconPie },
];

export default function Sidebar({
  open, page, onPage, onClose, onHome, onLogout, alertCount, botOn, onToggleBot, health, user,
}) {
  const tracked = health?.sync?.markets_seen ?? null;
  const status = !botOn ? 'PAUSED · ALERTS ONLY'
    : tracked != null ? `SCANNING · ${tracked} MARKETS`
    : 'STARTING UP…';

  return (
    <>
      <div
        className={`fixed inset-0 bg-[rgba(4,6,9,.6)] z-85 ${open ? 'block' : 'hidden'}`}
        onClick={onClose}
      />
      <aside
        className={`w-[248px] shrink-0 bg-bg2 border-r border-line flex flex-col fixed top-0 bottom-0 left-0 z-90
                    transition-transform duration-350 ease-[cubic-bezier(.22,1,.36,1)]
                    max-[980px]:-translate-x-full
                    ${open ? 'max-[980px]:translate-x-0 max-[980px]:shadow-[30px_0_60px_rgba(0,0,0,.5)]' : ''}`}
      >
        <div className="pt-5.5 px-5.5 pb-4.5 border-b border-line">
          <Logo href="#" onClick={e => { e.preventDefault(); onHome(); }} />
        </div>

        <nav className="flex-1 py-4 px-3 overflow-y-auto">
          <SbLabel>Trading desk</SbLabel>
          {NAV.map(({ id, label, Ic, badge }) => (
            <SbItem key={id} active={page === id} onClick={() => onPage(id)}>
              <Ic />{label}
              {badge && alertCount > 0 && (
                <span className="ml-auto font-mono text-[11px] bg-down/15 text-down py-0.5 px-2 rounded-full font-bold">
                  {alertCount}
                </span>
              )}
            </SbItem>
          ))}
          <SbLabel>System</SbLabel>
          <SbItem active={page === 'settings'} onClick={() => onPage('settings')}><IconGear />Settings</SbItem>
          <SbItem onClick={onLogout}><IconLogout />Log out</SbItem>
        </nav>

        <div className="p-4 border-t border-line">
          {user && (
            <div className="mb-3 px-1">
              <div className="text-[13px] font-semibold truncate">{user.name || user.email}</div>
              <div className="font-mono text-[10.5px] text-muted2 truncate">
                {user.role === 'admin' ? 'Administrator' : 'Trader'} · {user.email}
              </div>
            </div>
          )}
          <div className="bg-panel border border-line2 rounded-[13px] p-3.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-semibold">Trading bot</span>
              <button className={`tgl ${botOn ? 'on' : ''}`} onClick={onToggleBot} aria-label="Toggle bot" />
            </div>
            <div className={`font-mono text-[11px] flex items-center gap-[7px] ${botOn ? 'text-up' : 'text-amber'}`}>
              <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${botOn ? 'bg-up animate-blink' : 'bg-amber'}`} />
              {status}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

const SbLabel = ({ children }) => (
  <div className="font-mono text-[10.5px] tracking-[.16em] uppercase text-muted2 pt-3.5 px-3 pb-2">{children}</div>
);

function SbItem({ active, children, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 py-[11px] px-3 rounded-[11px] text-sm font-medium w-full text-left
                  transition-all duration-200 relative mb-0.5 [&>svg]:shrink-0 [&>svg]:opacity-80
                  ${active
                    ? 'sb-item-active bg-ace-dim text-ace font-semibold'
                    : 'text-muted hover:bg-white/4 hover:text-text'}`}
    >
      {children}
    </button>
  );
}
