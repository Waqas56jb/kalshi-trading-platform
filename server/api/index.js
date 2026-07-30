/**
 * Vercel serverless entrypoint for the backend project.
 *
 * Deploy `server/` as its own Vercel project (Root Directory = server).
 *
 * Every `/api/*` request is rewritten here by `vercel.json`. A `[...slug]`
 * catch-all was tried first and is wrong for a non-framework project: it matched
 * only one segment, so `/api/health` worked while `/api/alerts/12/dismiss` and
 * `/api/markets/:ticker/history` returned a platform 404 without ever reaching
 * this function. An explicit `:path*` rewrite matches every depth.
 *
 * Rewrites are transparent to the destination, so Express still sees the
 * original URL. The routes are additionally mounted at both `/api` and `/` in
 * `src/app.js`, so the API answers even if a platform rewrites the path.
 *
 * The app is constructed once per container and reused across warm invocations,
 * so the Postgres pool and the cached Kalshi auth verdict survive between
 * requests. Sync cannot run on a timer here — a serverless function is frozen
 * between requests — so Cron drives it by calling /api/sync.
 */
import { createApp } from '../src/app.js';

const { app } = createApp();

export default app;
