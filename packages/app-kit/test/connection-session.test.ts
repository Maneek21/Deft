import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppConnectionProfileSchema, RequestedConnectionDeclarationSchema, AppConnectionSessionScopeSchema,
  AppConnectionSessionCallbackSchema, AppConnectionRuntimeRequestSchema, AppConnectionRuntimeResultSchema,
  AppConnectionSessionBeginSchema, AppConnectionSessionRefreshSchema, canonicalAppConnectionProfileJson,
  AppConnectionRuntimeAuthorityRequestSchema, AppConnectionRuntimeAuthorityResultSchema,
  OwnerConnectionPolicyDeclarationSchema, buildDeftAppPackage, projectDeftAppRequestedAuthority, diffDeftAppRequestedAuthority,
} from '../dist/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const profile = { schema_version: 'deft.app_connection_profile.v1', key: 'google_mail', provider_id: 'google_mail',
  operator_user_id: id, runtime_requirement_key: 'inbox', resource_key: 'messages', action_keys: ['send_message'],
  authorization_origin: 'https://accounts.google.com', credential_custody: 'runtime', executable: false };
const scope = { org_id: id, owner_user_id: id, installation_id: id, app_version_id: id, grant_snapshot_id: id,
  package_digest: 'sha256:' + '1'.repeat(64), grant_snapshot_digest: 'sha256:' + '2'.repeat(64), lifecycle_epoch: 1, grant_epoch: 1,
  target_key: 'personal', resource_key: 'messages', resource_binding_id: id, runtime_registration_id: id,
  operator_user_id: id, runtime_epoch: 1, profile_digest: 'sha256:' + '3'.repeat(64), consent_expires_at: '2026-10-09T12:00:00.000Z' };
test('portable requests and host profiles have separate closed identity surfaces', () => {
  const declaration = { key: 'mailbox', resource_key: 'messages', action_keys: ['send_message'],
    provider_profile_key: 'google_mail', runtime_requirement_key: 'inbox' };
  assert.deepEqual(RequestedConnectionDeclarationSchema.parse(declaration), declaration);
  assert.deepEqual(AppConnectionProfileSchema.parse(profile), profile);
  for (const secret of [{ client_secret: 'not-allowed' }, { oauth: {} }, { module_path: '/adapter.js' }, { access_token: 'not-allowed' }]) {
    assert.equal(AppConnectionProfileSchema.safeParse({ ...profile, ...secret }).success, false);
  }
  assert.equal(RequestedConnectionDeclarationSchema.safeParse({ ...declaration, operator_user_id: id }).success, false);
  for (const mutation of [{ executable: true }, { credential_custody: 'host' }, { action_keys: ['z', 'a'] },
    { action_keys: ['a', 'a'] }, { authorization_origin: 'http://accounts.google.com' },
    { authorization_origin: 'https://accounts.google.com/oauth' }]) assert.equal(AppConnectionProfileSchema.safeParse({ ...profile, ...mutation }).success, false);
  assert.equal(canonicalAppConnectionProfileJson(profile), canonicalAppConnectionProfileJson(Object.fromEntries(Object.entries(profile).reverse())));
});
test('session and transport shapes cannot nominate arbitrary owner, account, executable input or provider secrets', () => {
  assert.deepEqual(AppConnectionSessionScopeSchema.parse(scope), scope);
  assert.equal(AppConnectionSessionBeginSchema.safeParse({ installation_id: id, target_key: 'personal', owner_user_id: id }).success, false);
  assert.equal(AppConnectionSessionRefreshSchema.safeParse({ session_id: id, request_id: id, account_ref: 'other' }).success, false);
  const callback = { session_id: id, state: 'a'.repeat(43), outcome: 'authorized', code: 'one-time-code' };
  assert.deepEqual(AppConnectionSessionCallbackSchema.parse(callback), callback);
  assert.equal(AppConnectionSessionCallbackSchema.safeParse({ ...callback, outcome: 'denied' }).success, false);
  const request = { schema_version: 'deft.app_connection_runtime.v1', operation: 'callback', session_id: id, scope,
    expires_at: scope.consent_expires_at, runtime_session_ref: 'runtime_session', callback: { outcome: 'authorized', code: 'one-time-code' } };
  assert.deepEqual(AppConnectionRuntimeRequestSchema.parse(request), request);
  assert.equal(AppConnectionRuntimeRequestSchema.safeParse({ ...request, operation: 'execute', input: {} }).success, false);
  assert.equal(AppConnectionRuntimeRequestSchema.safeParse({ ...request, host_bearer: 'not-allowed' }).success, false);
  assert.equal(AppConnectionRuntimeResultSchema.safeParse({ state: 'connected', account: { account_ref: 'account', label: 'Mail', access_token: 'not-allowed' } }).success, false);
  assert.deepEqual(AppConnectionRuntimeResultSchema.parse({ state: 'indeterminate' }), { state: 'indeterminate' });
  assert.equal(AppConnectionRuntimeResultSchema.safeParse({ state: 'unknown_success' }).success, false);
  assert.equal(AppConnectionRuntimeResultSchema.safeParse({ state: 'awaiting_callback', runtime_session_ref: 'runtime_session',
    authorization_url: 'https://accounts.google.com/oauth?client_secret=not-allowed' }).success, false);
});

const scalar = { type: 'object' as const, additionalProperties: false as const,
  properties: { subject: { type: 'string' as const, maxLength: 200 } }, required: ['subject'] };

test('runtime authority checks are purpose bound and cannot nominate new scopes or secrets', () => {
  const request = { schema_version: 'deft.app_connection_runtime_authority.v1', session_id: id, scope,
    operation: 'callback', expires_at: scope.consent_expires_at };
  assert.deepEqual(AppConnectionRuntimeAuthorityRequestSchema.parse(request), request);
  assert.deepEqual(AppConnectionRuntimeAuthorityResultSchema.parse({ ...request, allowed: true }), { ...request, allowed: true });
  for (const mutation of [{ operation: 'send' }, { owner_bearer: 'forbidden' }, { provider_credentials: {} },
    { expires_at: '2026-10-09T12:00:00.001Z' }]) {
    assert.equal(AppConnectionRuntimeAuthorityRequestSchema.safeParse({ ...request, ...mutation }).success, false);
  }
  assert.equal(AppConnectionRuntimeAuthorityResultSchema.safeParse({ ...request, allowed: false }).success, false);
  assert.equal(AppConnectionRuntimeAuthorityResultSchema.safeParse({ ...request, allowed: true, access_token: 'forbidden' }).success, false);
});
const policy = { key: 'mailbox', resource_key: 'messages', action_keys: ['send_message'], max_consent_seconds: 86400 };
const manifest = { schema_version: '7' as const, compatibility: { app_protocol: '7' as const }, id: 'community.example.connection-e1',
  version: '1.0.0', name: 'Connection E1', license: 'AGPL-3.0-only', modules: [], navigation: [],
  runtime_requirements: [{ key: 'dispatch', protocol_version: 'deft.app_runtime_channel.v1' as const },
    { key: 'inbox', protocol_version: 'deft.app_runtime_channel.v3' as const }],
  private_capabilities: [{ key: 'send', version: '1' as const, input_schema: scalar, output_schema: scalar }],
  runtime_actions: [{ key: 'send_message', label: 'Send', capability_key: 'send', runtime_requirement_key: 'dispatch' }],
  native_actions: [], sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v2' as const, key: 'messages',
    runtime_requirement_key: 'inbox', resource_type: 'message', requested_visibility: 'user_private' as const, record_schema: scalar,
    label_field: 'subject', attachments: { max_attachment_bytes: 1024, max_attachments_per_record: 1, max_attachments_per_run: 1,
      max_attachment_bytes_per_run: 1024, retention_days: 1, allowed_media_types: ['application/pdf'] as ['application/pdf'] } }],
  experiences: [], public_actions: [], owner_connections: [policy] };
test('paired requested provider references preserve legacy packages and require a fresh authority review', async () => {
  assert.deepEqual(OwnerConnectionPolicyDeclarationSchema.parse(policy), policy);
  for (const added of [{ provider_profile_key: 'google_mail' }, { runtime_requirement_key: 'inbox' }])
    assert.equal(OwnerConnectionPolicyDeclarationSchema.safeParse({ ...policy, ...added }).success, false);
  const proposed = { ...manifest, owner_connections: [{ ...policy, provider_profile_key: 'google_mail', runtime_requirement_key: 'inbox' }] };
  const prior = await buildDeftAppPackage({ manifest, artifacts: [] }), next = await buildDeftAppPackage({ manifest: proposed, artifacts: [] });
  assert.notEqual(prior.package.manifest_digest, next.package.manifest_digest);
  assert.equal((await buildDeftAppPackage({ manifest, artifacts: [] })).json, prior.json);
  const report = projectDeftAppRequestedAuthority(proposed);
  assert.deepEqual(report.classification, { authority_state: 'requested_only', executable: false, provider_access: false, review_required: true });
  assert.ok('owner_connections' in report.requirements);
  assert.deepEqual(report.requirements.owner_connections, proposed.owner_connections);
  const diff = await diffDeftAppRequestedAuthority({ prior: manifest, proposed });
  assert.equal(diff.carry_forward_eligible, false);
  assert.deepEqual(diff.changed_atoms, ['owner_connections']);
  for (const runtime_requirement_key of ['dispatch', 'missing']) await assert.rejects(buildDeftAppPackage({ manifest: {
    ...proposed, owner_connections: [{ ...proposed.owner_connections[0]!, runtime_requirement_key }] }, artifacts: [] }), /resource v3 Runtime requirement/);
});
