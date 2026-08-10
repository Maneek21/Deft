/**
 * Run: pnpm --filter @deft/web exec tsx --test src/lib/huddle-state.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHuddleUpdate,
  HUDDLE_RESPONSE_TIMEOUT_MS,
  huddleResponseTimeoutMessage,
  huddlesFromSnapshot,
  removeEndedHuddle,
  shouldCleanupEndedHuddle,
} from './huddle-state';

const alex = { user_id: 'user-alex', user_name: 'Alex', muted: false };
const bea = { user_id: 'user-bea', user_name: 'Bea', muted: true };

test('snapshot replaces stale room indicators with the authorized server view', () => {
  const result = huddlesFromSnapshot([{
    huddle_id: 'huddle-current',
    space_id: 'space-current',
    created_by: alex.user_id,
    participants: [alex],
  }]);

  assert.deepEqual([...result.entries()], [[
    'space-current',
    { huddle_id: 'huddle-current', participants: [alex] },
  ]]);
});

test('space-aware updates discover late rooms and preserve rejoin state after leaving', () => {
  const result = applyHuddleUpdate(new Map(), {
    huddle_id: 'huddle-current',
    space_id: 'space-current',
    participants: [bea],
  });

  assert.deepEqual(result.get('space-current'), {
    huddle_id: 'huddle-current',
    participants: [bea],
  });
});

test('empty updates remove ended room indicators', () => {
  const current = huddlesFromSnapshot([{
    huddle_id: 'huddle-current',
    space_id: 'space-current',
    participants: [alex],
  }]);

  const result = applyHuddleUpdate(current, {
    huddle_id: 'huddle-current',
    space_id: 'space-current',
    participants: [],
  });

  assert.equal(result.has('space-current'), false);
});

test('an old ended event cannot remove a newer room in the same space', () => {
  const current = huddlesFromSnapshot([{
    huddle_id: 'huddle-new',
    space_id: 'space-current',
    participants: [alex],
  }]);

  const result = removeEndedHuddle(current, {
    huddle_id: 'huddle-old',
    space_id: 'space-current',
  });

  assert.deepEqual(result, current);
});

test('only the matching active huddle owns media cleanup', () => {
  assert.equal(shouldCleanupEndedHuddle('huddle-active', 'huddle-other'), false);
  assert.equal(shouldCleanupEndedHuddle('huddle-active', 'huddle-active'), true);
  assert.equal(shouldCleanupEndedHuddle(null, 'huddle-active'), false);
});

test('create and join waits have a bounded, actionable timeout', () => {
  assert.equal(HUDDLE_RESPONSE_TIMEOUT_MS, 15_000);
  assert.match(huddleResponseTimeoutMessage('huddle:create'), /too long to start.*microphone was released/i);
  assert.match(huddleResponseTimeoutMessage('huddle:join'), /too long to join.*microphone was released/i);
});
