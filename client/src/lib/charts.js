/**
 * Canvas renderers. Every function takes real data — there are no generators
 * in this file. When a series is empty the chart draws an explicit
 * "no data yet" state rather than inventing a shape.
 */

export function prepCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  /* the `height` attribute gets overwritten below, so capture the authored CSS
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

function emptyState(c, label = 'No data yet') {
  const { ctx, w, h } = prepCanvas(c);
  ctx.fillStyle = 'rgba(255,255,255,.05)';
  for (let g = 0; g < 4; g++) {
    const y = 14 + (h - 24) * g / 3;
    ctx.fillRect(8, y, w - 16, 1);
  }
  ctx.fillStyle = '#5C6875';
  ctx.font = '12px JetBrains Mono';
  ctx.textAlign = 'center';
  ctx.fillText(label, w / 2, h / 2);
  return false;
}

/**
 * Line + gradient area. `data` is an array of numbers.
 * Returns false when there was nothing to draw.
 */
export function drawLineArea(c, data, color, {
  fillAlpha = 0.18, grid = true, dot = false, emptyLabel = 'No data yet',
} = {}) {
  const pts = (data ?? []).filter(v => v != null && Number.isFinite(Number(v))).map(Number);
  if (pts.length < 2) return emptyState(c, emptyLabel);

  const { ctx, w, h } = prepCanvas(c);
  const pad = { l: 8, r: 8, t: 14, b: 10 };
  const min = Math.min(...pts, 0);
  const max = Math.max(...pts, 0);
  const span = (max - min) || 1;
  const X = i => pad.l + (w - pad.l - pad.r) * i / (pts.length - 1);
  const Y = v => h - pad.b - (h - pad.t - pad.b) * (v - min) / span;

  if (grid) {
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 4; g++) {
      const y = pad.t + (h - pad.t - pad.b) * g / 3;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    }
  }

  // zero line when the series crosses it
  if (min < 0 && max > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(w - pad.r, Y(0)); ctx.stroke();
    ctx.setLineDash([]);
  }

  const grad = ctx.createLinearGradient(0, pad.t, 0, h);
  grad.addColorStop(0, color + Math.round(fillAlpha * 255).toString(16).padStart(2, '0'));
  grad.addColorStop(1, color + '00');
  ctx.beginPath(); ctx.moveTo(X(0), Y(pts[0]));
  pts.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
  ctx.lineTo(X(pts.length - 1), Y(min < 0 ? 0 : min));
  ctx.lineTo(X(0), Y(min < 0 ? 0 : min));
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath(); ctx.moveTo(X(0), Y(pts[0]));
  pts.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
  ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke();

  if (dot) {
    const vx = X(pts.length - 1);
    const vy = Y(pts[pts.length - 1]);
    const bg = ctx.createRadialGradient(vx - 2, vy - 2, 1, vx, vy, 7);
    bg.addColorStop(0, '#F4FF9E'); bg.addColorStop(1, '#B8D62E');
    ctx.beginPath(); ctx.arc(vx, vy, 6, 0, 7); ctx.fillStyle = bg;
    ctx.shadowColor = 'rgba(216,246,81,.8)'; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;
  }
  return true;
}

/** Bar chart from [{label, value}]. */
export function drawBars(c, rows, {
  color = '#D8F651', valueFormat = v => String(v), emptyLabel = 'No settled trades yet',
} = {}) {
  const data = (rows ?? []).filter(r => r && r.value != null);
  if (!data.length) return emptyState(c, emptyLabel);

  const { ctx, w, h } = prepCanvas(c);
  const vals = data.map(r => Number(r.value));
  const max = Math.max(...vals.map(Math.abs), 1);
  const pad = { l: 14, r: 14, t: 20, b: 34 };
  const bw = Math.min(46, (w - pad.l - pad.r) / data.length * 0.52);

  data.forEach((r, i) => {
    const x = pad.l + (w - pad.l - pad.r) * (i + 0.5) / data.length;
    const v = Number(r.value);
    const bh = Math.max(2, (h - pad.t - pad.b) * Math.abs(v) / max);
    const neg = v < 0;
    const g = ctx.createLinearGradient(0, h - pad.b - bh, 0, h - pad.b);
    const c1 = neg ? '#F0564A' : color;
    g.addColorStop(0, c1);
    g.addColorStop(1, (neg ? 'rgba(240,86,74,' : 'rgba(216,246,81,') + '.15)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(x - bw / 2, h - pad.b - bh, bw, bh, [8, 8, 0, 0]); ctx.fill();

    ctx.fillStyle = '#8B98A8'; ctx.font = '11px JetBrains Mono'; ctx.textAlign = 'center';
    ctx.fillText(String(r.label), x, h - 12);
    ctx.fillStyle = '#EAF0F6'; ctx.font = '700 12px JetBrains Mono';
    ctx.fillText(valueFormat(v), x, h - pad.b - bh - 8);
  });
  return true;
}

/** Slim bars with no labels — the 30-day EV strip. */
export function drawSparkBars(c, values, { threshold = 0, emptyLabel = 'No activity yet' } = {}) {
  const vals = (values ?? []).map(Number).filter(Number.isFinite);
  if (!vals.length || vals.every(v => v === 0)) return emptyState(c, emptyLabel);

  const { ctx, w, h } = prepCanvas(c);
  const pad = { l: 10, r: 10, t: 14, b: 12 };
  const max = Math.max(...vals.map(Math.abs), 1);
  const bw = Math.max(2, (w - pad.l - pad.r) / vals.length * 0.6);

  vals.forEach((v, i) => {
    const x = pad.l + (w - pad.l - pad.r) * (i + 0.5) / vals.length;
    const bh = Math.max(1, (h - pad.t - pad.b) * Math.abs(v) / max);
    ctx.fillStyle = Math.abs(v) > threshold ? 'rgba(216,246,81,.85)' : 'rgba(139,152,168,.35)';
    ctx.beginPath(); ctx.roundRect(x - bw / 2, h - pad.b - bh, bw, bh, 3); ctx.fill();
  });
  return true;
}

/** Win/loss donut. */
export function drawDonut(c, { won = 0, lost = 0 } = {}) {
  const tot = Number(won) + Number(lost);
  if (!tot) return emptyState(c, 'No settled trades yet');

  const { ctx, w, h } = prepCanvas(c);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 16;
  let a = -Math.PI / 2;
  for (const [col, v] of [['#34D399', Number(won)], ['#F0564A', Number(lost)]]) {
    if (!v) continue;
    const sweep = v / tot * Math.PI * 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, a, a + sweep);
    ctx.strokeStyle = col; ctx.lineWidth = 22; ctx.lineCap = 'butt'; ctx.stroke();
    a += sweep;
  }
  ctx.fillStyle = '#EAF0F6'; ctx.font = '800 30px Sora'; ctx.textAlign = 'center';
  ctx.fillText(Math.round(Number(won) / tot * 100) + '%', cx, cy + 4);
  ctx.fillStyle = '#8B98A8'; ctx.font = '11px JetBrains Mono';
  ctx.fillText('WIN RATE · ' + tot + ' SETTLED', cx, cy + 26);
  return true;
}
