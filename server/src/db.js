import pg from 'pg';
import { config } from './config.js';

/**
 * Supabase's session pooler closes idle connections on its own schedule, so a
 * pooled client can be dead by the time we reuse it. The pool recycles well
 * before the pooler's own timeout, and `query` retries once on the transient
 * connection errors that still slip through.
 */
/* On serverless every warm container holds its own pool, so a generous `max`
   multiplies across containers and exhausts the shared Supabase pooler. Keep it
   tiny there and let an idle container release its socket; a long-running
   process can afford a real pool. */
const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: { rejectUnauthorized: false },
  /* Supabase's session pooler allows 15 clients across the whole project, shared
     by every serverless container, local process and CLI run. Keep well under it. */
  max: SERVERLESS ? 2 : 4,
  idleTimeoutMillis: SERVERLESS ? 5_000 : 10_000,
  connectionTimeoutMillis: SERVERLESS ? 12_000 : 30_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 5_000,
  allowExitOnIdle: SERVERLESS,
});

// an idle client erroring must never take the process down
pool.on('error', err => console.error('[db] idle client error:', err.message));

const TRANSIENT = /connection terminated|connection timeout|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|Client has encountered a connection error|server closed the connection/i;

export async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    if (!TRANSIENT.test(e.message)) throw e;
    console.warn('[db] transient error, retrying once:', e.message.slice(0, 90));
    return pool.query(text, params);
  }
}

export async function tx(fn) {
  const run = async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  };

  try {
    return await run();
  } catch (e) {
    if (!TRANSIENT.test(e.message)) throw e;
    console.warn('[db] transient error in tx, retrying once:', e.message.slice(0, 90));
    return run();
  }
}

export async function ping() {
  const r = await query('select now() as now, current_user as usr');
  return r.rows[0];
}

export const closePool = () => pool.end();
