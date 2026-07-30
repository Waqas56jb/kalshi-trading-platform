#!/usr/bin/env node
/**
 * Backfill UTR ratings for every competitor seen in Kalshi markets.
 *   node cli/ratings.js              # fill in missing ratings
 *   node cli/ratings.js --retry      # also retry players that previously missed
 *   node cli/ratings.js --limit 50
 */
import { backfillRatings, ratingsCoverage } from '../src/ratings.js';
import { closePool } from '../src/db.js';

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const limit = Number(arg('--limit', 600));
const retryFailed = process.argv.includes('--retry');

console.log(`UTR backfill — limit=${limit} retryFailed=${retryFailed}`);
console.log('before:', JSON.stringify(await ratingsCoverage()));

const t0 = Date.now();
const stats = await backfillRatings({
  limit,
  retryFailed,
  onProgress: (i, n, name, hit) => {
    if (i % 25 === 0 || i === n) {
      process.stdout.write(`  ${i}/${n}  last: ${name} -> ${hit?.utr ?? '—'} (${hit?.utr_status ?? 'no match'})\n`);
    }
  },
});

console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(stats));
console.log('after: ', JSON.stringify(await ratingsCoverage()));
await closePool();
