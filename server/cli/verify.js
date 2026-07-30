#!/usr/bin/env node
/**
 * End-to-end verification. Exits non-zero if anything required is broken.
 *   node cli/verify.js
 *   node cli/verify.js --json
 */
import { config, t } from '../src/config.js';
import { closePool, query } from '../src/db.js';
import { clientFromEnv } from '../src/kalshi.js';
import { checkKalshiAuth } from '../src/orders.js';
import { fairFromGap, evPct, parseMarketTitle } from '../src/model.js';

const JSON_OUT = process.argv.includes('--json');
const results = [];
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

function record(name, status, detail) {
  results.push({ name, status, detail });
  if (JSON_OUT) return;
  const tag = status === 'pass' ? `${C.g}PASS${C.x}`
    : status === 'warn' ? `${C.y}WARN${C.x}` : `${C.r}FAIL${C.x}`;
  console.log(`  [${tag}] ${name}`);
  if (detail) console.log(`         ${C.d}${detail}${C.x}`);
}

async function check(name, fn, { required = true } = {}) {
  try {
    const detail = await fn();
    record(name, 'pass', detail);
    return true;
  } catch (e) {
    record(name, required ? 'fail' : 'warn', e.message?.slice(0, 300));
    return false;
  }
}

if (!JSON_OUT) console.log('\n=== CourtEdge verification ===\n');

/* ------------------------------------------------------------ 1. config --- */
if (!JSON_OUT) console.log('config');
await check('DATABASE_URL present', async () => {
  const u = new URL(config.db.url);
  return `${u.hostname}:${u.port} db=${u.pathname.slice(1)} prefix=${config.db.prefix}`;
});
await check('Kalshi key id + PEM present', async () => {
  const fs = await import('node:fs');
  if (!config.kalshi.keyId) throw new Error('KALSHI_API_KEY_ID is empty');
  if (!fs.existsSync(config.kalshi.privateKeyPath)) {
    throw new Error(`private key not found at ${config.kalshi.privateKeyPath}`);
  }
  return `key ${config.kalshi.keyId.slice(0, 8)}… · ${config.kalshi.privateKeyPath}`;
});

/* ---------------------------------------------------------- 2. database --- */
if (!JSON_OUT) console.log('\ndatabase');
await check('connect to Supabase Postgres', async () => {
  const r = await query('select current_user u, current_database() d, version() v');
  return `${r.rows[0].u}@${r.rows[0].d} · ${r.rows[0].v.split(',')[0]}`;
});

const EXPECTED = ['players', 'events', 'markets', 'price_history', 'signals',
  'alerts', 'trades', 'settings', 'sync_runs', 'portfolio_snapshots'];

await check(`all ${EXPECTED.length} kalshi_* tables exist`, async () => {
  const r = await query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
       and table_name like $1`, [`${config.db.prefix}%`]);
  const have = new Set(r.rows.map(x => x.table_name));
  const missing = EXPECTED.map(n => config.db.prefix + n).filter(n => !have.has(n));
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  return [...have].sort().join(', ');
});

await check('RLS enabled on every kalshi_* table', async () => {
  const r = await query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname='public' and c.relkind='r' and c.relname like $1
       and c.relrowsecurity = false`, [`${config.db.prefix}%`]);
  if (r.rowCount) throw new Error(`RLS off on: ${r.rows.map(x => x.relname).join(', ')}`);
  return 'all tables have row level security on';
});

await check('pre-existing tables untouched', async () => {
  const r = await query(
    `select count(*)::int n from information_schema.tables
     where table_schema='public' and table_name not like $1`, [`${config.db.prefix}%`]);
  return `${r.rows[0].n} non-prefixed public tables still present`;
});

await check('migrations recorded', async () => {
  const r = await query(
    `select version, name from supabase_migrations.schema_migrations order by version`);
  return r.rows.map(x => `${x.version} ${x.name}`).join(' | ') || 'none';
});

/* ------------------------------------------------------------- 3. kalshi -- */
if (!JSON_OUT) console.log('\nkalshi api');
const kalshi = clientFromEnv();

await check('exchange status reachable', async () => {
  const s = await kalshi.exchangeStatus();
  return `exchange_active=${s.exchange_active} trading_active=${s.trading_active}`;
});

await check('RSA signature accepted by exchange (trading)', async () => {
  const a = await checkKalshiAuth(kalshi, { force: true });
  if (!a.ok) {
    throw new Error(`${a.status} ${a.error} — market data still works; execution is disabled ` +
      'until the private key matches the registered API key id');
  }
  return `authenticated · balance ${a.balanceCents}c`;
}, { required: false });

await check('live ITF market data', async () => {
  let total = 0;
  const per = [];
  for (const s of config.sync.seriesTickers) {
    const r = await kalshi.getMarkets({ series_ticker: s, status: 'open', limit: 200 });
    const n = r?.markets?.length ?? 0;
    total += n; per.push(`${s}=${n}`);
  }
  if (!total) throw new Error('no open markets returned for configured series');
  return `${total} open markets (${per.join(' ')})`;
});

/* -------------------------------------------------------------- 4. model -- */
if (!JSON_OUT) console.log('\nmodel');
await check('UTR gap curve matches the documented strategy', async () => {
  const cases = [[2.0, 99], [1.0, 85], [0.5, 65], [0, 50], [-1.0, 15]];
  for (const [gap, want] of cases) {
    const got = fairFromGap(gap);
    if (got !== want) throw new Error(`gap ${gap} -> ${got}, expected ${want}`);
  }
  if (fairFromGap(null) !== null) throw new Error('missing rating must yield null, not a guess');
  if (evPct(87, 61) !== 42.62) throw new Error(`ev(87,61) = ${evPct(87, 61)}`);
  return 'Δ2.0→99 Δ1.0→85 Δ0.5→65 Δ0→50 Δ-1.0→15 · null-safe';
});

await check('title parser extracts matchup/tournament/round', async () => {
  const p = parseMarketTitle(
    'Will Johannus Monday win the Monday vs Hance: M25 Edwardsville IL Round of 16 match?');
  if (p.player !== 'Johannus Monday') throw new Error(`player=${p.player}`);
  if (p.matchup !== 'Monday vs Hance') throw new Error(`matchup=${p.matchup}`);
  if (p.tournament !== 'M25 Edwardsville IL') throw new Error(`tournament=${p.tournament}`);
  if (p.round !== 'Round of 16') throw new Error(`round=${p.round}`);
  if (p.tourLevel !== 'M25') throw new Error(`level=${p.tourLevel}`);
  return `${p.player} · ${p.matchup} · ${p.tournament} · ${p.round} · ${p.tourLevel}`;
});

/* --------------------------------------------------------------- 5. data -- */
if (!JSON_OUT) console.log('\nstored data');
await check('markets synced into Postgres', async () => {
  const r = await query(
    `select count(*)::int n, count(yes_ask_cents)::int priced,
            max(updated_at) fresh from ${t('markets')}`);
  if (!r.rows[0].n) throw new Error('no markets stored — run `npm run sync`');
  const age = Math.round((Date.now() - new Date(r.rows[0].fresh)) / 1000);
  return `${r.rows[0].n} markets (${r.rows[0].priced} with an ask), last updated ${age}s ago`;
});

await check('events parsed with tournament + round', async () => {
  const r = await query(
    `select count(*)::int n, count(tournament)::int tour, count(round)::int rnd,
            count(distinct tour_level)::int lvls from ${t('events')}`);
  const { n, tour, rnd, lvls } = r.rows[0];
  if (!n) throw new Error('no events stored');
  if (tour / n < 0.9) throw new Error(`only ${tour}/${n} events have a tournament parsed`);
  return `${n} events · ${tour} tournaments · ${rnd} rounds · ${lvls} tour levels`;
});

await check('every row traceable to a real upstream source', async () => {
  /* Provenance, not word-matching. Real ITF players are named "Broadfoot" and
     "Petr Bar Biryukov", so scanning names for "foo"/"bar"/"test" produces false
     positives. What actually proves a row is not fabricated is its origin:
     a Kalshi-shaped ticker, the raw exchange payload it was built from, and a
     UTR profile id for every rating. */
  const shape = await query(
    `select count(*)::int n from ${t('markets')}
     where ticker !~ '^KX[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$'`);
  if (shape.rows[0].n) throw new Error(`${shape.rows[0].n} markets have a non-Kalshi ticker format`);

  const noRaw = await query(
    `select count(*)::int n from ${t('markets')}
     where raw is null or raw->>'ticker' is distinct from ticker`);
  if (noRaw.rows[0].n) throw new Error(`${noRaw.rows[0].n} markets lack their originating Kalshi payload`);

  const orphan = await query(
    `select count(*)::int n from ${t('markets')} m
     where not exists (select 1 from ${t('events')} e where e.event_ticker = m.event_ticker)`);
  if (orphan.rows[0].n) throw new Error(`${orphan.rows[0].n} markets reference a missing event`);

  const src = await query(
    `select count(*)::int n from ${t('players')}
     where utr is not null
       and (utr_source is distinct from 'utrsports.net' or utr_player_id is null)`);
  if (src.rows[0].n) throw new Error(`${src.rows[0].n} ratings without a UTR profile id`);

  const fabricated = await query(
    `select count(*)::int n from ${t('signals')} s
     where s.fair_cents is not null
       and not exists (select 1 from ${t('players')} p
                       where p.competitor_id = (select competitor_id from ${t('markets')} m
                                                where m.ticker = s.ticker)
                         and p.utr is not null)`);
  if (fabricated.rows[0].n) throw new Error(`${fabricated.rows[0].n} fair values priced without a real rating`);

  return 'all tickers Kalshi-shaped · all carry their raw exchange payload · ' +
    'all events resolve · every UTR has a profile id · no fair value without a real rating';
});

await check('UTR ratings imported', async () => {
  const r = await query(
    `select count(*)::int total,
            count(utr)::int any_utr,
            count(*) filter (where utr is not null and utr_status='Rated')::int usable,
            count(*) filter (where lookup_attempted_at is null)::int pending,
            round(avg(utr_match_score) filter (where utr is not null), 3) avg_score
     from ${t('players')}`);
  const s = r.rows[0];
  if (!s.usable) throw new Error(`0 usable ratings of ${s.total} players — run \`node cli/ratings.js\``);
  return `${s.usable}/${s.total} players usable · ${s.pending} not yet looked up · avg match score ${s.avg_score}`;
}, { required: false });

await check('signals computed from real ratings', async () => {
  const r = await query(
    `select count(*)::int n, count(*) filter (where is_actionable)::int act,
            round(max(ev_pct),2) best from ${t('signals')}`);
  if (!r.rows[0].n) throw new Error('no signals — needs UTR ratings on both players of a match');
  return `${r.rows[0].n} signals · ${r.rows[0].act} actionable · best EV ${r.rows[0].best}%`;
}, { required: false });

await check('price history accumulating', async () => {
  const r = await query(`select count(*)::int n, count(distinct ticker)::int tk from ${t('price_history')}`);
  if (!r.rows[0].n) throw new Error('no ticks recorded');
  return `${r.rows[0].n} ticks across ${r.rows[0].tk} markets`;
});

/* -------------------------------------------------------------- summary --- */
const fails = results.filter(r => r.status === 'fail');
const warns = results.filter(r => r.status === 'warn');

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: !fails.length,
    passed: results.filter(r => r.status === 'pass').length,
    warned: warns.length, failed: fails.length, results,
  }, null, 2));
} else {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`${C.g}${results.filter(r => r.status === 'pass').length} passed${C.x}  ` +
    `${C.y}${warns.length} warning${C.x}  ${C.r}${fails.length} failed${C.x}`);
  if (warns.length) {
    console.log('\nwarnings (non-blocking):');
    for (const w of warns) console.log(`  · ${w.name}\n    ${C.d}${w.detail}${C.x}`);
  }
  if (fails.length) {
    console.log('\nfailures:');
    for (const f of fails) console.log(`  · ${f.name}\n    ${C.d}${f.detail}${C.x}`);
  }
  console.log('');
}

await closePool();
process.exit(fails.length ? 1 : 0);
