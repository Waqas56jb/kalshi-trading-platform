import { rnd } from './data';

export function prepCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  /* the `height` attribute is overwritten below, so capture the authored CSS
     height once — re-reading it would compound by dpr on every frame */
  if (!c.dataset.cssH) c.dataset.cssH = c.getAttribute('height') || 200;
  const h = +c.dataset.cssH;
  const w = Math.max(1, c.clientWidth || c.parentElement.clientWidth);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.width = w + 'px';
  c.style.height = h + 'px';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function seriesRandomWalk(n, start, drift, vol) {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] + drift + rnd(-vol, vol));
  return out;
}

export function drawLineArea(c, data, color, fillAlpha = 0.18, grid = true, ballDot = false) {
  const { ctx, w, h } = prepCanvas(c);
  const pad = { l: 8, r: 8, t: 14, b: 10 };
  const min = Math.min(...data), max = Math.max(...data), span = (max - min) || 1;
  const X = i => pad.l + (w - pad.l - pad.r) * i / (data.length - 1);
  const Y = v => h - pad.b - (h - pad.t - pad.b) * (v - min) / span;

  if (grid) {
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 4; g++) {
      const y = pad.t + (h - pad.t - pad.b) * g / 3;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    }
  }

  const grad = ctx.createLinearGradient(0, pad.t, 0, h);
  grad.addColorStop(0, color + Math.round(fillAlpha * 255).toString(16).padStart(2, '0'));
  grad.addColorStop(1, color + '00');
  ctx.beginPath(); ctx.moveTo(X(0), Y(data[0]));
  data.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
  ctx.lineTo(X(data.length - 1), h - pad.b); ctx.lineTo(X(0), h - pad.b);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath(); ctx.moveTo(X(0), Y(data[0]));
  data.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
  ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke();

  if (ballDot) {
    const t = (Date.now() / 2600) % 1;
    const idx = t * (data.length - 1), i0 = Math.floor(idx), fr = idx - i0;
    const vx = X(i0) + (X(Math.min(i0 + 1, data.length - 1)) - X(i0)) * fr;
    const vy = Y(data[i0]) + (Y(data[Math.min(i0 + 1, data.length - 1)]) - Y(data[i0])) * fr;
    const bg = ctx.createRadialGradient(vx - 2, vy - 2, 1, vx, vy, 7);
    bg.addColorStop(0, '#F4FF9E'); bg.addColorStop(1, '#B8D62E');
    ctx.beginPath(); ctx.arc(vx, vy, 6, 0, 7); ctx.fillStyle = bg;
    ctx.shadowColor = 'rgba(216,246,81,.8)'; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;
  }
  return { X, Y };
}

export function drawBuckets(c) {
  const { ctx, w, h } = prepCanvas(c);
  const labels = ['Δ0.5–0.9', 'Δ1.0–1.4', 'Δ1.5–1.9', 'Δ2.0+'];
  const vals = [420, 980, 610, 340];
  const max = Math.max(...vals), pad = { l: 14, r: 14, t: 20, b: 34 };
  const bw = (w - pad.l - pad.r) / labels.length * 0.52;
  labels.forEach((lb, i) => {
    const x = pad.l + (w - pad.l - pad.r) * (i + 0.5) / labels.length;
    const bh = (h - pad.t - pad.b) * vals[i] / max;
    const g = ctx.createLinearGradient(0, h - pad.b - bh, 0, h - pad.b);
    g.addColorStop(0, '#D8F651'); g.addColorStop(1, 'rgba(216,246,81,.15)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(x - bw / 2, h - pad.b - bh, bw, bh, [8, 8, 0, 0]); ctx.fill();
    ctx.fillStyle = '#8B98A8'; ctx.font = '11px JetBrains Mono'; ctx.textAlign = 'center';
    ctx.fillText(lb, x, h - 12);
    ctx.fillStyle = '#EAF0F6'; ctx.font = '700 12px JetBrains Mono';
    ctx.fillText('$' + vals[i], x, h - pad.b - bh - 8);
  });
}

export function drawDonut(c) {
  const { ctx, w, h } = prepCanvas(c);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 16;
  const won = 43, lost = 12, tot = won + lost;
  let a = -Math.PI / 2;
  [['#34D399', won], ['#F0564A', lost]].forEach(([col, v]) => {
    const sweep = v / tot * Math.PI * 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, a, a + sweep);
    ctx.strokeStyle = col; ctx.lineWidth = 22; ctx.lineCap = 'butt'; ctx.stroke();
    a += sweep;
  });
  ctx.fillStyle = '#EAF0F6'; ctx.font = '800 30px Sora'; ctx.textAlign = 'center';
  ctx.fillText(Math.round(won / tot * 100) + '%', cx, cy + 4);
  ctx.fillStyle = '#8B98A8'; ctx.font = '11px JetBrains Mono';
  ctx.fillText('WIN RATE · ' + tot + ' SETTLED', cx, cy + 26);
}

export function drawEvPerDay(c) {
  const { ctx, w, h } = prepCanvas(c);
  const n = 30, pad = { l: 10, r: 10, t: 14, b: 12 };
  const bw = (w - pad.l - pad.r) / n * 0.6;
  for (let i = 0; i < n; i++) {
    const v = rnd(2, 26), x = pad.l + (w - pad.l - pad.r) * (i + 0.5) / n;
    const bh = (h - pad.t - pad.b) * v / 28;
    ctx.fillStyle = v >= 8 ? 'rgba(216,246,81,.85)' : 'rgba(139,152,168,.35)';
    ctx.beginPath(); ctx.roundRect(x - bw / 2, h - pad.b - bh, bw, bh, 3); ctx.fill();
  }
}
