import assert from 'node:assert/strict';
import test, { after } from 'node:test';
// Load the same authority root as production before the service import cycle.
import '../src/lib/app-runtime-authority.js';
import { Hono } from 'hono';
import { DrizzleQueryError } from 'drizzle-orm';
import { z } from 'zod';
import { db, closeDb } from '../src/lib/db.js';
import { appActionService } from '../src/lib/app-action-service.js';
import { AppError } from '../src/lib/app-errors.js';
import { AppRunError } from '../src/lib/app-run-errors.js';
import { ResourceSyncWebAuthenticationError } from '../src/lib/app-resource-sync-web-authority.js';
import { appRunRoutes } from '../src/routes/app-runs.js';

after(closeDb);
const RUN = 'bdbb7007-61c9-4b17-831b-ad2b2b6e054b';
const expected = {
  error: 'The original App Run status is temporarily unavailable. Check this submission again; do not submit the action again.',
  code: 'APP_RUN_STATUS_UNAVAILABLE',
};
function app() {
  const value = new Hono();
  value.use('*', async (c, next) => {
    c.set('user', { id: 'synthetic-user', org_id: 'synthetic-org', role: 'member' });
    await next();
  });
  value.route('/api/app-runs', appRunRoutes);
  return value;
}
function sqlError(code: string) {
  return Object.assign(new Error('synthetic database failure with private query'), { code });
}
test('actual original-status route returns recoverable503 for exact pg failure and wrapped timeout', async t => {
  const errors = [new Error('Connection terminated'), new Error('Connection terminated unexpectedly'),
    new Error('Query read timeout'), sqlError('57P01'), sqlError('57014'),
    new DrizzleQueryError('SELECT synthetic_private_query', [], new Error('Connection terminated'))];
  for (const error of errors) {
    await t.test(error instanceof DrizzleQueryError ? 'Drizzle cause' : error.message + ('code' in error ? ` ${error.code}` : ''), async sub => {
      let reads = 0, effects = 0;
      sub.mock.method(console, 'error', () => undefined);
      sub.mock.method(db, 'execute', async () => { reads++; throw error; });
      sub.mock.method(appActionService, 'invoke', async () => { effects++; throw Error('unexpected mutation'); });
      const response = await app().request(`/api/app-runs/${RUN}/result`);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '2');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), expected);
      assert.equal(reads, 1, 'one original status read, without automatic retry');
      assert.equal(effects, 0);
    });
  }
});
test('result-service failure also maps503; next explicit status read retains original unknown outcome', async t => {
  t.mock.method(db, 'execute', async () => ({ rows: [] }));
  let reads = 0, effects = 0;
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(appActionService, 'invoke', async () => { effects++; throw Error('unexpected mutation'); });
  t.mock.method(appActionService, 'result', async (_caller, runId) => {
    assert.equal(runId, RUN); reads++;
    if (reads === 1) throw new DrizzleQueryError('SELECT synthetic_private_result', [], new Error('Connection terminated'));
    return { run: { id: RUN, state: 'unknown_outcome' }, value: { status: 'unknown' } };
  });
  const route = app();
  const unavailable = await route.request(`/api/app-runs/${RUN}/result`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), expected);
  assert.equal(reads, 1);
  const checked = await route.request(`/api/app-runs/${RUN}/result`);
  assert.equal(checked.status, 200);
  assert.deepEqual(await checked.json(), { run: { id: RUN, state: 'unknown_outcome' }, value: { status: 'unknown' } });
  assert.equal(checked.headers.get('retry-after'), null);
  assert.equal(reads, 2);
  assert.equal(effects, 0);
});
test('authorization, validation, stale and expired status classifications are preserved', async t => {
  const failures = [
    [new ResourceSyncWebAuthenticationError('Web authentication required'), 401, 'APP_ACCESS_DENIED'],
    [new AppError('Denied', 'APP_ACCESS_DENIED', 403), 403, 'APP_ACCESS_DENIED'],
    [new AppRunError('APP_RUN_ACCESS_DENIED'), 403, 'APP_RUN_ACCESS_DENIED'],
    [new AppRunError('APP_RUN_AUTHORIZATION_STALE'), 409, 'APP_RUN_AUTHORIZATION_STALE'],
    [new AppRunError('APP_RUN_RESULT_EXPIRED'), 410, 'APP_RUN_RESULT_EXPIRED'],
    [new AppRunError('APP_RUN_UNKNOWN_OUTCOME'), 409, 'APP_RUN_UNKNOWN_OUTCOME'],
    [new z.ZodError([{ code: 'custom', path: ['run_id'], message: 'Invalid synthetic run' }]), 400, 'VALIDATION_ERROR'],
  ] as const;
  for (const [error, status, code] of failures) {
    await t.test(code + String(status), async sub => {
      Object.assign(error, { cause: new Error('Connection terminated') });
      sub.mock.method(db, 'execute', async () => { throw error; });
      const response = await app().request(`/api/app-runs/${RUN}/result`);
      assert.equal(response.status, status);
      assert.equal((await response.json() as {code:string}).code, code);
      assert.equal(response.headers.get('retry-after'), null);
    });
  }
});
test('nonmatching programmer/database errors and cyclic or excessive cause chains remain500', async t => {
  const cycle = new Error('cyclic'); Object.assign(cycle, { cause: cycle });
  let deep: Error = new Error('Connection terminated');
  for (let i = 0; i < 9; i++) deep = new Error('wrapper', { cause: deep });
  const errors = [new Error('Connection terminated in my parser'), new TypeError('Query read timeout typo'),
    new TypeError('Connection terminated'), new SyntaxError('Query read timeout'),
    sqlError('23505'), sqlError('42P01'), new Error('App Run transaction deadline'), cycle, deep];
  for (const error of errors) {
    await t.test(error.message, async sub => {
      sub.mock.method(console, 'error', () => undefined);
      sub.mock.method(db, 'execute', async () => { throw error; });
      const response = await app().request(`/api/app-runs/${RUN}/result`);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'App Run request failed', code: 'INTERNAL_ERROR' });
      assert.equal(response.headers.get('retry-after'), null);
    });
  }
});
test('other Run read routes retain their existing error contract', async t => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(appActionService, 'inspectRun', async () => { throw new Error('Connection terminated'); });
  const response = await app().request(`/api/app-runs/${RUN}`);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('retry-after'), null);
});
