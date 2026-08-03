import express from 'express';
import cors from 'cors';
import { config, configErrors, t } from './config.js';
import { ping, query } from './db.js';
import { clientFromEnv } from './kalshi.js';
import { runSync, reapStaleRuns, maybeAutoSync } from './sync.js';
import {
  buildDataset, datasetSummary, buildBreakdowns, breakdownRows,
  COLUMNS, FEATURE_COLUMNS, TARGET_COLUMN, RANGE_NAMES, BREAKDOWN_COLUMNS,
} from './dataset.js';
import { toCsv, toXlsx } from './xlsx.js';
import {
  runShadowCycle, shadowSummary, loadRiskConfig, gateComparison,
  archivePreNewFormulaDesk, paperReplayWrongHolds, NEW_FORMULA_SINCE,
} from './shadow.js';
import { recomputeCalibration, refitUtrCurve, loadUtrCurve, loadUtrSlope } from './calibration.js';
import { simulateFormulas } from './simulator.js';
import { oddsFeedConfigured } from './oddsfeed.js';
import {
  autoSellAtFair, checkKalshiAuth, closePosition, getAuthState, livePositions,
  reconcileTrades, snapshotPortfolio,
} from './orders.js';
import { probe as probeSchedule, syncSchedule } from './schedule.js';
import { importKalshiHistory } from './importer.js';
import * as repo from './repo.js';
import { backfillRatings, ratingsCoverage, scrubUnusableRatings } from './ratings.js';
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

  const originAllowed = origin => {
    if (config.corsOrigin.includes(origin)) return true;
    let host;
    try { host = new URL(origin).hostname; } catch { return false; }
    if (config.allowAnyLocalhost && /^(localhost|127\.0\.0\.1)$/.test(host)) return true;
    return /\.vercel\.app$/.test(host);
  };

  /* Credentials on, because the session travels in an httpOnly cookie. Safe
     with this CORS setup only because the origin callback echoes a specific
     allowlisted origin, never `*`. */
  app.use(cors({
    credentials: true,
    origin(origin, cb) {
      if (!origin) return cb(null, true);                     // curl / server-to-server
      cb(null, originAllowed(origin));                        // reject without throwing
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

  /* The session lives in an httpOnly cookie so no script on the page can read
     it — the localStorage token the audit flagged is gone. The bearer header is
     still accepted: it is what keeps Safari working, where a cookie set by a
     different site (the API and the dashboard are separate Vercel projects)
     is refused outright. */
  const SESSION_COOKIE = 'courtedge_token';
  const TOKEN_TTL_SECONDS = 60 * 60 * 12;                     // matches signToken

  const cookieToken = req => {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) {
        try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
      }
    }
    return null;
  };

  /* Cross-site in production (separate Vercel projects) requires
     SameSite=None + Secure; local dev over http gets Lax, which is enough when
     both halves run on localhost. */
  const cookieAttrs = maxAge => `Path=/; HttpOnly; Max-Age=${maxAge}; `
    + (process.env.VERCEL ? 'SameSite=None; Secure' : 'SameSite=Lax');
  const setSessionCookie = (res, token) =>
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(TOKEN_TTL_SECONDS)}`);
  const clearSessionCookie = res =>
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttrs(0)}`);

  /** Attaches req.user when a valid session token is present. Never rejects. */
  const readSession = (req, _res, next) => {
    req.user = null;
    req.authViaCookie = false;
    const fromHeader = bearer(req);
    const tok = fromHeader ?? cookieToken(req);
    if (tok && authConfigured()) {
      try {
        const c = verifyToken(tok);
        if (c) {
          req.user = { id: Number(c.sub), email: c.email, role: c.role };
          req.authViaCookie = !fromHeader;
        }
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
    /* CSRF gate. A SameSite=None cookie rides along on cross-site form posts,
       which a bearer header never did, so a write authenticated only by the
       cookie must come from an allowlisted origin. Browsers always attach
       Origin to non-GET requests; a request without one is not a browser form
       post and passes. */
    if (req.authViaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && !originAllowed(origin)) {
        return res.status(403).json({ error: 'bad_origin', message: 'Request origin is not allowed.' });
      }
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

  api.get('/health', h(async (req, res) => {
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
    /* The cookie is the session where the browser permits it; the token in the
       body is the fallback the client keeps in memory for browsers that refuse
       a cross-site cookie. Both travel over TLS. */
    setSessionCookie(res, result.token);
    res.json(result);
  }));

  api.post('/auth/logout', h(async (req, res) => {
    if (req.user) {
      await logAuthEvent({ userId: req.user.id, email: req.user.email, event: 'logout', req });
    }
    clearSessionCookie(res);
    res.json({ ok: true });
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

  /**
   * Background tick. The dashboard calls this on its own timer and ignores the
   * result, so a sync taking half a minute never delays anything on screen.
   * Deliberately not folded into /health, which is polled every 15s and must stay
   * fast. The lock inside maybeAutoSync means extra callers cost nothing.
   */
  api.all('/tick', requireAuth, h(async (_req, res) => {
    res.json(await maybeAutoSync(kalshi));
  }));

  /* ---------------------------------------------------------------- markets */

  api.get('/markets', requireAuth, h(async (req, res) => {
    const sort = ['edge', 'ev', 'starts'].includes(req.query.sort) ? req.query.sort : 'edge';
    const rows = await repo.listMarkets({
      filter: String(req.query.filter ?? 'all'),
      search: String(req.query.search ?? ''),
      limit: Math.min(Number(req.query.limit) || 200, 500),
      sort,
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
    const side = ['favourite', 'underdog', 'pickem'].includes(req.query.side) ? req.query.side : 'all';
    res.json({ alerts: await repo.listAlerts({ status: String(req.query.status ?? 'open'), side }) });
  }));

  api.post('/alerts/:id/dismiss', requireAuth, h(async (req, res) => {
    const a = await repo.resolveAlert(Number(req.params.id), 'dismissed');
    if (!a) return res.status(404).json({ error: 'not_found', message: 'Alert is not open.' });
    res.json({ alert: a });
  }));

  api.post('/alerts/dismiss-all', requireAuth, h(async (_req, res) => {
    res.json({ dismissed: await repo.dismissAllAlerts() });
  }));

  /* Manual alert execution removed — the shadow desk is the only placement
     path. Keeping the route as Gone so an old client cannot resurrect the
     flat stake_per_trade bypass that printed $249 on Slavikova. */
  api.post('/alerts/:id/execute', requireAuth, h(async (_req, res) => {
    res.status(410).json({
      error: 'alerts_removed',
      message: 'Manual alert trading is disabled. The shadow desk places its own trades.',
    });
  }));

  /* ----------------------------------------------------------------- trades */

  /** Sell out of a position at the current bid. */
  api.post('/trades/:id/close', requireAuth, h(async (req, res) => {
    const out = await closePosition(kalshi, Number(req.params.id), { reason: 'manual' });
    res.status(out.ok ? 200 : 400).json(out);
  }));

  /** Pulls the account's real Kalshi trading into the ledger. */
  api.all('/trades/import', h(async (req, res) => {
    if (!requireCronOrAdmin(req, res)) return;
    res.json(await importKalshiHistory(kalshi));
  }));

  api.all('/trades/auto-sell', h(async (req, res) => {
    if (!requireCronOrAdmin(req, res)) return;
    res.json(await autoSellAtFair(kalshi));
  }));

  /* -------------------------------------------------------------- schedule --- */

  /** Reports which Sofascore hosts answer from wherever this is deployed. */
  api.get('/schedule/probe', requireAuth, requireAdmin, h(async (_req, res) => {
    res.json({ hosts: await probeSchedule(), runtime: process.env.VERCEL ? 'vercel' : 'node' });
  }));

  api.all('/schedule/sync', h(async (req, res) => {
    if (!requireCronOrAdmin(req, res)) return;
    res.json(await syncSchedule({ date: req.query.date }));
  }));

  /** The client's real Kalshi positions, straight from the exchange. */
  api.get('/portfolio/positions', requireAuth, h(async (_req, res) => {
    res.json(await livePositions(kalshi));
  }));

  api.get('/trades', requireAuth, h(async (req, res) => {
    /* Clear pre-era Lost/Won from the desk view, then book any local settlements. */
    await archivePreNewFormulaDesk().catch(() => null);
    await repo.settleResolvedTrades(null, { localOnly: true }).catch(() => null);
    res.json({
      trades: await repo.listTrades({ filter: String(req.query.filter ?? 'all') }),
      deskSince: NEW_FORMULA_SINCE,
    });
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

  /* ----------------------------------------------------------------- shadow */

  /** Simulated performance, plus the per-bracket breakdown the client asked for. */
  api.get('/shadow/summary', requireAuth, h(async (_req, res) => {
    await archivePreNewFormulaDesk().catch(() => null);
    const [summary, cfg] = await Promise.all([shadowSummary(), loadRiskConfig()]);
    res.json({
      summary,
      mode: {
        shadow: cfg.shadowMode,
        autoPlace: cfg.shadowAutoPlace,
        bankroll: cfg.simulatedBankrollCents / 100,
        cashReservePct: Math.round(cfg.minimumFreeCashFraction * 100),
        /* Live capped floor from summary — not the uncapped settings row. */
        minPriceCents: summary.floor?.live
          ?? Math.min(25, Math.max(15, cfg.minPriceCents)),
        floorRaw: summary.floor?.raw ?? null,
        crossMarket: cfg.crossMarketEnabled,
        oddsFeed: oddsFeedConfigured(),
        deskSince: NEW_FORMULA_SINCE,
        askOnly: true,
      },
    });
  }));

  /**
   * Every decision, approved and rejected alike.
   *
   * Rejections are the point of this endpoint. A gate that silently drops
   * opportunities is how the old 0.5 UTR minimum went unnoticed while it was
   * costing 68 signals a day.
   */
  api.get('/shadow/decisions', requireAuth, h(async (req, res) => {
    await archivePreNewFormulaDesk().catch(() => null);
    const approved = req.query.approved;
    const limit = Math.min(300, Number(req.query.limit) || 100);
    const filter = approved === 'true' ? 'and approved'
      : approved === 'false' ? 'and not approved' : '';
    /* Newest first — ranking by edge buried today's engine activity under older
       high-edge rows, which made the desk look 24h out of date. */
    const r = await query(
      `select ticker, player_name, opponent_name, side, utr_gap, utr_bracket,
              model_probability, market_reference, conservative_prob,
              best_ask_cents, expected_vwap_cents, max_price_cents, book_depth_levels,
              approved, net_edge, expected_roi, full_kelly, kelly_multiplier,
              base_cap_fraction, edge_scaling_mult, effective_cap, throttle_multiplier,
              stake_usd, contracts, limiting_constraint, rejection_reason,
              result, pnl_usd, match_date, created_at
       from ${t('shadow_trades')}
       where archived_at is null ${filter}
       order by created_at desc
       limit $1`, [limit]);
    res.json({ decisions: r.rows, deskSince: NEW_FORMULA_SINCE });
  }));

  api.post('/shadow/run', requireAuth, h(async (_req, res) => {
    res.json(await runShadowCycle(kalshi, { verbose: false }));
  }));

  /** One-shot paper replay of wrongly held asks for learning (Max/Robbie). */
  api.post('/shadow/replay-holds', requireAuth, h(async (_req, res) => {
    res.json(await paperReplayWrongHolds({ hours: 48, stakeUsd: 20 }));
  }));

  /* ------------------------------------------------------------ calibration */

  api.get('/calibration', requireAuth, h(async (_req, res) => {
    const [buckets, curve, slope] = await Promise.all([
      query(`select bucket, sample_size, mean_predicted, actual_rate,
                    calibration_error, verified, computed_at
             from ${t('calibration')} order by bucket`),
      loadUtrCurve(),
      loadUtrSlope().catch(() => null),
    ]);
    res.json({ buckets: buckets.rows, curve, slope });
  }));

  api.post('/calibration/recompute', requireAuth, h(async (_req, res) => {
    const [calibration, curve] = await Promise.all([
      recomputeCalibration({ minSample: 40 }),
      refitUtrCurve({ minSample: 40 }),
    ]);
    res.json({ calibration, curve });
  }));

  /* Bets confirmed by the odds API versus bets the formula would take
     regardless — the comparison the client asked for. Builds forward from the
     day odds recording began. */
  api.get('/model/gate-comparison', requireAuth, h(async (_req, res) => {
    res.json(await gateComparison());
  }));

  /* Replays settled matches under three fair-value formulas and reports each
     one's P&L — how the desk compares candidate formulas on evidence rather
     than argument. Parameters are clamped, not trusted. */
  api.get('/model/simulate', requireAuth, h(async (req, res) => {
    const num = (v, d, lo, hi) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    };
    res.json(await simulateFormulas({
      minEdgeCents: num(req.query.min_edge, 4, 0, 50),
      stakeUsd: num(req.query.stake, 100, 1, 10000),
      floorCents: num(req.query.floor, 25, 1, 95),
    }));
  }));

  /* ---------------------------------------------------------------- dataset */

  api.get('/dataset/summary', requireAuth, h(async (req, res) => {
    const range = String(req.query.range ?? 'week');
    if (!RANGE_NAMES.includes(range)) return res.status(400).json({ error: 'bad_range' });
    res.json({ summary: await datasetSummary({ range }), ranges: RANGE_NAMES });
  }));

  /**
   * Downloads the training set.
   *
   * Sent as an attachment with an explicit filename so a browser saves it rather
   * than rendering a few hundred kilobytes of CSV into the tab.
   */
  api.get('/dataset/export', requireAuth, h(async (req, res) => {
    const range = String(req.query.range ?? 'week');
    const format = String(req.query.format ?? 'csv').toLowerCase();
    if (!RANGE_NAMES.includes(range)) return res.status(400).json({ error: 'bad_range' });
    if (!['csv', 'xlsx'].includes(format)) return res.status(400).json({ error: 'bad_format' });

    const { columns, rows } = await buildDataset({ range });
    if (!rows.length) return res.status(404).json({ error: 'no_settled_matches_in_range' });

    const stamp = rows[0].match_date ?? 'export';
    const name = `courtedge-tennis-${range}-${stamp}.${format}`;
    const body = format === 'xlsx' ? toXlsx(columns, rows, 'dataset') : toCsv(columns, rows);

    res.setHeader('Content-Type', format === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', body.length);
    // the browser must be able to read the filename back out of a fetch() response
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(body);
  }));

  /** Profitability by month, day of week, round, and men's against women's. */
  api.get('/dataset/breakdowns', requireAuth, h(async (req, res) => {
    const range = String(req.query.range ?? 'all');
    if (!RANGE_NAMES.includes(range)) return res.status(400).json({ error: 'bad_range' });
    res.json(await buildBreakdowns({ range }));
  }));

  api.get('/dataset/breakdowns/export', requireAuth, h(async (req, res) => {
    const range = String(req.query.range ?? 'all');
    const format = String(req.query.format ?? 'csv').toLowerCase();
    if (!RANGE_NAMES.includes(range)) return res.status(400).json({ error: 'bad_range' });
    if (!['csv', 'xlsx'].includes(format)) return res.status(400).json({ error: 'bad_format' });

    const rows = breakdownRows(await buildBreakdowns({ range }));
    if (!rows.length) return res.status(404).json({ error: 'no_settled_matches_in_range' });

    const name = `courtedge-breakdowns-${range}.${format}`;
    const body = format === 'xlsx'
      ? toXlsx(BREAKDOWN_COLUMNS, rows, 'breakdowns')
      : toCsv(BREAKDOWN_COLUMNS, rows);
    res.setHeader('Content-Type', format === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(body);
  }));

  /** The column contract, so whoever trains knows which fields are safe to use. */
  api.get('/dataset/schema', requireAuth, h(async (_req, res) => {
    res.json({
      target: TARGET_COLUMN,
      features: FEATURE_COLUMNS,
      leakage: COLUMNS.filter(c => c.startsWith('final_')),
      identifiers: ['match_date', 'ticker', 'event_ticker', 'player_name', 'opponent_name', 'close_time'],
      note: 'final_* columns are the settled quote and leak the outcome. Train on the rest.',
    });
  }));

  /* --------------------------------------------------------------- settings */

  api.get('/settings', requireAuth, h(async (_req, res) => {
    res.json({ settings: await repo.getSettings() });
  }));

  /* Strategy is the trader's own instrument, not an administrative setting.
     Gating it on the admin role locked the desk's owner out of his own risk
     limits: he could see a spread guard blocking a trade he wanted to take and
     had no way to widen it. Account management below stays admin-only. */
  api.patch('/settings', requireAuth, h(async (req, res) => {
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

  /** Imports UTR ratings for newly discovered competitors. Cron-driven.
      ?retry=1 re-attempts players that previously failed or came back
      unrated — useful after credentials change what UTR will reveal. */
  api.all('/ratings/backfill', h(async (req, res) => {
    if (!requireCronOrAdmin(req, res)) return;
    const limit = Math.min(Number(req.query.limit) || 40, 120);
    const retryFailed = req.query.retry === '1';
    const scrub = req.query.scrub === '1'
      ? await scrubUnusableRatings().catch(() => null)
      : null;
    const stats = await backfillRatings({ limit, delayMs: 220, retryFailed });
    res.json({ ...stats, scrub, coverage: await ratingsCoverage() });
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
