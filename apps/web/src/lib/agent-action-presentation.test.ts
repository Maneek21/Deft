import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAgentActionPresentation,
  getAppRunApprovalCompletionLabel,
  getAppRunInspectorLabel,
  getAppRunReference,
  getSafeGenericParams,
  normalizeTaskLinkReview,
} from './agent-action-presentation';

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

test('module task-link approvals name both existing resources without exposing raw orchestration params', () => {
  const presentation = getAgentActionPresentation({
    action: 'module_record_task_link',
    params: { resource_id: 'module_record:b57a1930-ab37-4194-9e8c-2c8174ec104f', task_identifier: 'CRM-5' },
  });

  assert.equal(presentation.kind, 'module');
  assert.equal(presentation.title, 'Link Module record b57a1930 to CRM-5');
  assert.equal(presentation.approveLabel, 'Approve link');
  assert.deepEqual(presentation.chips, [
    { label: 'Module record b57a1930', icon: 'book' },
    { label: 'CRM-5', icon: 'task' },
  ]);
});

test('task-link review accepts only complete, canonical local targets', () => {
  assert.deepEqual(normalizeTaskLinkReview({
    record: { label: 'Ada Lovelace', href: '/modules/people-module/contacts/record-1' },
    task: { identifier: 'CRM-5', title: 'Send follow-up', project_name: 'CRM', href: '/tasks?task=task-5' },
  }), {
    record: { label: 'Ada Lovelace', href: '/modules/people-module/contacts/record-1' },
    task: { identifier: 'CRM-5', title: 'Send follow-up', project_name: 'CRM', href: '/tasks?task=task-5' },
  });
  assert.equal(normalizeTaskLinkReview({
    record: { label: 'HIDDEN RECORD', href: 'https://attacker.invalid/record' },
    task: { identifier: 'CRM-5', title: 'HIDDEN TASK', project_name: 'CRM', href: '/tasks?task=task-5' },
  }), null);
  assert.equal(normalizeTaskLinkReview({
    record: { label: 'Ada Lovelace', href: '/modules/people-module/contacts/record-1' },
    task: { identifier: 'CRM-5', title: '', project_name: 'CRM', href: '/tasks?task=task-5' },
  }), null);
});

test('personal MCP retries identify the human request and hide host provenance', () => {
  const params = {
    module_name: 'Equipment register', collection_name: 'Assets',
    rows: [{ data: { serial: 'A' } }, { data: { serial: 'B' } }],
    __deft_human_mcp_principal: { kind: 'human_mcp_v1', client_id: 'private-client' },
    __deft_bulk_retry_of_action_id: 'failed-action',
  };
  const presentation = getAgentActionPresentation({
    action: 'module_record_bulk_create', proposer: 'user', source: 'mcp', params,
  });
  assert.match(presentation.headline, /A workspace member/);
  assert.doesNotMatch(presentation.headline, /Defty/);
  assert.equal(presentation.approveLabel, 'Approve retry');
  assert.match(presentation.summary, /already created.*reused/i);
  assert.doesNotMatch(JSON.stringify(getSafeGenericParams(params)), /private-client|failed-action|__deft/);
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

test('sandbox email approval keeps human resource identity and sandbox context prominent', () => {
  const presentation = getAgentActionPresentation({
    action: 'app_run_invoke',
    source: 'app_run',
    params: {
      capability_label: 'send_email',
      provider_label: 'opaque-provider-id',
      safe_preview: {
        title: 'Review outreach email',
        resource_refs: [
          { resource_id: 'outreach-id', label: 'Human QA — Pilot recap' },
          { resource_id: 'contact-id', label: 'Human QA — Casey Vale' },
        ],
      },
    },
  });

  assert.equal(presentation.badge, 'Sandbox');
  assert.equal(presentation.sourceLabel, 'Provider: Deft email sandbox');
  assert.match(presentation.summary ?? '', /no external message will be delivered/i);
  assert.deepEqual(presentation.chips.map((chip) => chip.label), [
    'Human QA — Pilot recap', 'Human QA — Casey Vale', 'send_email',
  ]);
});

test('App Run cards use the approval response run reference and retain its safe outcome state', () => {
  assert.deepEqual(
    getAppRunReference(
      { run_id: 'stored-run' },
      { run_id: 'stored-run', run_state: 'failed', execution_released: true },
    ),
    { runId: 'stored-run', runState: 'failed' },
  );
  assert.deepEqual(
    getAppRunReference({ run_id: 'stored-run' }, { run_id: 'other-run', run_state: 'succeeded' }),
    { runId: 'stored-run', runState: null },
  );
  assert.equal(getAppRunApprovalCompletionLabel('failed'), 'App action failed after approval');
  assert.equal(getAppRunApprovalCompletionLabel('pending_approval'), 'App action approved — delivery pending');
  assert.equal(getAppRunApprovalCompletionLabel(null), 'App action approved — outcome unavailable');
  assert.equal(getAppRunApprovalCompletionLabel('succeeded'), 'App action completed');
  assert.equal(getAppRunApprovalCompletionLabel('unknown_outcome'), 'App action outcome is unknown');
  assert.equal(getAppRunInspectorLabel('pending', null), 'Inspect pending App Run');
  assert.equal(getAppRunInspectorLabel('rejected', null), 'Inspect rejected App Run');
  assert.equal(getAppRunInspectorLabel('approved', 'succeeded'), 'Inspect outcome and receipts');
  assert.equal(getAppRunInspectorLabel('failed', 'failed'), 'Inspect outcome and receipts');
});
