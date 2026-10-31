import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const id = '00000000-0000-4000-8000-000000000001';
const digest = 'sha256:' + 'a'.repeat(64);
const lakeviewId = '00000000-0000-4000-8000-000000000002';

const record = {
  id: lakeviewId,
  resource_id: 'module_record:' + lakeviewId,
  installation_id: id,
  module_id: 'com.deft.crm',
  collection_key: 'deals',
  manifest_digest: digest,
  data: { name: 'Lakeview', stage: 'Prospecting' },
  relations: [],
  members: [],
  revision: 2,
  created_at: '2026-10-19T00:00:00Z',
  updated_at: '2026-10-19T00:00:00Z',
  archived_at: null,
};

const twoCrmCalls = [
  {
    name: 'module_record_update',
    input: {
      idempotency_key: 'crm-multi-update-lakeview',
      record_id: lakeviewId,
      collection_key: 'deals',
      expected_revision: 2,
      expected_manifest_digest: digest,
      patch: { stage: 'Negotiation' },
    },
  },
  {
    name: 'module_record_create',
    input: {
      idempotency_key: 'crm-multi-create-note',
      module_id: 'com.deft.crm',
      collection_key: 'notes',
      expected_manifest_digest: digest,
      data: { body: 'Note about the double-booking.' },
    },
  },
];

mock.module(new URL('../src/lib/llm.js', import.meta.url).href, {
  namedExports: {
    llm: async () => ({
      text: '',
      toolCalls: twoCrmCalls,
      model: 'deterministic-test',
      usage: { input: 1, output: 1 },
    }),
  },
});

test('action compiler draft preserves two CRM actions with a concrete summary', async () => {
  const { compileDeftyActionDraft } = await import('../src/lib/agent-action-proposals.js');
  const draft = await compileDeftyActionDraft({
    orgId: '00000000-0000-4000-8000-000000000003',
    promptContent: 'Move Lakeview to Negotiation and add a note about the double-booking.',
    sourceMessageId: id,
    successfulReadActions: [
      { action: 'module_record_get', readOnly: true, success: true, result: { record } },
    ],
  });

  assert.equal(draft.actions.length, 2, JSON.stringify({ warnings: draft.warnings, actions: draft.actions.map((a) => a.action) }));
  assert.ok(draft.summary, 'compiled draft should have a concrete summary');
  assert.doesNotMatch(draft.summary, /related changes/i, 'summary should describe the actual CRM changes');
  assert.match(draft.summary, /Negotiation/i);
  assert.match(draft.summary, /stage/i);
  assert.match(draft.summary, /notes/i);
  assert.match(draft.summary, /double-booking/i);
});
