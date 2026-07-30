/**
 * Vercel serverless entrypoint for the backend project.
 *
 * Deploy `server/` as its own Vercel project (Root Directory = server).
 *
 * This is a catch-all filesystem route rather than a rewrite target on purpose:
 * a rewrite would hand Express the *rewritten* path, so `/api/health` would
 * arrive as `/api/index` and fall through to the 404 handler. Filesystem routing
 * invokes this file for every `/api/*` request with the original URL intact, so
 * the Express routes match exactly as they do locally.
 *
 * The app is constructed once per container and reused across warm invocations,
 * so the Postgres pool and the cached Kalshi auth verdict survive between
 * requests. Sync cannot run on a timer here — a serverless function is frozen
 * between requests — so Cron drives it by calling /api/sync.
 */
import { createApp } from '../src/app.js';

const { app } = createApp();

export default app;
