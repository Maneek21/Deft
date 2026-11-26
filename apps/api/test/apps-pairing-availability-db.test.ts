import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const child = resolve(here, 'fixtures', 'apps-pairing-routes-child.ts');

function runRoutes(pairing: 'true' | 'false') {
  const result = spawnSync(process.execPath, ['--import', 'tsx', child], {
    cwd: resolve(here, '..'),
    env: { ...process.env, DEFT_APPS_ENABLED: 'true', DEFT_APP_DEVELOPER_PAIRING_ENABLED: pairing },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim().split('\n').filter((row) => row.startsWith('{')).at(-1);
  assert.ok(line, result.stdout);
  return JSON.parse(line) as {
    create: { status: number; body: { code?: string } };
    revoke: { status: number; body: { code?: string } };
    list: { status: number; developer_pairing?: { available?: boolean } };
  };
}

test('with developer pairing off, the pairing routes answer 404 and GET /api/apps says so', () => {
  const off = runRoutes('false');
  assert.equal(off.create.status, 404);
  assert.equal(off.create.body.code, 'NOT_FOUND');
  assert.equal(off.revoke.status, 404);
  assert.equal(off.list.status, 200);
  assert.deepEqual(off.list.developer_pairing, { available: false });
});

test('with developer pairing on, the routes stay reachable and GET /api/apps says so', () => {
  const on = runRoutes('true');
  // The owner is not a member of this throwaway org, so the routes refuse
  // with the ordinary access answer instead of 404.
  assert.notEqual(on.create.status, 404);
  // An unknown pairing id may still be its own 404; it is not the switched-off answer.
  assert.notEqual(on.revoke.body.code, 'NOT_FOUND');
  assert.equal(on.list.status, 200);
  assert.deepEqual(on.list.developer_pairing, { available: true });
});
