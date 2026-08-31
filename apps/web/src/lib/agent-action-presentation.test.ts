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

test('module CSV imports show one truthful batch approval', () => {
  const presentation = getAgentActionPresentation({
    action: 'module_record_bulk_create',
    params: {
      module_name: 'Contacts',
      collection_name: 'Contacts',
      source_file_name: 'contacts.csv',
      rows: [{ data: { name: 'Ada' } }, { data: { name: 'Grace' } }],
    },
  });

  assert.equal(presentation.kind, 'module');
  assert.equal(presentation.eyebrow, 'Module import draft');
  assert.equal(presentation.title, 'Import 2 Contacts records');
  assert.equal(presentation.approveLabel, 'Approve import');
  assert.equal(presentation.doneLabel, 'Records imported');
});

test('App Run approvals present only the safe preview without raw orchestration identities', () => {
  const action = {
    action: 'app_run_invoke',
    source: 'app_run',
    params: {
      run_id: 'run-secret-id',
      capability_label: 'Send email',
      provider_label: 'Workspace mail connector',
      resource_ids: ['campaign-secret-id'],
      safe_preview: {
        title: 'Send September campaign',
        summary: 'Send to one selected contact',
        resource_refs: [{ resource_kind: 'campaign', resource_id: 'campaign-secret-id', label: 'September campaign' }],
      },
    },
  };
  const presentation = getAgentActionPresentation(action);
  const genericDetails = getSafeGenericParams(action.params);

  assert.equal(presentation.kind, 'app_run');
  assert.equal(presentation.title, 'Send September campaign');
  assert.equal(presentation.summary, 'Send to one selected contact');
  assert.equal(presentation.approveLabel, 'Approve App action');
  assert.deepEqual(presentation.chips, [
    { label: 'September campaign', icon: 'project' },
    { label: 'Send email', icon: 'shield' },
  ]);
  assert.equal(JSON.stringify(genericDetails).includes('run-secret-id'), false);
  assert.equal(JSON.stringify(genericDetails).includes('campaign-secret-id'), true, 'safe_preview remains the only resource presentation');
});
