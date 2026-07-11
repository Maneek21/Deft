import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildActionGraph, validateActionGraph } from '../src/lib/agent-action-graph.js';

test('single and compound proposals receive stable typed graph identities', () => {
  const actions = [
    { action: 'wiki_write', params: { title: 'Trial notes', content: 'Water deeply.' } },
    { action: 'create_task', params: { title: 'Run trial', project_name: 'Pilot' } },
  ];
  const first = buildActionGraph(actions, 'message-1', 'Capture and act');
  const replay = buildActionGraph(actions, 'message-1', 'Capture and act');

  assert.equal(first.intent, 'compound_write');
  assert.deepEqual(first.actions.map((node) => node.id), ['step_1', 'step_2']);
  assert.deepEqual(first.actions.map((node) => node.idempotency_key), replay.actions.map((node) => node.idempotency_key));
});

test('action graph validation fails closed on unknown and cyclic dependencies', () => {
  assert.throws(() => validateActionGraph({
    intent: 'compound_write', summary: '', actions: [
      { id: 'a', tool: 'create_task', params: {}, depends_on: ['missing'], idempotency_key: 'a' },
    ],
  }), /unknown node/);

  assert.throws(() => validateActionGraph({
    intent: 'compound_write', summary: '', actions: [
      { id: 'a', tool: 'create_task', params: {}, depends_on: ['b'], idempotency_key: 'a' },
      { id: 'b', tool: 'wiki_write', params: {}, depends_on: ['a'], idempotency_key: 'b' },
    ],
  }), /dependency cycle/);
});

test('action graph rejects unsafe oversized proposals', () => {
  assert.throws(
    () => buildActionGraph(
      Array.from({ length: 13 }, (_, index) => ({ action: 'create_task', params: { title: `Task ${index}` } })),
      'message-oversized',
    ),
    /12-step safety limit/,
  );
});
