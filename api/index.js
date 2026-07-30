/**
 * Vercel serverless entrypoint.
 *
 * Every /api/* request is rewritten here (see vercel.json) and handed to the same
 * Express app used locally. The app is built once per container and reused across
 * warm invocations, so the Postgres pool and the cached Kalshi auth verdict
 * survive between requests.
 */
import { createApp } from '../server/src/app.js';

const { app } = createApp();

export default app;
