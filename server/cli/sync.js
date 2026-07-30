#!/usr/bin/env node
/**
 * Run one sync pass against Kalshi and exit.
 *   node cli/sync.js
 *   node cli/sync.js --loop        # keep polling
 */
import { clientFromEnv } from '../src/kalshi.js';
import { runSync, startSyncLoop } from '../src/sync.js';
import { closePool } from '../src/db.js';
import { config } from '../src/config.js';

const kalshi = clientFromEnv();

if (process.argv.includes('--loop')) {
  console.log(`polling every ${config.sync.intervalMs}ms — ctrl-c to stop`);
  const stop = startSyncLoop(kalshi);
  process.on('SIGINT', async () => { stop(); await closePool(); process.exit(0); });
} else {
  console.log(`sync: ${config.sync.seriesTickers.join(', ')}`);
  const r = await runSync(kalshi, { verbose: true });
  console.log(JSON.stringify(r, null, 2));
  await closePool();
}
