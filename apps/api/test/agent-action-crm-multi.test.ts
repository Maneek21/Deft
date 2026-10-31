import { test } from 'node:test';
import assert from 'node:assert/strict';

const id = '00000000-0000-4000-8000-000000000001';
const digest = 'sha256:' + 'a'.repeat(64);
const lakeviewId = '00000000-0000-4000-8000-000000000002';

const compileContext = {
  orgId: 'org-1',
  promptContent: 'Move Lakeview to Negotiation and add a note about the double-booking.',
  sourceMessageId: 'message-1',
  projectNameHint: null as string | null,
  priorTaskReferences: [] as string[],
  spaceName: 'sales',
  callerName: 'Alex',
};

const groundedReadFacts = {
  facts: [
    {
      tool: 'module_record_get' as const,
      read_index: 0,
      record: {
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
      },
    },
  ],
  limitations: [] as string[],
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

test('two CRM tool calls normalize into two proposed actions', async () => {
  const { normalizeCompiledToolCalls } = await import('../src/lib/agent-action-proposals.js');
  const normalized = normalizeCompiledToolCalls(twoCrmCalls, compileContext);
  assert.equal(normalized.actions.length, 2, JSON.stringify({ warnings: normalized.warnings, actions: normalized.actions.map((a) => a.action) }));
  assert.deepEqual(normalized.actions.map((a) => a.action), ['module_record_update', 'module_record_create']);
});

test('two grounded CRM proposals pass the registered action validator', async () => {
  const { normalizeCompiledToolCalls, validateRegisteredProposalAction } = await import('../src/lib/agent-action-proposals.js');
  const { validateCompilerGrounding } = await import('../src/lib/agent-compiler-read-facts.js');
  const normalized = normalizeCompiledToolCalls(twoCrmCalls, compileContext);
  const grounded = validateCompilerGrounding(normalized.actions, groundedReadFacts, compileContext.promptContent);
  assert.equal(grounded.actions.length, 2, JSON.stringify(grounded.warnings));
  for (const action of grounded.actions) {
    const validation = validateRegisteredProposalAction(action);
    assert.equal(validation.ok, true, JSON.stringify(validation));
  }
});

test('approval reply text builds a concrete summary for two CRM actions', async () => {
  const { normalizeCompiledToolCalls, formatDeftyApprovalReply } = await import('../src/lib/agent-action-proposals.js');
  const normalized = normalizeCompiledToolCalls(twoCrmCalls, compileContext);
  const reply = formatDeftyApprovalReply(normalized.actions);
  assert.ok(reply, 'formatDeftyApprovalReply should return a non-null summary for CRM actions');
  assert.doesNotMatch(reply, /related changes/i);
  assert.match(reply, /Negotiation/i);
  assert.match(reply, /stage/i);
  assert.match(reply, /notes/i);
  assert.match(reply, /double-booking/i);
});

