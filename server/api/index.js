/**
 * Vercel serverless entrypoint for the backend project.
 *
 * Deploy `server/` as its own Vercel project (Root Directory = server). Every
 * /api/* request is rewritten here and handed to the same Express app used
 * locally. The app is constructed once per container and reused across warm
 * invocations, so the Postgres pool and the cached Kalshi auth verdict survive
 * between requests.
 *
 * Sync cannot run on a timer here — a serverless function is frozen between
 * requests — so it is driven by Cron hitting /api/sync instead.
 */
import { createApp } from '../src/app.js';

const { app } = createApp();

export default app;
