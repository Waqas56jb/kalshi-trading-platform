import crypto from 'node:crypto';
import { t } from './config.js';
import { query } from './db.js';
import { looksInPlay } from './model.js';
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
/**
 * Reads the client's real Kalshi positions.
 *
 * The portfolio API returns money as decimal dollar strings and sizes with an
 * `_fp` suffix — `position_fp`, `market_exposure_dollars`, `realized_pnl_dollars`
 * — exactly like the market endpoints. Reading the unsuffixed names silently
 * yields undefined, which is why the desk reported no positions while the account
 * held $106 of them.
 */
export async function livePositions(kalshi) {
  const st = await checkKalshiAuth(kalshi);
  if (!st.ok) return { ok: false, error: st.error, positions: [] };

  const pos = await kalshi.getPositions({ limit: 200 }).catch(() => null);
  const rows = (pos?.market_positions ?? []).map(p => ({
    ticker: p.ticker,
    contracts: Number(p.position_fp ?? 0),
    exposure_usd: Number(p.market_exposure_dollars ?? 0),
    realised_usd: Number(p.realized_pnl_dollars ?? 0),
    fees_usd: Number(p.fees_paid_dollars ?? 0),
    traded_usd: Number(p.total_traded_dollars ?? 0),
    updated_at: p.last_updated_ts ?? null,
  }));

  const open = rows.filter(r => r.contracts !== 0);
  return {
    ok: true,
    positions: open,
    closed: rows.filter(r => r.contracts === 0 && r.realised_usd !== 0),
    exposure_usd: +open.reduce((s, r) => s + Math.abs(r.exposure_usd), 0).toFixed(2),
    realised_usd: +rows.reduce((s, r) => s + r.realised_usd, 0).toFixed(2),
    fees_usd: +rows.reduce((s, r) => s + r.fees_usd, 0).toFixed(2),
  };
}

export async function snapshotPortfolio(kalshi) {
  const st = await checkKalshiAuth(kalshi);
  if (!st.ok) return null;

  const bal = await kalshi.getBalance().catch(() => null);
  const live = await livePositions(kalshi);

  const r = await query(
    `insert into ${t('portfolio_snapshots')}
       (balance_cents, exposure_cents, realized_pnl_cents, open_positions)
     values ($1,$2,$3,$4) returning *`,
    [bal?.balance ?? null,
      Math.round((live.exposure_usd ?? 0) * 100) || null,
      Math.round((live.realised_usd ?? 0) * 100) || null,
      live.positions?.length ?? 0],
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

  /* Entries are pre-match only. The alert was pre-match when it was raised, but
     matches start between raise and click; re-verify against the live market
     state at the moment of execution, and expire the alert if the window has
     closed rather than leaving it clickable. */
  const { rows: [mkt] } = await query(
    `select m.play_state, m.match_date, m.yes_bid_cents, m.yes_ask_cents,
            e.scheduled_at, e.schedule_confidence
     from ${t('markets')} m
     left join ${t('events')} e on e.event_ticker = m.event_ticker
     where m.ticker = $1`, [alert.ticker]);
  if (mkt) {
    const startedBySchedule = mkt.schedule_confidence === 'exact'
      && mkt.scheduled_at && new Date(mkt.scheduled_at).getTime() <= Date.now();
    const inPlay = mkt.play_state === 'in_play'
      || looksInPlay({ bid: mkt.yes_bid_cents, ask: mkt.yes_ask_cents }) != null;
    if (startedBySchedule || inPlay) {
      await resolveAlert(alert.id, 'expired');
      return {
        ok: false,
        code: 'match_started',
        message: 'This match has started — entries are pre-match only.',
      };
    }
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

/**
 * Closes an open position.
 *
 * A paper position books out at the current bid — the price a seller would
 * actually get. A live one sends a sell order for the contracts held. Either way
 * the row records the exit price and why it was closed, so the ledger explains
 * itself later.
 */
export async function closePosition(kalshi, tradeId, { reason = 'manual' } = {}) {
  const r = await query(
    `select * from ${t('trades')} where id = $1 and status in ('filled','partial')`, [tradeId]);
  const trade = r.rows[0];
  if (!trade) return { ok: false, code: 'not_open', message: 'That position is not open.' };

  const mk = await query(
    `select yes_bid_cents, yes_ask_cents, player_name from ${t('markets')} where ticker = $1`,
    [trade.ticker]);
  const exit = mk.rows[0]?.yes_bid_cents;
  if (exit == null) {
    return { ok: false, code: 'no_bid', message: 'No bid available to sell into right now.' };
  }

  const size = Number(trade.size_contracts ?? 0);
  const pnl = ((exit - Number(trade.entry_cents ?? 0)) * size) / 100;

  if (trade.mode === 'paper') {
    const upd = await query(
      `update ${t('trades')} set status = 'settled', exit_cents = $2, exit_reason = $3,
         pnl_usd = $4::numeric,
         result = case when $4::numeric > 0 then 'won'
                       when $4::numeric < 0 then 'lost' else 'void' end,
         closed_at = now(), settled_at = now()
       where id = $1 returning *`,
      [tradeId, exit, reason, pnl.toFixed(2)],
    );
    return {
      ok: true, paper: true, trade: upd.rows[0],
      message: `Paper position closed at ${exit}¢ — ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}.`,
    };
  }

  const auth = await checkKalshiAuth(kalshi);
  if (!auth.ok) {
    return { ok: false, code: 'kalshi_auth_failed', message: 'Kalshi rejected the credentials.', detail: auth.error };
  }

  try {
    const res = await kalshi.createOrder({
      action: 'sell', side: trade.side ?? 'yes', ticker: trade.ticker,
      type: 'limit', count: size, yes_price: exit,
      client_order_id: crypto.randomUUID(), time_in_force: 'fill_or_kill',
    });
    const upd = await query(
      `update ${t('trades')} set status = 'settled', exit_cents = $2, exit_reason = $3,
         pnl_usd = $4::numeric,
         result = case when $4::numeric > 0 then 'won'
                       when $4::numeric < 0 then 'lost' else 'void' end,
         closed_at = now(), settled_at = now(), raw = $5
       where id = $1 returning *`,
      [tradeId, exit, reason, pnl.toFixed(2), JSON.stringify(res)],
    );
    return { ok: true, trade: upd.rows[0], message: `Sold ${size} contracts at ${exit}¢.` };
  } catch (e) {
    return {
      ok: false, code: 'sell_rejected',
      message: 'Kalshi rejected the sell order.',
      detail: String(e.body?.error?.message ?? e.message).slice(0, 300),
    };
  }
}

/**
 * Closes positions whose bid has reached the modelled fair value.
 *
 * The point of the strategy is the gap between price and fair value; once the
 * market has closed that gap there is nothing left to hold for, and continuing to
 * hold is just taking match risk for no edge.
 */
export async function autoSellAtFair(kalshi) {
  const cfg = (await query(
    `select auto_sell_at_fair, auto_sell_buffer_cents,
            take_profit_enabled, take_profit_pct,
            stop_loss_enabled, stop_loss_pct
     from ${t('settings')} where id = 1`)).rows[0] ?? {};

  const anyRule = cfg.auto_sell_at_fair || cfg.take_profit_enabled || cfg.stop_loss_enabled;
  if (!anyRule) return { enabled: false, closed: 0 };

  const buffer = Number(cfg.auto_sell_buffer_cents ?? 0);
  const tp = Number(cfg.take_profit_pct ?? 0);
  const sl = Number(cfg.stop_loss_pct ?? 0);

  /* Each rule is evaluated against the live bid — the price the position could
     actually be sold at, not the mid or the ask. */
  const due = await query(
    `select tr.id, tr.player_name, tr.entry_cents, tr.fair_cents, m.yes_bid_cents,
            round(((m.yes_bid_cents - tr.entry_cents)::numeric / nullif(tr.entry_cents, 0)) * 100, 1) as return_pct
     from ${t('trades')} tr
     join ${t('markets')} m on m.ticker = tr.ticker
     where tr.status in ('filled','partial')
       and m.yes_bid_cents is not null and tr.entry_cents > 0
       and (
         ($1::boolean and tr.fair_cents is not null and m.yes_bid_cents >= tr.fair_cents - $2::int)
         or ($3::boolean and ((m.yes_bid_cents - tr.entry_cents)::numeric / tr.entry_cents) * 100 >= $4::numeric)
         or ($5::boolean and ((m.yes_bid_cents - tr.entry_cents)::numeric / tr.entry_cents) * 100 <= -($6::numeric))
       )
     limit 25`,
    [Boolean(cfg.auto_sell_at_fair), buffer,
      Boolean(cfg.take_profit_enabled), tp,
      Boolean(cfg.stop_loss_enabled), sl],
  );

  const closed = [];
  for (const row of due.rows) {
    const ret = Number(row.return_pct ?? 0);
    // report the rule that actually triggered, so the ledger explains itself
    const reason = cfg.take_profit_enabled && ret >= tp ? 'take_profit'
      : cfg.stop_loss_enabled && ret <= -sl ? 'stop_loss'
      : 'auto_fair_value';

    const out = await closePosition(kalshi, row.id, { reason });
    if (out.ok) {
      closed.push({
        id: row.id, player: row.player_name, exit: out.trade.exit_cents,
        return_pct: ret, reason,
      });
    }
  }
  return {
    enabled: true, checked: due.rowCount, closed: closed.length, positions: closed,
    rules: {
      fair_value: Boolean(cfg.auto_sell_at_fair),
      take_profit: cfg.take_profit_enabled ? `+${tp}%` : false,
      stop_loss: cfg.stop_loss_enabled ? `-${sl}%` : false,
    },
  };
}
