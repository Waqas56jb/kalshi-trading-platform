import { useEffect, useRef } from 'react';
import { playAlertChime, showAlertNotification } from '../lib/alertSound';

/**
 * Chimes and raises a desktop notification when an alert appears that was not in
 * the previous poll.
 *
 * The first poll is used only to seed the "already seen" set — otherwise opening
 * the dashboard would fire once per existing alert. Ids are remembered rather
 * than compared by count, so a dismissal followed by a new alert is still caught.
 */
export function useAlertNotifier(alerts, { enabled = true, onNotify } = {}) {
  const seen = useRef(null);

  useEffect(() => {
    if (!Array.isArray(alerts)) return;

    const ids = new Set(alerts.map(a => a.id));

    if (seen.current === null) {          // first payload — seed, do not announce
      seen.current = ids;
      return;
    }

    const fresh = alerts.filter(a => !seen.current.has(a.id));
    seen.current = ids;
    if (!fresh.length || !enabled) return;

    playAlertChime();
    // one notification per alert, capped so a burst cannot flood the desktop
    for (const a of fresh.slice(0, 3)) showAlertNotification(a);
    onNotify?.(fresh);
  }, [alerts, enabled, onNotify]);
}
