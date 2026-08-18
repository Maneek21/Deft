import test from 'node:test';
import assert from 'node:assert/strict';
import { getAgentActionPresentation, getSafeGenericParams } from './agent-action-presentation';

test('generic approval details hide orchestration internals', () => {
  const entries = getSafeGenericParams({
    title: 'Publish update',
    content: 'Ready for review',
    idempotency_key: 'secret-dedupe-key',
    expected_manifest_digest: 'sha256:digest',
    expected_revision: 4,
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

test('module record approvals receive a specific, legible presentation', () => {
  const presentation = getAgentActionPresentation({
    action: 'module_record_update',
    params: {
      module_name: 'Customer tracker',
      collection_name: 'Contacts',
      patch: { name: 'Acme Corp' },
      expected_revision: 3,
      expected_manifest_digest: 'digest-1',
    },
  });

  assert.equal(presentation.kind, 'module');
  assert.equal(presentation.icon, 'module');
  assert.equal(presentation.title, 'Acme Corp');
  assert.equal(presentation.approveLabel, 'Approve update');
  assert.deepEqual(presentation.chips, [
    { label: 'Customer tracker', icon: 'project' },
    { label: 'Contacts', icon: 'book' },
  ]);
});
