import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api';
import { readPrivateResourceManagement } from './private-resource-management-client';

test('the three initial management readers stay within the peer budget and a failed read releases the next', async () => {
  const original = api.fetch;
  let active = 0, maximum = 0;
  const calls: string[] = [];
  api.fetch = async (path, options) => {
    calls.push(path); active++; maximum = Math.max(maximum, active);
    assert.ok(options?.signal);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (path.endsWith('operators')) throw new Error('read unavailable');
    return new Response('{}', { status: 200 });
  };
  try {
    const results = await Promise.allSettled(['bindings', 'operators', 'assignments'].map(key => readPrivateResourceManagement('/management/' + key)));
    assert.equal(maximum, 1);
    assert.deepEqual(calls, ['/management/bindings', '/management/operators', '/management/assignments']);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  } finally { api.fetch = original; }
});
