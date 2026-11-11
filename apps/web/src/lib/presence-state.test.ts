import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPresenceSnapshot, applyPresenceUpdate, type PresenceMap } from './presence-state';

test('presence snapshot: a user who went offline while this client was disconnected is no longer shown online', () => {
  const before: PresenceMap = new Map([['u-ana', 'online'], ['u-ben', 'idle']]);
  // Reconnect: the server's snapshot lists only who is connected now.
  const after = applyPresenceSnapshot(before, [{ user_id: 'u-ben', status: 'online' }], 'u-me');
  assert.deepEqual([...after.entries()], [['u-ben', 'online']]);
});

test('presence snapshot: the current user is kept, because the server leaves them out of the list', () => {
  const before: PresenceMap = new Map([['u-me', 'online'], ['u-ana', 'online']]);
  const after = applyPresenceSnapshot(before, [], 'u-me');
  assert.deepEqual([...after.entries()], [['u-me', 'online']]);
});

test('presence snapshot: an empty snapshot clears everyone else', () => {
  const after = applyPresenceSnapshot(new Map([['u-ana', 'online']]), [], null);
  assert.equal(after.size, 0);
});

test('presence update: offline removes, online and idle set', () => {
  let state: PresenceMap = new Map();
  state = applyPresenceUpdate(state, { user_id: 'u-ana', status: 'online' });
  state = applyPresenceUpdate(state, { user_id: 'u-ana', status: 'idle' });
  assert.equal(state.get('u-ana'), 'idle');
  state = applyPresenceUpdate(state, { user_id: 'u-ana', status: 'offline' });
  assert.equal(state.has('u-ana'), false);
});
