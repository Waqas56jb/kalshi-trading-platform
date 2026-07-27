import { useEffect, useRef, useState, useCallback } from 'react';

/** Counts an element up to `target` once it is mounted. Mirrors the original countUps(). */
export function useCountUp(target, dur = 1400) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let raf;
    const t0 = performance.now();
    const tick = t => {
      const p = Math.min((t - t0) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(target * e));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return val.toLocaleString();
}

/** Adds `.in` when the element scrolls into view — the original IntersectionObserver. */
export function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      es => es.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      }),
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/** Tracks whether the window has scrolled past `y`. */
export function useScrolled(y = 30) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const h = () => setOn(window.scrollY > y);
    h();
    window.addEventListener('scroll', h, { passive: true });
    return () => window.removeEventListener('scroll', h);
  }, [y]);
  return on;
}

/** Redraws a canvas on mount and on every resize. */
export function useCanvas(draw, deps = []) {
  const ref = useRef(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const run = useCallback(() => {
    const c = ref.current;
    if (c && c.offsetParent !== null) drawRef.current(c);
  }, []);

  useEffect(() => {
    const id = setTimeout(run, 60);
    window.addEventListener('resize', run, { passive: true });
    return () => { clearTimeout(id); window.removeEventListener('resize', run); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

/** setInterval that survives re-renders without restarting on every tick. */
export function useInterval(cb, ms) {
  const saved = useRef(cb);
  saved.current = cb;
  useEffect(() => {
    if (ms == null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
