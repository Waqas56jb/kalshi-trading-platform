import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { ping } from './db.js';
import { clientFromEnv } from './kalshi.js';
import { runSync, reapStaleRuns } from './sync.js';
import { checkKalshiAuth, executeAlert, getAuthState, reconcileTrades, snapshotPortfolio } from './orders.js';
import * as repo from './repo.js';
import { backfillRatings, ratingsCoverage } from './ratings.js';

/**
 * The Express app, with no server attached.
 *
 * `server/src/index.js` listens on a port and runs the sync loop in-process for
 * local development. On Vercel the same app is exported as a serverless handler
 * and sync is driven by Cron instead, because a frozen function cannot hold a
 * timer.
 */
export function createApp() {
  const app = express();
  const kalshi = clientFromEnv();

  app.use(cors({
    credentials: false,
    origin(origin, cb) {
      if (!origin) return cb(null, true);                     // curl / server-to-server
      if (config.corsOrigin.includes(origin)) return cb(null, true);
      if (config.allowAnyLocalhost && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return cb(null, true);
      }
      // same-origin deployments send no cross-origin preflight at all
      if (/\.vercel\.app$/.test(new URL(origin).hostname)) return cb(null, true);
      cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
  }));
  app.use(express.json({ limit: '256kb' }));

  /** Wraps an async handler so a rejection becomes a 500, not a hung socket. */
  const h = fn => (req, res) => fn(req, res).catch(err => {
    console.error(`[api] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({
      error: err.code || 'internal_error',
      message: err.message?.slice(0, 300) ?? 'Unexpected error',
    });
  });

  /** Cron and other privileged endpoints require the shared secret when one is set. */
  const requireCronAuth = (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) return true;                                  // unset locally
    const auth = req.get('authorization');
    if (auth === `Bearer ${secret}` || req.get('x-cron-secret') === secret) return true;
    res.status(401).json({ error: 'unauthorized', message: 'Valid cron secret required.' });
    return false;
  };

  /* ----------------------------------------------------------------- health */

  app.get('/api/health', h(async (_req, res) => {
    const [db, auth, sync, ratings] = await Promise.all([
      ping().then(r => ({ ok: true, now: r.now })).catch(e => ({ ok: false, error: e.message })),
      checkKalshiAuth(kalshi),
      repo.lastSync(),
      ratingsCoverage(),
    ]);
    res.json({
      ok: db.ok,
      db,
      kalshi: {
        base: config.kalshi.base,
        marketData: sync?.status === 'error' ? 'degraded' : 'ok',
        trading: auth.ok ? 'ok' : auth.reachable === false ? 'unreachable' : 'unauthenticated',
        reachable: auth.reachable ?? null,
        authError: auth.ok ? null : auth.error,
      },
      sync,
      ratings,
      series: config.sync.seriesTickers,
      runtime: process.env.VERCEL ? 'vercel' : 'node',
    });
  }));

  /* ---------------------------------------------------------------- markets */

  app.get('/api/markets', h(async (req, res) => {
    const rows = await repo.listMarkets({
      filter: String(req.query.filter ?? 'all'),
      search: String(req.query.search ?? ''),
      limit: Math.min(Number(req.query.limit) || 200, 500),
    });
    res.json({ markets: rows, count: await repo.marketCount() });
  }));

  app.get('/api/markets/:ticker/history', h(async (req, res) => {
    res.json({
      history: await repo.priceHistory(req.params.ticker, Math.min(Number(req.query.limit) || 200, 1000)),
    });
  }));

  /* ----------------------------------------------------------------- alerts */

  app.get('/api/alerts', h(async (req, res) => {
    res.json({ alerts: await repo.listAlerts({ status: String(req.query.status ?? 'open') }) });
  }));

  app.post('/api/alerts/:id/dismiss', h(async (req, res) => {
    const a = await repo.resolveAlert(Number(req.params.id), 'dismissed');
    if (!a) return res.status(404).json({ error: 'not_found', message: 'Alert is not open.' });
    res.json({ alert: a });
  }));

  app.post('/api/alerts/dismiss-all', h(async (_req, res) => {
    res.json({ dismissed: await repo.dismissAllAlerts() });
  }));

  app.post('/api/alerts/:id/execute', h(async (req, res) => {
    const out = await executeAlert(kalshi, Number(req.params.id), {
      sizeOverride: req.body?.contracts ? Number(req.body.contracts) : undefined,
    });
    res.status(out.ok ? 200 : 502).json(out);
  }));

  /* ----------------------------------------------------------------- trades */

  app.get('/api/trades', h(async (req, res) => {
    res.json({ trades: await repo.listTrades({ filter: String(req.query.filter ?? 'all') }) });
  }));

  /* -------------------------------------------------------------- dashboard */

  app.get('/api/overview', h(async (req, res) => {
    const [stats, pnl, alerts, sync] = await Promise.all([
      repo.overviewStats(),
      repo.pnlSeries(Math.min(Number(req.query.days) || 30, 90)),
      repo.listAlerts({ status: 'open', limit: 4 }),
      repo.lastSync(),
    ]);
    res.json({ stats, pnl, alerts, sync, kalshi: getAuthState() });
  }));

  app.get('/api/analytics', h(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const [buckets, wr, ev, pnl] = await Promise.all([
      repo.pnlByGapBucket(), repo.winRate(), repo.evCapturedPerDay(days), repo.pnlSeries(days),
    ]);
    res.json({ buckets, winRate: wr, evPerDay: ev, pnl });
  }));

  app.get('/api/pnl', h(async (req, res) => {
    res.json({ pnl: await repo.pnlSeries(Math.min(Number(req.query.days) || 30, 90)) });
  }));

  /* --------------------------------------------------------------- settings */

  app.get('/api/settings', h(async (_req, res) => {
    res.json({ settings: await repo.getSettings() });
  }));

  app.patch('/api/settings', h(async (req, res) => {
    res.json({ settings: await repo.updateSettings(req.body ?? {}) });
  }));

  /* ------------------------------------------------------------- operations */

  /**
   * Sync pass. Vercel Cron calls this on a schedule; it is also safe to call by
   * hand. Guarded by CRON_SECRET so a public deployment cannot be made to hammer
   * the Kalshi API by anyone who finds the URL.
   */
  app.all('/api/sync', h(async (req, res) => {
    if (!requireCronAuth(req, res)) return;
    await reapStaleRuns().catch(() => {});
    const out = await runSync(kalshi, { verbose: true });
    res.json(out);
  }));

  /** Imports UTR ratings for newly discovered competitors. Cron-driven. */
  app.all('/api/ratings/backfill', h(async (req, res) => {
    if (!requireCronAuth(req, res)) return;
    const limit = Math.min(Number(req.query.limit) || 40, 120);
    const stats = await backfillRatings({ limit, delayMs: 220 });
    res.json({ ...stats, coverage: await ratingsCoverage() });
  }));

  app.all('/api/portfolio/snapshot', h(async (req, res) => {
    if (req.method !== 'GET' && !requireCronAuth(req, res)) return;
    const snap = await snapshotPortfolio(kalshi);
    res.json({ snapshot: snap, kalshi: getAuthState() });
  }));

  app.all('/api/trades/reconcile', h(async (req, res) => {
    if (!requireCronAuth(req, res)) return;
    res.json(await reconcileTrades(kalshi));
  }));

  app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

  return { app, kalshi };
}
