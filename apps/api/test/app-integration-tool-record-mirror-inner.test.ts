import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { installedToolIsWrite } from '../src/lib/app-installed-tool-discovery.js';
import { toolMetadata, assertToolCallback, integrationDigest } from '../src/lib/app-integration-tool-journal.js';
import type { AppIntegrationToolDeclaration } from '../../../packages/app-kit/src/app-integration-tools.js';

const digest = () => `sha256:${'a'.repeat(64)}`;
const uuid = () => randomUUID();

function mirrorDeclaration(): AppIntegrationToolDeclaration {
  return {
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
  };
}

function envelope(recordId: string) {
  const scope = {
    org_id: uuid(), owner_user_id: uuid(), installation_id: uuid(), app_version_id: uuid(), grant_snapshot_id: uuid(),
    package_digest: digest(), grant_snapshot_digest: digest(), lifecycle_epoch: 1, grant_epoch: 1,
    target_key: 'primary', resource_key: 'inbox', resource_binding_id: uuid(),
    runtime_registration_id: uuid(), operator_user_id: uuid(), runtime_epoch: 1,
    profile_digest: digest(), consent_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const connection = { session_id: uuid(), session_revision: 1, runtime_session_ref: 'runtime_ref', account_ref: 'account_1' };
  const authority = { consent_id: uuid(), consent_digest: digest(), data_policy_digest: digest() };
  const requestId = uuid();
  const outer = {
    schema_version: 'deft.app_integration_tool_runtime.v1',
    request_id: requestId, scope, connection, authority,
    tool_key: 'draft_mirror', tool_operation: 'draft', store_key: 'drafts',
    input: { account: 'account_1', record_id: recordId },
    source_refs: [],
    expires_at: new Date(Date.now() + 30_000).toISOString(),
    prepare_expires_at: new Date(Date.now() + 300_000).toISOString(),
  };
  const metadata = toolMetadata(outer, mirrorDeclaration(), {
    caller: { org_id: scope.org_id, user_id: scope.owner_user_id, kind: 'personal_mcp', principal_id: uuid(), access_expires_at: Date.now() + 300_000, authorization_version: 1 },
    target: { installation_id: scope.installation_id, account_ref: 'account_1', resource_binding_id: scope.resource_binding_id, store_key: 'drafts' },
    grant: { id: uuid(), revision: 1, digest: digest() },
    authority_identity: 'fixture-identity',
    authority_expires_at: Date.now() + 300_000,
  });
  const innerInput = { store_key: 'drafts', record_id: recordId };
  const callback = {
    schema_version: 'deft.app_integration_tool_authority.v1',
    request_id: requestId, scope, connection, authority,
    tool_key: 'draft_mirror', tool_operation: 'draft', store_key: 'drafts',
    expires_at: outer.expires_at, prepare_expires_at: outer.prepare_expires_at, source_refs: [],
    input_digest: integrationDigest(outer.input),
    inner: {
      operation: 'prepare_record_mirror', store_key: 'drafts',
      input_digest: integrationDigest({ operation: 'prepare_record_mirror', input: innerInput }),
      input: innerInput, action_key: 'mirror_drafts',
    },
  };
  return { metadata, callback };
}

test('prepare_record_mirror is classified as a write effect', () => {
  assert.equal(installedToolIsWrite(mirrorDeclaration()), true);
  assert.equal(installedToolIsWrite({ ...mirrorDeclaration(), key: 'read_only', data_operations: ['record_read'], input_pins: [] }), false);
});

test('the runtime callback admits a prepare_record_mirror inner operation with the declared action_key', () => {
  const recordId = uuid();
  const { metadata, callback } = envelope(recordId);
  const admitted = assertToolCallback(metadata, mirrorDeclaration(), callback);
  assert.equal(admitted.inner.operation, 'prepare_record_mirror');
});

test('a mismatched action_key or extra inner field is denied', () => {
  const recordId = uuid();
  const { metadata, callback } = envelope(recordId);
  assert.throws(
    () => assertToolCallback(metadata, mirrorDeclaration(), { ...callback, inner: { ...callback.inner, action_key: 'organize_messages' } }),
    error => String(error).includes('APP_INTEGRATION_TOOL_INNER_DENIED'),
  );
  assert.throws(
    () => assertToolCallback(metadata, mirrorDeclaration(), {
      ...callback,
      inner: { ...callback.inner, input: { store_key: 'drafts', record_id: recordId, mirror_key: 'saved_drafts' } },
    }),
    error => String(error).includes('APP_INTEGRATION_TOOL_INNER_DENIED'),
  );
});
