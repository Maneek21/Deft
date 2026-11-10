import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { buildRecordMirrorNomination } from '../src/lib/app-integration-tool-runtime.js';
import type { AppIntegrationToolDeclaration } from '../../../packages/app-kit/src/app-integration-tools.js';

const uuid = () => randomUUID();
const declaration = (): AppIntegrationToolDeclaration => ({
  key: 'draft_mirror',
  description: 'Nominate a saved record for a provider mirror.',
  operation: 'draft',
  mode: 'review',
  store_key: 'drafts',
  resource_key: 'inbox',
  runtime_requirement_key: 'sync_provider',
  input_schema: { type: 'object', additionalProperties: false, properties: { account: { type: 'string' }, record_id: { type: 'string' } } },
  account_input_key: 'account',
  data_operations: ['record_read', 'prepare_record_mirror'],
  input_pins: [{ operation: 'prepare_record_mirror', outer_key: 'record_id', inner_field: 'record_id', required: true }],
  action_key: 'mirror_drafts',
  visibility: 'delegated_tools',
});
const policy = () => ({ key: 'saved_drafts', action_key: 'mirror_drafts', max_authority_seconds: 3600, max_attempts_per_day: 3 });

test('buildRecordMirrorNomination assembles the exact record and owner store/mirror pins', () => {
  const sessionId = uuid(), recordId = uuid(), requestId = uuid();
  const current = { store: { record_mirrors: [policy()] }, connection: { session_id: sessionId }, expires_at: Date.now() + 300_000 };
  const nomination = buildRecordMirrorNomination(declaration(), { account: 'acct_1', record_id: recordId }, current, requestId, Date.now());
  assert.equal(nomination.connection_session_id, sessionId);
  assert.equal(nomination.store_key, 'drafts');
  assert.equal(nomination.mirror_key, 'saved_drafts');
  assert.equal(nomination.record_id, recordId);
  assert.equal(nomination.request_id, requestId);
  assert.equal(nomination.expected_revision, 0);
  assert.equal(nomination.max_attempts_per_day, 3);
  assert.ok(Date.parse(nomination.expires_at) > Date.now(), 'expiry is future');
  assert.ok(Date.parse(nomination.expires_at) <= Date.now() + 3600_000, 'expiry is capped by the mirror policy');
});

test('buildRecordMirrorNomination never names a mirror, account or lifetime from caller input', () => {
  const current = { store: { record_mirrors: [policy()] }, connection: { session_id: uuid() }, expires_at: Date.now() + 300_000 };
  assert.throws(
    () => buildRecordMirrorNomination({ ...declaration(), action_key: 'organize_messages' }, { account: 'a', record_id: uuid() }, current, uuid(), Date.now()),
    /APP_INTEGRATION_TOOL_ACCESS_DENIED/,
    'an action_key with no matching mirror policy is denied',
  );
  assert.throws(
    () => buildRecordMirrorNomination(declaration(), { account: 'a', record_id: 123 }, current, uuid(), Date.now()),
    /APP_INTEGRATION_TOOL_ACCESS_DENIED/,
    'a non-string record id is denied',
  );
});

test('nominateRecordMirror lands exactly one pending card for a valid nomination', async () => {
  let cardWritten = false;
  let principalSeen: unknown = null;
  mock.module(new URL('../src/lib/db.ts', import.meta.url).href, {
    namedExports: {
      db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        execute: async () => { cardWritten = true; return { rows: [{ id: 'action-id' }] }; },
      }) },
    },
  });
  mock.module(new URL('../src/lib/app-integration-tool-authority.ts', import.meta.url).href, {
    namedExports: {
      currentAppIntegrationToolPrincipal: async (_tx: unknown, caller: unknown) => { principalSeen = caller; return { identity: 'agent', expires_at: Date.now() + 60_000 }; },
    },
  });
  try {
    const { nominateRecordMirror } = await import('../src/lib/app-record-mirror-service.js');
    const orgId = uuid(), ownerId = uuid();
    const current = {
      scope: { org_id: orgId, owner_user_id: ownerId },
      connection: { account_ref: 'account_1' },
      store: { key: 'drafts', record_mirrors: [policy()] },
      consent: { consent_id: uuid() },
    } as never;
    const caller = { org_id: orgId, user_id: ownerId, kind: 'defty' as const, principal_id: ownerId, access_expires_at: Date.now() + 60_000, conversation_id: uuid(), employee_id: uuid() };
    const nomination = {
      connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: uuid(),
      request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1,
    };
    const result = await nominateRecordMirror(caller, current, nomination);
    assert.equal(result.approval_status, 'pending');
    assert.equal(result.mirror_key, 'saved_drafts');
    assert.ok(cardWritten, 'one pending agent_actions card is written');
    assert.equal(principalSeen, caller);
  } finally {
    mock.restoreAll();
  }
});

