#!/usr/bin/env node
/**
 * Database helpers that wrap the Supabase CLI.
 *   node cli/db.js push      # apply pending migrations to the remote project
 *   node cli/db.js status    # tables, row counts, migration history
 *   node cli/db.js reset     # DROP every kalshi_* table (asks for --yes)
 */
import { spawnSync } from 'node:child_process';
import { config, t } from '../src/config.js';
import { closePool, query } from '../src/db.js';

const cmd = process.argv[2] ?? 'status';

const TABLES = ['players', 'events', 'markets', 'price_history', 'signals',
  'alerts', 'trades', 'settings', 'sync_runs', 'portfolio_snapshots'];

function supabase(args) {
  const r = spawnSync('npx', ['supabase', ...args, '--db-url', config.db.migrationUrl || config.db.url], {
    stdio: 'inherit', shell: true,
  });
  return r.status ?? 1;
}

if (cmd === 'push') {
  console.log('applying migrations to the remote project…');
  process.exit(supabase(['db', 'push']));
}

if (cmd === 'status') {
  const rows = await query(
    `select c.relname, c.relrowsecurity rls,
            coalesce(s.n_live_tup, 0) est
     from pg_class c
     join pg_namespace ns on ns.oid = c.relnamespace
     left join pg_stat_user_tables s on s.relid = c.oid
     where ns.nspname='public' and c.relkind='r' and c.relname like $1
     order by c.relname`, [`${config.db.prefix}%`]);

  console.log(`\ntables matching ${config.db.prefix}* :`);
  for (const r of rows.rows) {
    const exact = await query(`select count(*)::int n from public.${r.relname}`);
    console.log(`  ${r.relname.padEnd(30)} ${String(exact.rows[0].n).padStart(7)} rows  rls=${r.rls ? 'on' : 'OFF'}`);
  }

  const mig = await query(
    `select version, name from supabase_migrations.schema_migrations order by version`);
  console.log('\nmigrations applied:');
  for (const m of mig.rows) console.log(`  ${m.version}  ${m.name}`);

  const other = await query(
    `select count(*)::int n from information_schema.tables
     where table_schema='public' and table_name not like $1`, [`${config.db.prefix}%`]);
  console.log(`\nother public tables (untouched): ${other.rows[0].n}`);
  await closePool();
  process.exit(0);
}

if (cmd === 'reset') {
  if (!process.argv.includes('--yes')) {
    console.log(`This DROPs these tables and all their data:\n` +
      TABLES.map(n => '  ' + config.db.prefix + n).join('\n') +
      `\n\nNothing else in the database is touched. Re-run with --yes to proceed.`);
    await closePool();
    process.exit(1);
  }
  for (const n of [...TABLES].reverse()) {
    await query(`drop table if exists ${t(n)} cascade`);
    console.log('dropped', config.db.prefix + n);
  }
  await query(`drop view if exists public.${config.db.prefix}rated_players`);
  await query(`delete from supabase_migrations.schema_migrations where name like '%kalshi%'`);
  console.log('\nmigration history cleared — run `node cli/db.js push` to rebuild.');
  await closePool();
  process.exit(0);
}

console.log('usage: node cli/db.js [push|status|reset]');
await closePool();
process.exit(1);
