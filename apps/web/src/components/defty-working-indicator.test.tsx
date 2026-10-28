import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeftyWorkingIndicator, deftyWorkingReducer, visibleDeftyWork, type DeftyWorkingEvent } from './defty-working-indicator';

const started: DeftyWorkingEvent = {
  space_id: 'space-a', thread_id: null, agent_user_id: 'defty', agent_name: 'Defty',
  state: 'started', label: 'Reading the conversation…',
};
const begin = (event = started, now = 1_000) => deftyWorkingReducer([], { type: 'working', event, now });

test('start records scope and expires after 120 seconds; another start refreshes it', () => {
  const state = begin();
  assert.equal(state.length, 1);
  assert.equal(state[0]?.expiresAt, 121_000);
  const refreshed = deftyWorkingReducer(state, { type: 'working', event: started, now: 2_000 });
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0]?.expiresAt, 122_000);
});

test('finish clears only the matching space, thread and agent', () => {
  const state = deftyWorkingReducer(begin(), { type: 'working', event: { ...started, thread_id: 'root' }, now: 1_000 });
  const remaining = deftyWorkingReducer(state, { type: 'working', event: { ...started, state: 'finished' }, now: 2_000 });
  assert.deepEqual(remaining.map(item => item.thread_id), ['root']);
  assert.deepEqual(deftyWorkingReducer(remaining, { type: 'working', event: { ...started, thread_id: 'root', space_id: 'other', state: 'finished' }, now: 2_000 }), remaining);
  assert.deepEqual(deftyWorkingReducer(remaining, { type: 'working', event: { ...started, thread_id: 'root', agent_user_id: 'other', state: 'finished' }, now: 2_000 }), remaining);
});

test('a Defty message clears its space/thread while human and unrelated messages do not', () => {
  const state = begin({ ...started, thread_id: 'root' });
  for (const message of [
    { space_id: 'space-a', parent_id: 'root', user_id: 'human' },
    { space_id: 'space-b', parent_id: 'root', user_id: 'defty' },
    { space_id: 'space-a', parent_id: 'other', user_id: 'defty' },
    { space_id: 'space-a', parent_id: null, user_id: 'defty' },
  ]) assert.deepEqual(deftyWorkingReducer(state, { type: 'message', message }), state);
  assert.deepEqual(deftyWorkingReducer(state, { type: 'message', message: { space_id: 'space-a', parent_id: 'root', user_id: 'defty' } }), []);
  assert.deepEqual(deftyWorkingReducer(begin(), { type: 'message', message: { space_id: 'space-a', user_id: 'defty' } }), []);
});

test('timeout clears expired work at the boundary without clearing newer work', () => {
  const state = deftyWorkingReducer(begin(), { type: 'working', event: { ...started, thread_id: 'root' }, now: 2_000 });
  assert.equal(deftyWorkingReducer(state, { type: 'expire', now: 120_999 }).length, 2);
  assert.deepEqual(deftyWorkingReducer(state, { type: 'expire', now: 121_000 }).map(item => item.thread_id), ['root']);
  assert.deepEqual(deftyWorkingReducer(state, { type: 'expire', now: 122_000 }), []);
});

test('a dropped socket clears every in-flight row', () => {
  const state = deftyWorkingReducer(begin(), { type: 'working', event: { ...started, thread_id: 'root' }, now: 2_000 });
  assert.deepEqual(deftyWorkingReducer(state, { type: 'clear' }), []);
  const empty: readonly [] = [];
  assert.equal(deftyWorkingReducer(empty, { type: 'clear' }), empty, 'clearing an empty store must not churn subscribers');
});

test('channel includes top-level work and inline thread roots; panel matches exactly', () => {
  let state = begin();
  for (const thread_id of ['root', 'hidden']) state = deftyWorkingReducer(state, { type: 'working', event: { ...started, thread_id }, now: 1_000 });
  state = deftyWorkingReducer(state, { type: 'working', event: { ...started, space_id: 'space-b' }, now: 1_000 });
  assert.deepEqual(visibleDeftyWork(state, 'space-a', null, ['root']).map(item => item.thread_id), [null, 'root']);
  assert.deepEqual(visibleDeftyWork(state, 'space-a', 'root').map(item => item.thread_id), ['root']);
  assert.deepEqual(visibleDeftyWork(state, 'space-a', 'missing'), []);
});

test('indicator uses typing styling with accessible status and animated dot', () => {
  const html = renderToStaticMarkup(<DeftyWorkingIndicator />);
  assert.match(html.replace(/<[^>]+>/g, ''), /Defty is reading the conversation…/);
  assert.match(html, /role="status"/);
  assert.match(html, /animate-pulse/);
  assert.match(html, /text-\[12px\]/);
});
