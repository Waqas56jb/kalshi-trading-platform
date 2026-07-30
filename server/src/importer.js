import { t } from './config.js';
import { query } from './db.js';
import { checkKalshiAuth } from './orders.js';

/**
 * Imports the account's real Kalshi trading into the desk's ledger.
 *
 * The client trades this account outside the desk, so without this the P&L chart,
 * hit rate and analytics sit empty while the account has genuinely traded. Every
 * imported row is real: prices, sizes, fees and settlement all come from Kalshi.
 *
 * Fills use the same suffixed field names as the rest of the API —
 * `count_fp`, `yes_price_dollars`, `fee_cost` — and reading the unsuffixed forms
 * silently yields undefined, which is how the desk previously reported no
 * positions against a $588 book.
 */
export async function importKalshiHistory(kalshi, { limit = 500 } = {}) {
  const auth = await checkKalshiAuth(kalshi);
  if (!auth.ok) return { ok: false, error: auth.error, imported: 0 };

  /* Fills, walked to exhaustion. Each is one execution, so a market traded in
     several clips arrives as several rows. */
  const fills = [];
  let cursor;
  do {
    const page = await kalshi.getFills({ limit: 200, cursor });
    const rows = page?.fills ?? [];
    fills.push(...rows);
    cursor = page?.cursor || null;
    if (!rows.length) break;
  } while (cursor && fills.length < limit);

  /* Realised P&L is only known per market, so group the fills and attach the
     settlement figure Kalshi reports for that market. */
  const positions = await kalshi.getPositions({ limit: 500 }).catch(() => null);
  const settledBy = new Map(
    (positions?.market_positions ?? []).map(p => [p.ticker, {
      realised: Number(p.realized_pnl_dollars ?? 0),
      fees: Number(p.fees_paid_dollars ?? 0),
      open: Number(p.position_fp ?? 0) !== 0,
    }]),
  );

  const byMarket = new Map();
  for (const f of fills) {
    const ticker = f.ticker ?? f.market_ticker;
    if (!ticker) continue;
    if (!byMarket.has(ticker)) byMarket.set(ticker, []);
    byMarket.get(ticker).push(f);
  }

  const rows = [];
  for (const [ticker, group] of byMarket) {
    const buys = group.filter(f => f.action === 'buy');
    const source = buys.length ? buys : group;

    // size-weighted average entry, in cents
    let contracts = 0;
    let costCents = 0;
    let fees = 0;
    for (const f of source) {
      const n = Number(f.count_fp ?? 0);
      const priceCents = Math.round(Number(f.yes_price_dollars ?? 0) * 100);
      contracts += n;
      costCents += n * priceCents;
      fees += Number(f.fee_cost ?? 0);
    }
    if (!contracts) continue;

    const entry = Math.round(costCents / contracts);
    /* The positions response is the authority on what is still held. A market
       absent from it, or present with a zero size, is no longer open — treating
       "unknown" as open reported 46 live positions against an account holding
       none, and $14,514 at risk that did not exist. */
    const info = settledBy.get(ticker);
    const closed = !info || !info.open;
    const pnl = info ? info.realised : 0;
    const first = group.reduce((a, b) => (a.created_time < b.created_time ? a : b));

    rows.push({
      ticker,
      side: source[0]?.side === 'no' ? 'no' : 'yes',
      entry_cents: entry,
      size_contracts: Math.round(contracts),
      stake_usd: +(costCents / 100).toFixed(2),
      fees_usd: +fees.toFixed(2),
      status: closed ? 'settled' : 'filled',
      result: closed ? (pnl > 0 ? 'won' : pnl < 0 ? 'lost' : 'void') : null,
      pnl_usd: closed ? +pnl.toFixed(2) : 0,
      placed_at: first.created_time ?? new Date().toISOString(),
      client_order_id: `kalshi-import:${ticker}`,
    });
  }

  if (!rows.length) return { ok: true, imported: 0, fills: fills.length };

  const col = f => rows.map(f);
  const res = await query(
    `insert into ${t('trades')}
       (ticker, side, action, entry_cents, size_contracts, stake_usd, fees_usd,
        status, result, pnl_usd, placed_at, filled_at, settled_at,
        mode, exit_reason, client_order_id, player_name, event_ticker)
     select x.ticker, x.side, 'buy', x.entry, x.size, x.stake, x.fees,
            x.status, x.result, x.pnl, x.placed, x.placed,
            case when x.status = 'settled' then x.placed end,
            'live', case when x.status = 'settled' then 'settled' end,
            x.coid, m.player_name, m.event_ticker
     from unnest($1::text[], $2::text[], $3::int[], $4::int[], $5::numeric[], $6::numeric[],
                 $7::text[], $8::text[], $9::numeric[], $10::timestamptz[], $11::text[])
          as x(ticker, side, entry, size, stake, fees, status, result, pnl, placed, coid)
     left join ${t('markets')} m on m.ticker = x.ticker
     on conflict (client_order_id) do update set
       status = excluded.status, result = excluded.result, pnl_usd = excluded.pnl_usd,
       fees_usd = excluded.fees_usd, settled_at = excluded.settled_at,
       exit_reason = excluded.exit_reason
     returning id`,
    [col(r => r.ticker), col(r => r.side), col(r => r.entry_cents), col(r => r.size_contracts),
      col(r => r.stake_usd), col(r => r.fees_usd), col(r => r.status), col(r => r.result),
      col(r => r.pnl_usd), col(r => r.placed_at), col(r => r.client_order_id)],
  );

  return {
    ok: true,
    fills: fills.length,
    markets: byMarket.size,
    imported: res.rowCount ?? 0,
    settled: rows.filter(r => r.status === 'settled').length,
    open: rows.filter(r => r.status === 'filled').length,
  };
}
