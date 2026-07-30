import express from 'express';
import cors from 'cors';
import { config, configErrors } from './config.js';
import { ping } from './db.js';
import { clientFromEnv } from './kalshi.js';
import { runSync, reapStaleRuns } from './sync.js';
import { checkKalshiAuth, executeAlert, getAuthState, reconcileTrades, snapshotPortfolio } from './orders.js';
import * as repo from './repo.js';
import { backfillRatings, ratingsCoverage } from './ratings.js';
import {
  authConfigured, authenticate, countAdmins, createUser, deleteUser, findUserByEmail,
  getUser, listUsers, logAuthEvent, updateUser, verifyPassword, verifyToken,
} from './auth.js';

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

  /* ------------------------------------------------------------------ auth --- */

  const bearer = req => {
    const h = req.get('authorization') ?? '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  };

  /** Attaches req.user when a valid session token is present. Never rejects. */
  const readSession = (req, _res, next) => {
    req.user = null;
    const tok = bearer(req);
    if (tok && authConfigured()) {
      try {
        const c = verifyToken(tok);
        if (c) req.user = { id: Number(c.sub), email: c.email, role: c.role };
      } catch { /* unconfigured or malformed — treated as anonymous */ }
    }
    next();
  };

  /** Gate for everything that reads desk data or moves money. */
  const requireAuth = (req, res, next) => {
    if (!authConfigured()) {
      return res.status(503).json({
        error: 'auth_not_configured',
        message: 'AUTH_SECRET is not set on the server, so sessions cannot be verified.',
      });
    }
    if (!req.user) {
      return res.status(401).json({ error: 'unauthorized', message: 'Sign in to continue.' });
    }
    next();
  };

  const requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', message: 'Administrator access required.' });
    }
    next();
  };

  /**
   * Cron endpoints accept the shared secret, a signed Vercel Cron invocation, or
   * an authenticated admin pressing the button in the UI.
   */
  const requireCronOrAdmin = (req, res) => {
    if (req.user?.role === 'admin') return true;
    const secret = process.env.CRON_SECRET;
    const isVercelCron = req.get('x-vercel-signature')
      && /vercel-cron/i.test(req.get('user-agent') ?? '');
    if (isVercelCron) return true;
    if (secret && (bearer(req) === secret || req.get('x-cron-secret') === secret)) return true;
    if (!secret && !authConfigured()) return true;             // unconfigured local dev
    res.status(401).json({ error: 'unauthorized', message: 'Cron secret or admin session required.' });
    return false;
  };

  api.use(readSession);

  /* ----------------------------------------------------------------- health */

  api.get('/health', h(async (_req, res) => {
    const problems = [...configErrors];
    if (!kalshi.ready) {
      problems.push(kalshi.keyError
        ? `Kalshi signing key unavailable — ${kalshi.keyError}`
        : 'KALSHI_API_KEY_ID is not set');
    }

    // each probe is independently guarded so one broken dependency still yields
    // a readable report rather than a 500
    const settle = fn => fn().catch(e => ({ __error: e.message?.slice(0, 200) }));
    const db = await settle(() => ping().then(r => ({ ok: true, now: r.now })));
    const auth = await settle(() => checkKalshiAuth(kalshi));
    const sync = await settle(() => repo.lastSync());
    const ratings = await settle(() => ratingsCoverage());

    const dbOk = db?.ok === true;
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk && problems.length === 0,
      problems,
      db: dbOk ? db : { ok: false, error: db.__error ?? db.error },
      kalshi: {
        base: config.kalshi.base,
        keyLoaded: kalshi.ready,
        marketData: !kalshi.ready ? 'unavailable' : sync?.status === 'error' ? 'degraded' : 'ok',
        trading: auth?.ok ? 'ok'
          : !kalshi.ready ? 'no_credentials'
          : auth?.reachable === false ? 'unreachable' : 'unauthenticated',
        reachable: auth?.reachable ?? null,
        authError: auth?.ok ? null : (auth?.error ?? auth?.__error ?? null),
      },
      sync: sync?.__error ? { error: sync.__error } : sync,
      ratings: ratings?.__error ? { error: ratings.__error } : ratings,
      series: config.sync.seriesTickers,
      runtime: process.env.VERCEL ? 'vercel' : 'node',
    });
  }));

  /* ------------------------------------------------------------------ auth --- */

  api.post('/auth/login', h(async (req, res) => {
    if (!authConfigured()) {
      return res.status(503).json({
        error: 'auth_not_configured',
        message: 'AUTH_SECRET is not set on the server, so sign-in is unavailable.',
      });
    }
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: 'missing_fields', message: 'Email and password are required.' });
    }

    const result = await authenticate(email, password, req);
    if (!result) {
      // deliberately identical whether the account is unknown or the password is wrong
      return res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
    }
    res.json(result);
  }));

  api.get('/auth/me', requireAuth, h(async (req, res) => {
    const user = await getUser(req.user.id);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'unauthorized', message: 'This account is no longer active.' });
    }
    res.json({ user });
  }));

  /** Change your own email, name or password. Current password is required. */
  api.patch('/auth/me', requireAuth, h(async (req, res) => {
    const { currentPassword, email, name, password } = req.body ?? {};
    const row = await findUserByEmail(req.user.email);
    if (!row) return res.status(401).json({ error: 'unauthorized', message: 'Account not found.' });

    if ((email !== undefined || password !== undefined)) {
      if (!currentPassword || !(await verifyPassword(currentPassword, row.password_hash))) {
        return res.status(403).json({
          error: 'bad_current_password',
          message: 'Enter your current password to change your email or password.',
        });
      }
    }

    const user = await updateUser(req.user.id, { email, name, password });
    await logAuthEvent({
      userId: req.user.id, email: user.email, event: 'updated',
      detail: [email && 'email', password && 'password', name !== undefined && 'name']
        .filter(Boolean).join(','),
      req,
    });
    res.json({ user });
  }));

  /* ----------------------------------------------------------------- users --- */

  api.get('/users', requireAuth, requireAdmin, h(async (_req, res) => {
    res.json({ users: await listUsers() });
  }));

  api.post('/users', requireAuth, requireAdmin, h(async (req, res) => {
    const { email, password, name, role } = req.body ?? {};
    const user = await createUser({ email, password, name, role });
    await logAuthEvent({
      userId: user.id, email: user.email, event: 'created',
      detail: `by ${req.user.email}`, req,
    });
    res.status(201).json({ user });
  }));

  api.patch('/users/:id', requireAuth, requireAdmin, h(async (req, res) => {
    const id = Number(req.params.id);
    const { email, password, name, role, is_active } = req.body ?? {};

    // never let the last active admin lock everyone out
    if ((role && role !== 'admin') || is_active === false) {
      const target = await getUser(id);
      if (target?.role === 'admin' && await countAdmins(id) === 0) {
        return res.status(409).json({
          error: 'last_admin',
          message: 'This is the only active administrator. Promote another account first.',
        });
      }
    }

    const user = await updateUser(id, { email, password, name, role, is_active });
    if (!user) return res.status(404).json({ error: 'not_found', message: 'No such account.' });
    await logAuthEvent({ userId: id, email: user.email, event: 'updated', detail: `by ${req.user.email}`, req });
    res.json({ user });
  }));

  api.delete('/users/:id', requireAuth, requireAdmin, h(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      return res.status(409).json({ error: 'self_delete', message: 'You cannot delete your own account.' });
    }
    const target = await getUser(id);
    if (target?.role === 'admin' && await countAdmins(id) === 0) {
      return res.status(409).json({
        error: 'last_admin', message: 'This is the only active administrator.',
      });
    }
    if (!(await deleteUser(id))) {
      return res.status(404).json({ error: 'not_found', message: 'No such account.' });
    }
    await logAuthEvent({ email: target?.email, event: 'deleted', detail: `by ${req.user.email}`, req });
    res.json({ deleted: id });
  }));

  /* ---------------------------------------------------------------- markets */

  api.get('/markets', requireAuth, h(async (req, res) => {
    const rows = await repo.listMarkets({
      filter: String(req.query.filter ?? 'all'),
      search: String(req.query.search ?? ''),
      limit: Math.min(Number(req.query.limit) || 200, 500),
    });
    res.json({ markets: rows, count: await repo.marketCount() });
  }));

  api.get('/markets/:ticker/history', requireAuth, h(async (req, res) => {
    res.json({
      history: await repo.priceHistory(req.params.ticker, Math.min(Number(req.query.limit) || 200, 1000)),
    });
  }));

  /* ----------------------------------------------------------------- alerts */

  api.get('/alerts', requireAuth, h(async (req, res) => {
    res.json({ alerts: await repo.listAlerts({ status: String(req.query.status ?? 'open') }) });
  }));

  api.post('/alerts/:id/dismiss', requireAuth, h(async (req, res) => {
    const a = await repo.resolveAlert(Number(req.params.id), 'dismissed');
    if (!a) return res.status(404).json({ error: 'not_found', message: 'Alert is not open.' });
    res.json({ alert: a });
  }));

  api.post('/alerts/dismiss-all', requireAuth, h(async (_req, res) => {
    res.json({ dismissed: await repo.dismissAllAlerts() });
  }));

  api.post('/alerts/:id/execute', requireAuth, h(async (req, res) => {
    const out = await executeAlert(kalshi, Number(req.params.id), {
      sizeOverride: req.body?.contracts ? Number(req.body.contracts) : undefined,
    });
    res.status(out.ok ? 200 : 502).json(out);
  }));

  /* ----------------------------------------------------------------- trades */

  api.get('/trades', requireAuth, h(async (req, res) => {
    res.json({ trades: await repo.listTrades({ filter: String(req.query.filter ?? 'all') }) });
  }));

  /* -------------------------------------------------------------- dashboard */

  api.get('/overview', requireAuth, h(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const stats = await repo.overviewStats();
    const pnl = await repo.pnlSeries(days);
    const alerts = await repo.listAlerts({ status: 'open', limit: 4 });
    const sync = await repo.lastSync();
    res.json({ stats, pnl, alerts, sync, kalshi: getAuthState() });
  }));

  api.get('/analytics', requireAuth, h(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const buckets = await repo.pnlByGapBucket();
    const wr = await repo.winRate();
    const ev = await repo.evCapturedPerDay(days);
    const pnl = await repo.pnlSeries(days);
    const signalBuckets = await repo.signalsByGapBucket();
    const edgePerDay = await repo.edgeFoundPerDay(days);
    const coverage = await repo.pricingCoverage();
    res.json({ buckets, winRate: wr, evPerDay: ev, pnl, signalBuckets, edgePerDay, coverage });
  }));

  api.get('/pnl', requireAuth, h(async (req, res) => {
    res.json({ pnl: await repo.pnlSeries(Math.min(Number(req.query.days) || 30, 90)) });
  }));

  /* --------------------------------------------------------------- settings */

  api.get('/settings', requireAuth, h(async (_req, res) => {
    res.json({ settings: await repo.getSettings() });
  }));

  api.patch('/settings', requireAuth, requireAdmin, h(async (req, res) => {
    res.json({ settings: await repo.updateSettings(req.body ?? {}) });
  }));

  /* ------------------------------------------------------------- operations */

  /**
   * Sync pass. Cron calls this on a schedule; it is also safe to call by hand.
   * Guarded by CRON_SECRET so a public deployment cannot be made to hammer the
   * Kalshi API by anyone who finds the URL.
   */
  api.all('/sync', h(async (req, res) => {
    if (!requireCronOrAdmin(req, res)) return;
    await reapStaleRuns().catch(() => {});
    res.json(await runSync(kalshi, { verbose: true }));
  }));

  /** Imports UTR ratings for newly discovered competitors. Cron-driven. */
  api.all('/ratings/backfill', h(async (req, res) => {
    if (!requireCronOrAdmin(req, res)) return;
    const limit = Math.min(Number(req.query.limit) || 40, 120);
    const stats = await backfillRatings({ limit, delayMs: 220 });
    res.json({ ...stats, coverage: await ratingsCoverage() });
  }));

  api.all('/portfolio/snapshot', h(async (req, res) => {
    if (req.method !== 'GET' && !requireCronOrAdmin(req, res)) return;
    res.json({ snapshot: await snapshotPortfolio(kalshi), kalshi: getAuthState() });
  }));

  api.all('/trades/reconcile', h(async (req, res) => {
    if (!requireCronOrAdmin(req, res)) return;
    const orders = await reconcileTrades(kalshi);
    // settles both live and paper positions against Kalshi's own result
    const settlement = await repo.settleResolvedTrades(kalshi);
    res.json({ orders, settlement });
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
