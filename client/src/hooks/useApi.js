import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetches once and then on an interval. Keeps the previous payload visible
 * while refetching so the dashboard never flashes empty between polls.
 */
export function usePoll(fetcher, { intervalMs = 0, deps = [], enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fetcher);
  fnRef.current = fetcher;
  const alive = useRef(true);
  /* Ticket counter for in-flight requests. Responses do not arrive in the
     order they were sent — a slow poll can land after the fast one that
     followed it — and without this the older payload would overwrite the
     newer on screen: prices going backwards. Only the latest request may
     write state. */
  const seq = useRef(0);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    const ticket = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const d = await fnRef.current();
      if (!alive.current) return d;
      if (ticket === seq.current) {
        setData(d);
        setError(null);
      }
      return d;
    } catch (e) {
      if (alive.current && ticket === seq.current) setError(e);
      return null;
    } finally {
      if (alive.current && ticket === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) { setLoading(false); return () => { alive.current = false; }; }

    refresh();
    let timer = null;
    if (intervalMs > 0) timer = setInterval(() => refresh({ quiet: true }), intervalMs);

    return () => { alive.current = false; if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, ...deps]);

  return { data, error, loading, refresh };
}
