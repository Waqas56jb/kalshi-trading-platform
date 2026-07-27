const base = { fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' };

export const IconArrow = p => (
  <svg width="16" height="16" strokeWidth="2.4" {...base} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const IconActivity = p => (
  <svg width="22" height="22" strokeWidth="2" {...base} {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
);
export const IconClock = p => (
  <svg width="22" height="22" strokeWidth="2" {...base} {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
);
export const IconBell = p => (
  <svg width="22" height="22" strokeWidth="2" {...base} {...p}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);
export const IconCheck = p => (
  <svg width="22" height="22" strokeWidth="2" {...base} {...p}><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" /></svg>
);
export const IconBolt = p => (
  <svg width="22" height="22" strokeWidth="2" {...base} {...p}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
);
export const IconLayout = p => (
  <svg width="22" height="22" strokeWidth="2" {...base} {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>
);
export const IconGrid = p => (
  <svg width="18" height="18" strokeWidth="2" {...base} {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);
export const IconChart = p => (
  <svg width="18" height="18" strokeWidth="2" {...base} {...p}><path d="M3 3v18h18" /><path d="M7 15l4-6 4 3 5-8" /></svg>
);
export const IconPie = p => (
  <svg width="18" height="18" strokeWidth="2" {...base} {...p}><circle cx="12" cy="12" r="10" /><path d="M12 2a10 10 0 0 1 10 10h-10z" /></svg>
);
export const IconGear = p => (
  <svg width="18" height="18" strokeWidth="2" {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
export const IconLogout = p => (
  <svg width="18" height="18" strokeWidth="2" {...base} {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" />
  </svg>
);
export const IconBurger = p => (
  <svg width="18" height="18" strokeWidth="2.2" {...base} {...p}><path d="M3 6h18M3 12h18M3 18h18" /></svg>
);
export const IconSearch = p => (
  <svg width="15" height="15" strokeWidth="2.2" {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>
);
