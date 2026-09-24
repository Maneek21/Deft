import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Client } = require('pg');
const [mode, path] = process.argv.slice(2);
if (!['snapshot', 'compare', 'schema'].includes(mode) || !path) throw new Error('Usage: verify-upgrade.mjs snapshot|compare|schema evidence.json');
const url = new URL(process.env.DEFT_TEST_DATABASE_URL ?? 'invalid:');
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
  url.port !== '55435' || !/^\/gate_g_[a-z0-9_]+$/.test(url.pathname) || url.search || url.hash) {
  throw new Error('Only the assigned disposable Gate G database cluster is supported');
}
const client = new Client({ connectionString: url.href });
const tables = ['app_installations', 'app_versions', 'app_grant_snapshots', 'app_runs',
  'app_run_attempts', 'app_run_receipts', 'module_records'];
const quote = (value) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Unexpected database identifier');
  return `"${value}"`;
};
function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
await client.connect();
try {
  if (mode === 'schema') {
    const selected = ['app_installations', 'app_versions', 'app_grant_snapshots', 'app_runs', 'app_run_attempts', 'capability_provider_snapshots'];
    const discovered = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'app_runtime_%' OR tablename LIKE 'app_public_%' OR tablename='app_canonical_claims') ORDER BY tablename");
    selected.push(...discovered.rows.map((row) => row.tablename));
    const columns = await client.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name,column_name", [selected]);
    const constraints = await client.query("SELECT c.relname AS table_name,k.conname AS name,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1) ORDER BY c.relname,k.conname", [selected]);
    const indexes = await client.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1) ORDER BY tablename,indexname", [selected]);
    const triggers = await client.query("SELECT c.relname AS table_name,t.tgname AS name,pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(t.tgfoid) AS function FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname", [selected]);
    const functions = await client.query("SELECT proname AS name,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname=ANY($1) ORDER BY proname", [['assert_app_installation_grant_coherence', 'enforce_app_grant_snapshot_lineage']]);
    writeFileSync(path, JSON.stringify({ columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, triggers: triggers.rows, functions: functions.rows }, null, 2));
    console.log(`Captured ${selected.length} table definitions`);
  } else {
    const previous = mode === 'compare' ? JSON.parse(readFileSync(path, 'utf8')) : null;
    const result = {};
    for (const table of tables) {
      const columns = previous?.[table]?.columns ?? (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name", [table])).rows.map((row) => row.column_name);
      if (!columns.length) throw new Error(`Missing table ${table}`);
      const rows = (await client.query(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY id`)).rows;
      result[table] = { columns, count: rows.length, sha256: createHash('sha256').update(JSON.stringify(stable(rows))).digest('hex') };
    }
    if (previous) {
      assert.deepEqual(result, previous, 'Upgrade changed retained data');
      console.log(JSON.stringify({ retained_data_unchanged: true, tables: Object.fromEntries(Object.entries(result).map(([name, value]) => [name, value.count])) }, null, 2));
    } else {
      writeFileSync(path, JSON.stringify(result, null, 2));
      console.log('Retained-data snapshot written; no record contents exported');
    }
  }
} finally { await client.end(); }
