import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

/**
 * Records a missing required variable instead of throwing.
 *
 * This module is imported at module load on serverless hosts, so throwing here
 * would crash every route — including /api/health, which is the endpoint that
 * should still be reachable to report the misconfiguration.
 */
export const configErrors = [];

function req(name, hint = '') {
  const v = process.env[name];
  if (!v) {
    configErrors.push(`${name} is not set${hint ? ` — ${hint}` : ''}`);
    return '';
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  env: process.env.NODE_ENV || 'development',
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim()),
  // In development the client may run on the Vite dev port or any preview port,
  // so allow loopback origins outright rather than chasing port numbers.
  allowAnyLocalhost: (process.env.NODE_ENV || 'development') !== 'production',

  kalshi: {
    base: process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2',
    keyId: process.env.KALSHI_API_KEY_ID || '',
    privateKeyPath: path.resolve(ROOT, process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem'),
    /* Serverless deployments have no writable secret file, so the PEM is supplied
       as an env var. Dashboard UIs often mangle newlines into a literal \n, so
       those are restored before the key is parsed. */
    privateKeyPem: process.env.KALSHI_PRIVATE_KEY
      ? process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, '\n').trim()
      : null,
  },

  db: {
    url: req('DATABASE_URL', 'use the Supabase session pooler and percent-encode the password'),
    prefix: process.env.DB_TABLE_PREFIX || 'kalshi_',
  },

  supabase: {
    url: process.env.SUPABASE_URL || '',
    projectRef: process.env.SUPABASE_PROJECT_REF || '',
  },

  sync: {
    intervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
    // Kalshi tennis series this desk trades. ITF men's + women's singles.
    seriesTickers: (process.env.SERIES_TICKERS || 'KXITFMATCH,KXITFWMATCH').split(',').map(s => s.trim()),
  },
};

/** `t('markets')` -> `kalshi_markets`. Keeps the prefix in exactly one place. */
export const t = name => `public.${config.db.prefix}${name}`;
