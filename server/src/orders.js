import crypto from 'node:crypto';
import { t } from './config.js';
import { query } from './db.js';
import { getAlert, getSettings, insertTrade, resolveAlert } from './repo.js';

/**
 * Kalshi credential state, probed and cached with a short TTL.
 *
 * Portfolio and order endpoints need a working key pair; market data does not.
 * The UI reads this so it can say plainly whether execution is live rather than
 * implying a connection that isn't there.
 */
let authState = { checked: false, ok: false, error: null, checkedAt: null, balanceCents: null };
let authCheckedAtMs = 0;
const AUTH_TTL_MS = 60_000;

export async function checkKalshiAuth(kalshi, { force = false } = {}) {
  const fresh = Date.now() - authCheckedAtMs < AUTH_TTL_MS;
  if (authState.checked && fresh && !force) return authState;

  try {
    const b = await kalshi.getBalance();
    authState = {
      checked: true, ok: true, error: null, checkedAt: new Date().toISOString(),
      balanceCents: b?.balance ?? null, reachable: true,
    };
    authCheckedAtMs = Date.now();
  } catch (e) {
    /* A network fault says nothing about whether the credentials are valid, so it
       is reported but never cached — otherwise one DNS blip would leave the desk
       blaming the credentials long after connectivity returned. Only a real
       verdict from the exchange (an HTTP status) is worth caching. */
    const isVerdict = typeof e.status === 'number';
    authState = {
      checked: isVerdict, ok: false, checkedAt: new Date().toISOString(), balanceCents: null,
      error: e.body?.error?.details || e.body?.error?.message || e.message.slice(0, 200),
      status: e.status ?? null,
      reachable: isVerdict,
    };
    authCheckedAtMs = isVerdict ? Date.now() : 0;
  }
  return authState;
}

export const getAuthState = () => authState;

/** Records a balance/exposure snapshot. No-op when credentials don't work. */
export async function snapshotPortfolio(kalshi) {
  const st = await checkKalshiAuth(kalshi);
  if (!st.ok) return null;

  const [bal, pos] = await Promise.all([
    kalshi.getBalance().catch(() => null),
    kalshi.getPositions({ settlement_status: 'unsettled' }).catch(() => null),
  ]);

  const positions = pos?.market_positions ?? [];
  const exposure = positions.reduce((s, p) => s + Math.abs(Number(p.market_exposure ?? 0)), 0);

  const r = await query(
    `insert into ${t('portfolio_snapshots')}
       (balance_cents, exposure_cents, realized_pnl_cents, open_positions)
     values ($1,$2,$3,$4) returning *`,
    [bal?.balance ?? null, Math.round(exposure) || null,
      positions.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0) || null,
      positions.filter(p => Number(p.position ?? 0) !== 0).length],
  );
  return r.rows[0];
}

/**
 * Approves an alert and sends the order to Kalshi.
 *
 * The trade row is written whatever happens — a rejected order is recorded with
 * status 'failed' and the exchange's reason, so the ledger never silently drops
 * an attempt.
 */
export async function executeAlert(kalshi, alertId, { sizeOverride } = {}) {
  const alert = await getAlert(alertId);
  if (!alert) return { ok: false, code: 'alert_not_found', message: 'Alert no longer exists.' };
  if (alert.status !== 'open') {
    return { ok: false, code: 'alert_closed', message: `Alert is already ${alert.status}.` };
  }

  const settings = await getSettings();
  const priceCents = alert.market_cents;
  if (!priceCents) {
    return { ok: false, code: 'no_price', message: 'Market has no executable ask right now.' };
  }

  const stake = Number(settings.stake_per_trade);
  // contracts payout $1 each, so cost per contract is price/100 dollars
  let contracts = Math.max(1, Math.floor((stake * 100) / priceCents));
  if (settings.sweep_full_volume && alert.volume_available) {
    contracts = Math.min(contracts, Math.max(1, Math.floor(Number(alert.volume_available))));
  }
  if (sizeOverride) contracts = Math.max(1, Math.floor(sizeOverride));

  const clientOrderId = crypto.randomUUID();
  const base = {
    ticker: alert.ticker,
    event_ticker: alert.event_ticker,
    player_name: alert.player_name,
    matchup: alert.matchup,
    side: 'yes',
    action: 'buy',
    entry_cents: priceCents,
    fair_cents: alert.fair_cents,
    size_contracts: contracts,
    stake_usd: +((contracts * priceCents) / 100).toFixed(2),
    ev_pct: alert.ev_pct,
    client_order_id: clientOrderId,
  };

  const auth = await checkKalshiAuth(kalshi);

  /**
   * Paper fill.
   *
   * Taken when paper mode is on, and forced when Kalshi will not accept the
   * credentials — recording a labelled paper position is more useful than a row
   * that only says "failed", and it never claims an order was sent. Price and
   * size are the real ask and the real depth at that ask.
   */
  if (settings.paper_trading || !auth.ok) {
    const trade = await insertTrade({
      ...base,
      mode: 'paper',
      status: 'filled',
      filled_at: new Date().toISOString(),
      error: auth.ok ? null
        : `Paper fill — Kalshi credentials rejected (${auth.status ?? '401'}): ${auth.error}`,
    });
    await resolveAlert(alertId, 'executed');
    return {
      ok: true, paper: true, trade,
      message: auth.ok
        ? `Paper fill: ${contracts.toLocaleString()} contracts at ${priceCents}¢. No order was sent.`
        : `Recorded as a paper fill — Kalshi rejected the API credentials, so no order could be sent.`,
      kalshiAuthOk: auth.ok,
    };
  }

  try {
    const res = await kalshi.createOrder({
      action: 'buy',
      side: 'yes',
      ticker: alert.ticker,
      type: 'limit',
      count: contracts,
      yes_price: priceCents,
      client_order_id: clientOrderId,
      time_in_force: 'fill_or_kill',
    });

    const order = res?.order ?? {};
    const trade = await insertTrade({
      ...base,
      kalshi_order_id: order.order_id ?? null,
      status: order.status === 'executed' ? 'filled' : 'pending',
      raw: res,
    });
    await resolveAlert(alertId, 'executed');
    return { ok: true, trade, order };
  } catch (e) {
    const trade = await insertTrade({
      ...base, status: 'failed',
      error: String(e.body?.error?.message || e.message).slice(0, 500),
    });
    return {
      ok: false, code: 'order_rejected', trade,
      message: 'Kalshi rejected the order.',
      detail: String(e.body?.error?.message || e.message).slice(0, 300),
    };
  }
}

/** Reconciles pending orders and settled positions against Kalshi. */
export async function reconcileTrades(kalshi) {
  const auth = await checkKalshiAuth(kalshi);
  if (!auth.ok) return { reconciled: 0, skipped: 'kalshi_auth_failed' };

  const pending = await query(
    `select id, kalshi_order_id from ${t('trades')}
     where status in ('pending','partial') and kalshi_order_id is not null limit 50`,
  );

  let n = 0;
  for (const row of pending.rows) {
    try {
      const res = await kalshi.get(`/portfolio/orders/${row.kalshi_order_id}`);
      const o = res?.order ?? {};
      const status = o.status === 'executed' ? 'filled'
        : o.status === 'canceled' ? 'cancelled'
        : o.status === 'resting' ? 'pending' : 'pending';
      await query(
        `update ${t('trades')} set status = $2, filled_at = case when $2 = 'filled'
           then coalesce(filled_at, now()) else filled_at end, raw = $3 where id = $1`,
        [row.id, status, JSON.stringify(res)],
      );
      n++;
    } catch { /* leave it pending; next pass retries */ }
  }
  return { reconciled: n };
}
