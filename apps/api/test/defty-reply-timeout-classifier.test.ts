import assert from 'node:assert/strict';
import test from 'node:test';
import { isDatabaseWaitTimeout } from '../src/lib/defty-reply-guard.js';

test('A09 round 3: lock and statement timeouts are recognised through a wrapped cause chain', () => {
  const lock = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  const statement = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  assert.equal(isDatabaseWaitTimeout(lock), true);
  assert.equal(isDatabaseWaitTimeout(new Error('Failed query', { cause: Object.assign(new Error('current transaction is aborted'), { code: '25P02' }) })), true);
  assert.equal(isDatabaseWaitTimeout(statement), true);
  assert.equal(isDatabaseWaitTimeout(new Error('Failed query', { cause: lock })), true);
  assert.equal(isDatabaseWaitTimeout(new Error('outer', { cause: new Error('Failed query', { cause: statement }) })), true);
});

test('A09 round 3: other failures are not treated as wait timeouts', () => {
  assert.equal(isDatabaseWaitTimeout(Object.assign(new Error('duplicate key'), { code: '23505' })), false);
  assert.equal(isDatabaseWaitTimeout(new Error('plain')), false);
  assert.equal(isDatabaseWaitTimeout(null), false);
  assert.equal(isDatabaseWaitTimeout('57014'), false);
});
