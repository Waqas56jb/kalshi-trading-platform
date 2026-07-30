/**
 * Local development entrypoint: listens on a port and drives sync in-process.
 *
 * On Vercel the app is served from /api/index.js instead and sync is driven by
 * Cron, because a serverless function is frozen between requests and cannot
 * hold a timer.
 */
import { createApp } from './app.js';
import { config } from './config.js';
import { reapStaleRuns, startSyncLoop } from './sync.js';
import { checkKalshiAuth } from './orders.js';

const { app, kalshi } = createApp();

const server = app.listen(config.port, async () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
  console.log(`[api] cors origins: ${config.corsOrigin.join(', ')}`);

  const reaped = await reapStaleRuns().catch(() => 0);
  if (reaped) console.log(`[sync] reaped ${reaped} sync run(s) abandoned by a previous process`);

  const auth = await checkKalshiAuth(kalshi);
  console.log(`[kalshi] market data: ok · trading: ${auth.ok ? 'ok' : `UNAUTHENTICATED (${auth.error})`}`);

  if (process.env.SYNC_ON_BOOT !== 'false') {
    const stop = startSyncLoop(kalshi);
    server.on('close', stop);
    console.log(`[sync] polling every ${config.sync.intervalMs}ms for ${config.sync.seriesTickers.join(', ')}`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[api] ${sig} — shutting down`);
    server.close(() => process.exit(0));
  });
}
