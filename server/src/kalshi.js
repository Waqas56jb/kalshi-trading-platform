import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';

/**
 * Kalshi Trade API v2 client.
 *
 * Auth is an RSA-PSS signature over `timestamp + METHOD + path`, where `path`
 * includes the `/trade-api/v2` prefix but excludes the query string. Salt
 * length must equal the digest length (32 bytes for SHA-256).
 */
export class KalshiClient {
  constructor({ base, keyId, privateKeyPath, privateKeyPem }) {
    this.base = (base || 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '');
    this.keyId = keyId;
    const pem = privateKeyPem || fs.readFileSync(privateKeyPath, 'utf8');
    this.privateKey = crypto.createPrivateKey(pem);
    this.basePath = new URL(this.base).pathname.replace(/\/$/, '');
  }

  sign(timestamp, method, path) {
    return crypto.sign('sha256', Buffer.from(`${timestamp}${method}${path}`), {
      key: this.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
  }

  /**
   * Signs and sends one request.
   *
   * A transient network fault or a 429/5xx is retried with backoff — a single
   * blip should not abort a whole sync pass. Auth and other 4xx failures are
   * surfaced immediately, since retrying them changes nothing. The signature is
   * regenerated per attempt because it is bound to a timestamp the exchange
   * will reject if it drifts.
   */
  async request(method, endpoint, { query, body, signal, retries = 2, timeoutMs = 20_000 } = {}) {
    const path = this.basePath + endpoint;
    const url = new URL(this.base + endpoint);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 400 * 2 ** (attempt - 1)));

      const ts = Date.now().toString();
      const timer = AbortSignal.timeout(timeoutMs);
      const composite = signal ? AbortSignal.any([signal, timer]) : timer;

      let res;
      try {
        res = await fetch(url, {
          method,
          signal: composite,
          headers: {
            'KALSHI-ACCESS-KEY': this.keyId,
            'KALSHI-ACCESS-TIMESTAMP': ts,
            'KALSHI-ACCESS-SIGNATURE': this.sign(ts, method, path),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        lastErr = new Error(`Kalshi ${method} ${endpoint} network error: ${e.message}`);
        lastErr.cause = e;
        if (signal?.aborted) throw lastErr;
        continue;                                    // network fault — retry
      }

      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

      if (res.ok) return json;

      const err = new Error(`Kalshi ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      err.body = json;

      // 429 and 5xx are worth another go; everything else is deterministic
      if (res.status === 429 || res.status >= 500) { lastErr = err; continue; }
      throw err;
    }
    throw lastErr;
  }

  get = (endpoint, query, opts) => this.request('GET', endpoint, { query, ...opts });
  post = (endpoint, body, opts) => this.request('POST', endpoint, { body, ...opts });
  del = (endpoint, opts) => this.request('DELETE', endpoint, opts);

  /* ---- market data ---- */
  exchangeStatus = () => this.get('/exchange/status');
  getSeriesList = category => this.get('/series', { category });
  getEvents = q => this.get('/events', q);
  getMarkets = q => this.get('/markets', q);
  getMarket = ticker => this.get(`/markets/${ticker}`);
  getOrderbook = (ticker, depth = 10) => this.get(`/markets/${ticker}/orderbook`, { depth });

  /* ---- portfolio (authenticated) ---- */
  getBalance = () => this.get('/portfolio/balance');
  getPositions = q => this.get('/portfolio/positions', q);
  getFills = q => this.get('/portfolio/fills', q);
  getOrders = q => this.get('/portfolio/orders', q);
  createOrder = body => this.post('/portfolio/orders', body);
  cancelOrder = id => this.del(`/portfolio/orders/${id}`);

  /** Walks the cursor until exhausted or `max` rows collected. */
  async getAllMarkets(query = {}, max = 1000) {
    const out = [];
    let cursor;
    do {
      const page = await this.getMarkets({ limit: 200, ...query, cursor });
      const rows = page?.markets ?? [];
      out.push(...rows);
      cursor = page?.cursor || null;
      if (!rows.length) break;
    } while (cursor && out.length < max);
    return out.slice(0, max);
  }
}

/**
 * Builds a client from config. Prefers an inline PEM (set in the environment on
 * serverless hosts) and falls back to the on-disk key used locally.
 */
export function clientFromEnv() {
  return new KalshiClient({
    base: config.kalshi.base,
    keyId: config.kalshi.keyId,
    privateKeyPem: config.kalshi.privateKeyPem,
    privateKeyPath: config.kalshi.privateKeyPath,
  });
}
