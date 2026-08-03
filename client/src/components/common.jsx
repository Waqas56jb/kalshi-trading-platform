/** Pulsing "live" indicator dot. */
export function LiveDot({ className = 'bg-ace' }) {
  return <span className={`w-[7px] h-[7px] rounded-full shrink-0 animate-blink ${className}`} />;
}

/** The tennis-ball brand mark + wordmark. */
export function Logo({ className = '', onClick, href = '#top' }) {
  return (
    <a
      href={href}
      onClick={onClick}
      className={`flex items-center gap-2.5 font-display font-extrabold text-[19px] tracking-[-.02em] max-[420px]:text-[17px] ${className}`}
    >
      <span
        className="relative w-[26px] h-[26px] rounded-full animate-ball-pulse
                   bg-[radial-gradient(circle_at_32%_30%,#EFFF8A,#C6E52E_60%,#95B31C)]
                   before:content-[''] before:absolute before:inset-0 before:rounded-full
                   before:border-2 before:border-white/55 before:border-l-transparent
                   before:border-r-transparent before:rotate-[-28deg]"
      />
      Court<span className="text-ace">Edge</span>
    </a>
  );
}

/** Decorative tennis-court markings used behind the hero and the login screen. */
export function CourtLines({ className = '', full = true }) {
  return (
    <div className={`absolute inset-0 pointer-events-none ${className}`}>
      <svg viewBox="0 0 1400 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" className="w-full h-full block">
        <g stroke="#1B2430" strokeWidth="2" fill="none">
          <rect x="120" y="120" width="1160" height="660" rx="4" />
          <line x1="120" y1="450" x2="1280" y2="450" />
          <line x1="330" y1="120" x2="330" y2="780" />
          <line x1="1070" y1="120" x2="1070" y2="780" />
          {full && <line x1="330" y1="450" x2="1070" y2="450" stroke="#243040" />}
          {full && <line x1="700" y1="120" x2="700" y2="780" stroke="#243040" strokeDasharray="10 14" />}
        </g>
      </svg>
    </div>
  );
}

/** Status pill used across market tables and alert cards. */
export function StatusTag({ m }) {
  if (m.hot) return <Tag className="bg-down/15 text-down animate-hot-pulse">MISPRICED</Tag>;
  if (m.mid) return <Tag className="bg-amber/15 text-amber">WATCH</Tag>;
  return m.live
    ? <Tag className="bg-up/12 text-up">IN PLAY</Tag>
    : <Tag className="bg-muted/12 text-muted">FAIR</Tag>;
}

export function Tag({ children, className = '', title }) {
  return (
    <span
      title={title}
      className={`font-mono text-[11px] font-bold py-1 px-2.5 rounded-full inline-block ${className}`}
    >
      {children}
    </span>
  );
}

/** Rounded surface with a header strip — the dashboard's primary container. */
export function Panel({ title, tools, children, bodyClass = 'p-5', className = '' }) {
  return (
    <div className={`bg-panel border border-line rounded-card overflow-hidden mb-5.5 ${className}`}>
      {(title || tools) && (
        <div className="flex items-center justify-between gap-3 flex-wrap py-4 px-5 border-b border-line">
          {title && <h3 className="font-display text-[15.5px] font-bold">{title}</h3>}
          {tools && <div className="flex gap-2 items-center flex-wrap">{tools}</div>}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </div>
  );
}

export function ChipBtn({ on, children, ...rest }) {
  return (
    <button
      {...rest}
      className={`text-xs font-semibold py-[7px] px-[13px] rounded-full border transition-all duration-200 ${
        on ? 'bg-ace-dim border-ace/40 text-ace' : 'border-line2 text-muted hover:text-text hover:border-muted2'
      }`}
    >
      {children}
    </button>
  );
}
