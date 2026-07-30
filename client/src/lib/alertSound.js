/**
 * Audible + desktop notification for new alerts.
 *
 * The chime is synthesised with the Web Audio API rather than shipped as a file,
 * so there is no asset to load and nothing to 404.
 *
 * Two browser limitations worth being clear about:
 *  - Audio cannot start until the user has interacted with the page. The context
 *    is created lazily on the first gesture and `unlocked` reports the state, so
 *    the UI can ask for a click instead of failing silently.
 *  - Nothing fires when the tab is closed. Sound and Notification both need the
 *    page alive. Real push to a closed browser needs a service worker and a push
 *    service, which is a separate piece of infrastructure.
 */

let ctx = null;
let unlocked = false;

export const soundUnlocked = () => unlocked;

/** Must be called from a user gesture. Safe to call repeatedly. */
export function unlockSound() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    unlocked = ctx.state === 'running';
  } catch {
    unlocked = false;
  }
  return unlocked;
}

/** Two-note rising chime — audible without being alarming. */
export function playAlertChime({ volume = 0.22 } = {}) {
  try {
    if (!ctx) unlockSound();
    if (!ctx || ctx.state !== 'running') return false;

    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);

    [[880, 0], [1320, 0.13]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // short attack, exponential release — a clean ping rather than a beep
      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(1, now + offset + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.32);
      osc.connect(gain).connect(master);
      osc.start(now + offset);
      osc.stop(now + offset + 0.34);
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------ desktop notification */

export const notificationsAllowed = () =>
  typeof Notification !== 'undefined' && Notification.permission === 'granted';

export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Shows an OS notification. Works while the tab is open, including when it is in
 * the background or another window has focus.
 */
export function showAlertNotification(alert) {
  if (!notificationsAllowed()) return false;
  try {
    const edge = alert.edge_cents != null ? `+${alert.edge_cents}¢ edge` : '';
    const starts = alert.starts_at
      ? ` · starts ${new Date(alert.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
    const n = new Notification(`Mispricing: ${alert.player_name ?? 'market'}`, {
      body: `${alert.market_cents}¢ vs fair ${alert.fair_cents}¢ — ${edge}${starts}`,
      tag: `courtedge-alert-${alert.id}`,   // collapses duplicates for the same alert
      silent: true,                         // the chime is ours; avoid a double sound
    });
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch {
    return false;
  }
}
