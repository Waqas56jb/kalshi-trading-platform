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
 * local development. On Vercel the same app is exported from
 * `api/[...slug].js` and sync is driven by Cron instead, because a frozen
 * function cannot hold a timer.
 *
 * Routes live on a Router mounted at both `/api` and `/`. Serverless platforms
 * differ in whether the function sees the original request path or a rewritten
 * one, and mounting twice means the API answers correctly either way instead of
 * silently 404ing on every route.
 */
export function createApp() {
  const app = express();
  const kalshi = clientFromEnv();

  app.use(cors({
    credentials: false,
    origin(origin, cb) {
      if (!origin) return cb(null, true);                     // curl / server-to-server
      if (config.corsOrigin.includes(origin)) return cb(null, true);
      let host;
      try { host = new URL(origin).hostname; } catch { return cb(null, false); }
      if (config.allowAnyLocalhost && /^(localhost|127\.0\.0\.1)$/.test(host)) return cb(null, true);
      if (/\.vercel\.app$/.test(host)) return cb(null, true);
      cb(null, false);                                        // reject without throwing
    },
  }));
  app.use(express.json({ limit: '256kb' }));

  const api = express.Router();

  /** Wraps an async handler so a rejection becomes a 500, not a hung socket. */
  const h = fn => (req, res) => fn(req, res).catch(err => {
    console.error(`[api] ${req.method} ${req.originalUrl}:`, err.message);
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
    // Vercel Cron signs its own invocations with this header
    const isVercelCron = req.get('x-vercel-signature') && req.get('user-agent')?.includes('vercel-cron');
    if (auth === `Bearer ${secret}` || req.get('x-cron-secret') === secret || isVercelCron) return true;
    res.status(401).json({ error: 'unauthorized', message: 'Valid cron secret required.' });
    return false;
  };

  /* ----------------------------------------------------------------- health */

  api.get('/health', h(async (_req, res) => {
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

  api.get('/markets', h(async (req, res) => {
    const rows = await repo.listMarkets({
      filter: String(req.query.filter ?? 'all'),
      search: String(req.query.search ?? ''),
      limit: Math.min(Number(req.query.limit) || 200, 500),
    });
    res.json({ markets: rows, count: await repo.marketCount() });
  }));

  api.get('/markets/:ticker/history', h(async (req, res) => {
    res.json({
      history: await repo.priceHistory(req.params.ticker, Math.min(Number(req.query.limit) || 200, 1000)),
    });
  }));

  /* ----------------------------------------------------------------- alerts */

  api.get('/alerts', h(async (req, res) => {
    res.json({ alerts: await repo.listAlerts({ status: String(req.query.status ?? 'open') }) });
  }));

  api.post('/alerts/:id/dismiss', h(async (req, res) => {
    const a = await repo.resolveAlert(Number(req.params.id), 'dismissed');
    if (!a) return res.status(404).json({ error: 'not_found', message: 'Alert is not open.' });
    res.json({ alert: a });
  }));

  api.post('/alerts/dismiss-all', h(async (_req, res) => {
    res.json({ dismissed: await repo.dismissAllAlerts() });
  }));

  api.post('/alerts/:id/execute', h(async (req, res) => {
    const out = await executeAlert(kalshi, Number(req.params.id), {
      sizeOverride: req.body?.contracts ? Number(req.body.contracts) : undefined,
    });
    res.status(out.ok ? 200 : 502).json(out);
  }));

  /* ----------------------------------------------------------------- trades */

  api.get('/trades', h(async (req, res) => {
    res.json({ trades: await repo.listTrades({ filter: String(req.query.filter ?? 'all') }) });
  }));

  /* -------------------------------------------------------------- dashboard */

  api.get('/overview', h(async (req, res) => {
    const [stats, pnl, alerts, sync] = await Promise.all([
      repo.overviewStats(),
      repo.pnlSeries(Math.min(Number(req.query.days) || 30, 90)),
      repo.listAlerts({ status: 'open', limit: 4 }),
      repo.lastSync(),
    ]);
    res.json({ stats, pnl, alerts, sync, kalshi: getAuthState() });
  }));

  api.get('/analytics', h(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const [buckets, wr, ev, pnl] = await Promise.all([
      repo.pnlByGapBucket(), repo.winRate(), repo.evCapturedPerDay(days), repo.pnlSeries(days),
    ]);
    res.json({ buckets, winRate: wr, evPerDay: ev, pnl });
  }));

  api.get('/pnl', h(async (req, res) => {
    res.json({ pnl: await repo.pnlSeries(Math.min(Number(req.query.days) || 30, 90)) });
  }));

  /* --------------------------------------------------------------- settings */

  api.get('/settings', h(async (_req, res) => {
    res.json({ settings: await repo.getSettings() });
  }));

  api.patch('/settings', h(async (req, res) => {
    res.json({ settings: await repo.updateSettings(req.body ?? {}) });
  }));

  /* ------------------------------------------------------------- operations */

  /**
   * Sync pass. Cron calls this on a schedule; it is also safe to call by hand.
   * Guarded by CRON_SECRET so a public deployment cannot be made to hammer the
   * Kalshi API by anyone who finds the URL.
   */
  api.all('/sync', h(async (req, res) => {
    if (!requireCronAuth(req, res)) return;
    await reapStaleRuns().catch(() => {});
    res.json(await runSync(kalshi, { verbose: true }));
  }));

  /** Imports UTR ratings for newly discovered competitors. Cron-driven. */
  api.all('/ratings/backfill', h(async (req, res) => {
    if (!requireCronAuth(req, res)) return;
    const limit = Math.min(Number(req.query.limit) || 40, 120);
    const stats = await backfillRatings({ limit, delayMs: 220 });
    res.json({ ...stats, coverage: await ratingsCoverage() });
  }));

  api.all('/portfolio/snapshot', h(async (req, res) => {
    if (req.method !== 'GET' && !requireCronAuth(req, res)) return;
    res.json({ snapshot: await snapshotPortfolio(kalshi), kalshi: getAuthState() });
  }));

  api.all('/trades/reconcile', h(async (req, res) => {
    if (!requireCronAuth(req, res)) return;
    res.json(await reconcileTrades(kalshi));
  }));

  app.use('/api', api);
  app.use('/', api);                                          // path-rewrite safety net

  app.use((req, res) => res.status(404).json({
    error: 'not_found',
    path: req.originalUrl,
    hint: 'Try /api/health',
  }));

  return { app, kalshi };
}
