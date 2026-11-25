/**
 * Every PostgreSQL pool the API opens retires its connections
 * (lib/database-pool-recycling.ts): a backend keeps the memory it took to
 * plan a statement until its connection closes, so a pooled connection must
 * not live for ever. The settings come from the environment, strictly, and
 * the pool total does not change.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DATABASE_POOL_RECYCLING, parseDatabasePoolRecycling } from '../src/lib/database-pool-recycling.js';
import { APP_DATABASE_POOL_MAX_CONNECTIONS } from '../src/lib/app-database-pool-budget.js';

test('defaults: a connection lives at most five minutes and is closed after ten idle seconds', () => {
  assert.deepEqual(parseDatabasePoolRecycling({}), { maxLifetimeSeconds: 300, idleTimeoutMillis: 10_000 });
  assert.deepEqual(parseDatabasePoolRecycling({ DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS: '', DEFT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS: '' }),
    { maxLifetimeSeconds: 300, idleTimeoutMillis: 10_000 }, 'empty is unset');
  if (process.env.DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS === undefined && process.env.DEFT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS === undefined) {
    assert.deepEqual(DATABASE_POOL_RECYCLING, { maxLifetimeSeconds: 300, idleTimeoutMillis: 10_000 });
  }
});

test('an operator sets either one in whole seconds; anything else out of range stops startup, naming the setting', () => {
  assert.deepEqual(parseDatabasePoolRecycling({ DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS: '900', DEFT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS: ' 30 ' }),
    { maxLifetimeSeconds: 900, idleTimeoutMillis: 30_000 });
  for (const [name, value] of [
    ['DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS', '0'], ['DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS', '29'],
    ['DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS', '86401'], ['DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS', '5m'],
    ['DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS', '300.5'], ['DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS', '-300'],
    ['DEFT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS', '0'], ['DEFT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS', '3601'],
    ['DEFT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS', 'ten'],
  ] as const) {
    assert.throws(() => parseDatabasePoolRecycling({ [name]: value }),
      { message: new RegExp(`^${name} must be a whole number of seconds from [0-9]+ to [0-9]+$`) },
      `${name}=${value} is refused, naming the setting`);
  }
});

type PoolFile = { file: string; constructions: number; recycled: number; overrides: string[] };

/** Every `new Pool(` / `new pg.Pool(` the running API has (scripts and tests open their own). */
function poolConstructions(): PoolFile[] {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const found: PoolFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (relative(root, path) !== 'scripts') walk(path);
      } else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
        const text = readFileSync(path, 'utf8');
        const constructions = text.match(/new\s+(?:pg\.)?Pool\s*\(/g)?.length ?? 0;
        if (constructions > 0) {
          found.push({
            file: relative(root, path).replace(/\\/g, '/'),
            constructions,
            recycled: text.match(/\.\.\.DATABASE_POOL_RECYCLING\b/g)?.length ?? 0,
            // A key of its own would replace the spread value wherever it stands after it.
            overrides: [...text.matchAll(/\b(maxLifetimeSeconds|idleTimeoutMillis|maxUses)\s*:\s*[^,}\n]+/g)].map((match) => match[0].trim()),
          });
        }
      }
    }
  };
  walk(root);
  return found;
}

test('every pool the API opens takes the recycling options', () => {
  const pools = poolConstructions();
  assert.ok(pools.length >= 4, `the scan found the pools (${pools.map((pool) => pool.file).join(', ')})`);
  for (const pool of pools) {
    assert.ok(pool.recycled >= pool.constructions,
      `${pool.file}: ${pool.constructions} pool(s), ${pool.recycled} spread(s) of DATABASE_POOL_RECYCLING`);
    // The one exception: a pool that keeps a connection on purpose (`min`) keeps it past the lifetime,
    // since node-postgres would close it for age and not reopen it.
    const allowed = pool.file === 'lib/app-run-bounded-db.ts' ? ['maxLifetimeSeconds: 0'] : [];
    assert.deepEqual(pool.overrides.filter((key) => !allowed.includes(key)), [],
      `${pool.file}: sets its own lifetime or idle timeout`);
  }
});

test('recycling does not change the pool total', () => {
  assert.equal(APP_DATABASE_POOL_MAX_CONNECTIONS, 18);
});
