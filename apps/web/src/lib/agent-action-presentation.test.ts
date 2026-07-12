import test from 'node:test';
import assert from 'node:assert/strict';
import { getSafeGenericParams } from './agent-action-presentation';

test('generic approval details hide orchestration internals', () => {
  const entries = getSafeGenericParams({
    title: 'Publish update',
    content: 'Ready for review',
    idempotency_key: 'secret-dedupe-key',
    proposal_node_id: 'node-1',
    proposal_depends_on: ['node-0'],
    source_message_id: 'message-1',
    org_id: 'org-1',
    task_id: 'task-1',
  });

  assert.deepEqual(entries, [
    ['title', 'Publish update'],
    ['content', 'Ready for review'],
  ]);
});
