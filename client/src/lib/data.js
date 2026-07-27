export const rnd = (a, b) => Math.random() * (b - a) + a;
export const ri = (a, b) => Math.floor(rnd(a, b + 1));

const SEED_MATCHES = [
  { p: 'Costa vs. Bergs', t: 'ITF M25 Santarem', u1: 14.1, u2: 12.9, mkt: 61, live: true },
  { p: 'Vasquez vs. Duran', t: 'ITF W35 Lima', u1: 11.8, u2: 10.7, mkt: 66, live: true },
  { p: 'Okamura vs. Silva', t: 'ITF M15 Monastir', u1: 13.4, u2: 12.9, mkt: 52, live: false },
  { p: 'Petrova vs. Klein', t: 'ITF W25 Porto', u1: 12.6, u2: 10.5, mkt: 88, live: true },
  { p: 'Nakamura vs. Ferrer', t: 'ITF M25 Astana', u1: 13.9, u2: 13.4, mkt: 58, live: false },
  { p: 'Alvarez vs. Ricci', t: 'ITF M15 Cancun', u1: 12.2, u2: 11.2, mkt: 71, live: true },
  { p: 'Kimura vs. Braun', t: 'ITF W15 Antalya', u1: 10.9, u2: 10.4, mkt: 60, live: false },
  { p: 'Torres vs. Novak', t: 'ITF M25 Braga', u1: 13.7, u2: 11.6, mkt: 82, live: true },
  { p: 'Lindqvist vs. Marino', t: 'ITF W35 Rome', u1: 12.1, u2: 11.6, mkt: 63, live: false },
  { p: 'Haddad vs. Cerny', t: 'ITF M15 Sofia', u1: 12.8, u2: 11.8, mkt: 69, live: true },
  { p: 'Ivanova vs. Sato', t: 'ITF W25 Osaka', u1: 11.5, u2: 11.0, mkt: 57, live: false },
  { p: 'Moreau vs. Zhang', t: 'ITF M25 Nottingham', u1: 14.0, u2: 12.0, mkt: 91, live: false },
];

export function fairFromGap(g) {
  if (g >= 2.0) return 99;
  if (g >= 1.0) return Math.round(85 + (Math.min(g, 2) - 1) * 14);
  if (g >= 0.5) return Math.round(65 + (g - 0.5) * 40);
  return Math.round(50 + g * 30);
}

/** Derives ev / hot / mid from the current market price. Returns a new object. */
export function recalc(m) {
  const ev = +(((m.fair - m.mkt) / m.mkt) * 100).toFixed(1);
  return { ...m, ev, hot: ev >= 8, mid: ev >= 4 && ev < 8 };
}

export function buildMatches() {
  return SEED_MATCHES.map(m => {
    const gap = +(m.u1 - m.u2).toFixed(1);
    return recalc({ ...m, gap, fair: fairFromGap(gap), vol: ri(300, 2400) });
  });
}

export function buildAlerts(matches) {
  return matches.filter(m => m.ev >= 8).slice(0, 4)
    .map((m, i) => ({ ...m, id: i + 1, ago: ri(1, 18) + 'm ago' }));
}

export function buildTrades(matches) {
  const res = ['won', 'won', 'won', 'lost', 'won', 'open', 'won', 'lost', 'won', 'won', 'open', 'won', 'lost', 'won', 'won'];
  const out = [];
  for (let i = 0; i < 15; i++) {
    const m = matches[i % matches.length];
    const entry = ri(48, 84);
    const fair = Math.min(entry + ri(6, 22), 99);
    const size = [100, 150, 200, 250, 300][ri(0, 4)];
    const r = res[i];
    let pnl = 0;
    if (r === 'won') pnl = +((100 - entry) / 100 * size).toFixed(0);
    if (r === 'lost') pnl = -+((entry) / 100 * size).toFixed(0);
    out.push({
      time: `Jul ${27 - Math.floor(i / 3)} · ${ri(9, 21)}:${String(ri(10, 59))}`,
      match: m.p, side: 'YES', entry, fair, size,
      ev: +(((fair - entry) / entry) * 100).toFixed(1), res: r, pnl,
    });
  }
  return out;
}
