import dns from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Resolves hostnames over HTTPS when the system resolver cannot.
 *
 * Some networks answer port-53 queries for api.elections.kalshi.com with
 * NXDOMAIN while the domain resolves perfectly elsewhere — the desk's own
 * Vercel deployment reaches it without trouble, and Cloudflare and Google both
 * return A records for it over HTTPS. On such a network every Kalshi call fails
 * as `fetch failed / ENOTFOUND` before a single byte leaves the machine, which
 * looks exactly like an outage or a bad key and is neither.
 *
 * DNS-over-HTTPS runs on 443, so it is unaffected. This resolver is a fallback
 * only: the system resolver is always tried first and DoH is consulted just
 * when it fails, so a normal network behaves exactly as before.
 *
 * TLS is untouched. Only the address lookup is replaced, so the certificate is
 * still validated against the hostname via SNI.
 */

const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];

/* Successful answers are cached for their TTL, failures briefly, so a hostname
   that is genuinely wrong is not re-queried on every request. */
const cache = new Map();
const MIN_TTL_MS = 30_000;
const FAILURE_TTL_MS = 10_000;

async function resolveOverHttps(hostname) {
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=A`;
      const res = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const answers = (body.Answer ?? []).filter(a => a.type === 1);
      if (!answers.length) continue;
      return {
        addresses: answers.map(a => a.data),
        ttlMs: Math.max(MIN_TTL_MS, (answers[0].TTL ?? 60) * 1000),
      };
    } catch {
      /* try the next endpoint; both being unreachable is a real network fault */
    }
  }
  return null;
}

/**
 * A `lookup` in the shape Node's http stack expects, falling back to DoH.
 *
 * The callback contract is the awkward part: with `all: true` it wants an array
 * of `{address, family}`, and without it two positional arguments. Getting that
 * wrong makes every request hang rather than fail, so both shapes are honoured.
 */
export function resilientLookup(hostname, options, callback) {
  const done = (err, result) => {
    if (err) return callback(err);
    if (options?.all) return callback(null, result);
    return callback(null, result[0].address, result[0].family);
  };

  dns.lookup(hostname, { ...options, all: true }, async (err, addresses) => {
    if (!err && addresses?.length) return done(null, addresses);

    const cached = cache.get(hostname);
    if (cached && cached.expires > Date.now()) {
      if (!cached.addresses) return callback(err ?? new Error(`ENOTFOUND ${hostname}`));
      return done(null, cached.addresses.map(address => ({ address, family: 4 })));
    }

    const resolved = await resolveOverHttps(hostname);
    if (!resolved) {
      cache.set(hostname, { addresses: null, expires: Date.now() + FAILURE_TTL_MS });
      return callback(err ?? new Error(`ENOTFOUND ${hostname}`));
    }

    cache.set(hostname, {
      addresses: resolved.addresses,
      expires: Date.now() + resolved.ttlMs,
    });
    return done(null, resolved.addresses.map(address => ({ address, family: 4 })));
  });
}

let installed = false;

/**
 * Routes every outbound fetch through the resilient lookup.
 *
 * Called once at start-up. Safe on a healthy network: the system resolver
 * answers first every time and DoH is never reached.
 */
export function installResilientDns() {
  if (installed) return false;
  installed = true;
  setGlobalDispatcher(new Agent({
    connect: { lookup: resilientLookup },
  }));
  return true;
}

/** Diagnostic: which path resolves this host, if any. */
export async function diagnoseHost(hostname) {
  const system = await dns.promises.lookup(hostname).then(a => a.address).catch(e => `FAILED ${e.code}`);
  const doh = await resolveOverHttps(hostname);
  return {
    hostname,
    system,
    doh: doh ? doh.addresses.join(', ') : 'FAILED',
    usingFallback: String(system).startsWith('FAILED') && Boolean(doh),
  };
}
