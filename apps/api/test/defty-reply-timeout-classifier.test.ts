import assert from 'node:assert/strict';
import test from 'node:test';
import { isDatabaseError, isDatabaseWaitTimeout } from '../src/lib/defty-reply-guard.js';

test('A09 round 3: lock and statement timeouts are recognised through a wrapped cause chain', () => {
  const lock = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  const statement = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  assert.equal(isDatabaseWaitTimeout(lock), true);
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

test('A09 round 4: any SQLSTATE in the cause chain is a database error; validation errors are not', () => {
  const denied = Object.assign(new Error('permission denied'), { code: '42501' });
  assert.equal(isDatabaseError(new Error('Failed query', { cause: denied })), true);
  assert.equal(isDatabaseError(Object.assign(new Error('aborted'), { code: '25P02' })), true);
  assert.equal(isDatabaseWaitTimeout(new Error('Failed query', { cause: denied })), false);
  assert.equal(isDatabaseWaitTimeout(Object.assign(new Error('aborted'), { code: '25P02' })), false);
  assert.equal(isDatabaseError(Object.assign(new Error('Module not found'), { code: 'MODULE_NOT_FOUND' })), false);
  assert.equal(isDatabaseError(new Error('record is not visible')), false);
  assert.equal(isDatabaseError(Object.assign(new Error('stale'), { code: 'STALE' })), false);
  assert.equal(isDatabaseError(Object.assign(new Error('eperm'), { code: 'EPERM' })), false);
  assert.equal(isDatabaseError(Object.assign(new Error('econn'), { code: 'ECONNRESET' })), false);
});
