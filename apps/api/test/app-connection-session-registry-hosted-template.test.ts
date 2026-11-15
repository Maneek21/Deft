import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { AppConnectionSessionRegistry, AppConnectionSessionRegistryConfigSchema, connectionProfileDigest,
  connectionTransportEntryDigest } from '../src/lib/app-connection-session-registry.js';
import { AppError } from '../src/lib/app-errors.js';
import { isHostedMode } from '../src/lib/hosted-mode.js';

const VERSION = 'deft.app_connection_http_registrations.v1' as const;
const authorityToken = 'a'.repeat(43), runtimeToken = 'b'.repeat(43);
const sha = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const templateProfile = { schema_version: 'deft.app_connection_profile.v1' as const, key: 'server_account', provider_id: 'example_provider',
  runtime_requirement_key: 'sync_provider', resource_key: 'records', action_keys: ['publish_record'],
  authorization_origin: 'https://setup.example.test', credential_custody: 'runtime' as const, executable: false as const };
const template = { profile: templateProfile, connection_protocol: 'credential_form.v1' as const,
  endpoint: 'https://setup.example.test/v1/connections', runtime_auth_token: runtimeToken, authority_token_sha256: sha(authorityToken) };
const policy = { key: 'server_account', resource_key: 'records', action_keys: ['publish_record'], max_consent_seconds: 3600,
  provider_profile_key: 'server_account', runtime_requirement_key: 'sync_provider' };
const config = (extra: Record<string, unknown> = {}) => ({ schema_version: VERSION, entries: [], hosted_templates: [template], ...extra });
const unavailable = (error: unknown) => error instanceof AppError && error.code === 'APP_CONNECTION_PROFILE_UNAVAILABLE' && error.status === 503;

/** A scope as the Host's own authority builds it: every identifier is created
 * inside the installation, after the template file was written. */
function scopeFor(operator = randomUUID(), profile = { ...templateProfile, operator_user_id: operator }) {
  return { profile, scope: { org_id: randomUUID(), owner_user_id: randomUUID(), installation_id: randomUUID(), app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), package_digest: 'sha256:' + '1'.repeat(64), grant_snapshot_digest: 'sha256:' + '2'.repeat(64),
    lifecycle_epoch: 1, grant_epoch: 1, target_key: 'primary', resource_key: 'records', resource_binding_id: randomUUID(),
    runtime_registration_id: randomUUID(), operator_user_id: operator, runtime_epoch: 1,
    profile_digest: connectionProfileDigest(profile), consent_expires_at: new Date(Date.now() + 600000).toISOString() } };
}

test('hosted mode is the single exact switch', () => {
  const before = process.env.DEFT_HOSTED;
  try {
    for (const [value, expected] of [[undefined, false], ['', false], ['1', false], ['TRUE', false], ['true ', false], ['false', false], ['true', true]] as const) {
      if (value === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = value;
      assert.equal(isHostedMode(), expected, String(value));
      // The registry reads the same switch when it is not told explicitly.
      if (expected) assert.doesNotThrow(() => new AppConnectionSessionRegistry(config()));
      else assert.throws(() => new AppConnectionSessionRegistry(config()), unavailable, String(value));
    }
  } finally { if (before === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = before; }
});

test('a self-hosted install refuses a file with templates and is otherwise unchanged', () => {
  assert.throws(() => new AppConnectionSessionRegistry(config(), fetch, [], false), unavailable);
  // Without templates the file is read exactly as before, in both states.
  for (const hosted of [false, true]) {
    const registry = new AppConnectionSessionRegistry({ schema_version: VERSION, entries: [] }, fetch, [], hosted), s = scopeFor();
    assert.throws(() => registry.profile(s.scope.org_id, s.scope.installation_id, policy, s.scope.operator_user_id), unavailable);
    assert.throws(() => registry.protocol(s.scope, s.profile), unavailable);
    assert.throws(() => registry.transportDigest(s.scope.org_id, s.scope.installation_id, s.profile), unavailable);
    assert.throws(() => registry.reviewedProtocol(s.scope.org_id, s.scope.installation_id, s.profile), unavailable);
    assert.throws(() => registry.authenticate(s.scope, 'Bearer ' + authorityToken));
    assert.throws(() => registry.preauthenticateTransport(s.scope, 'Bearer ' + authorityToken));
  }
  // Even an empty list names the hosted-only field, which self-hosted has never accepted.
  assert.throws(() => new AppConnectionSessionRegistry(config({ hosted_templates: [] }), fetch, [], false), unavailable);
  assert.doesNotThrow(() => new AppConnectionSessionRegistry(config({ hosted_templates: [] }), fetch, [], true));
});

test('a template is data only: no operator, no other protocol, no author endpoint, bounded and unambiguous', () => {
  const bad = (hosted_templates: unknown) => assert.equal(AppConnectionSessionRegistryConfigSchema.safeParse(config({ hosted_templates })).success, false);
  bad([{ ...template, profile: { ...templateProfile, operator_user_id: randomUUID() } }]);
  bad([{ ...template, connection_protocol: 'v2' }]);
  bad([{ ...template, connection_protocol: undefined }]);
  bad([{ ...template, endpoint: 'http://127.0.0.1/v1/connections' }]);
  bad([{ ...template, endpoint: 'https://setup.example.test/other' }]);
  bad([{ ...template, runtime_auth_token: 'short' }]);
  bad([{ ...template, org_id: randomUUID() }]);
  bad([{ ...template, module_path: '/tmp/provider.js' }]);
  bad([{ ...template, profile: { ...templateProfile, credential_custody: 'host' } }]);
  bad(Array.from({ length: 5 }, (_, index) => ({ ...template, profile: { ...templateProfile, key: 'server_account_' + index } })));
  // Two templates for one declared profile would make the transport ambiguous.
  assert.throws(() => new AppConnectionSessionRegistry(config({ hosted_templates: [template, { ...template, endpoint: 'https://other.example.test/v1/connections' }] }), fetch, [], true), unavailable);
});

test('in hosted mode a template answers for identifiers created after it was written', async () => {
  const requests: { url: string; authorization: string | null; body: string }[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const body = String(init?.body); requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body });
    const input = JSON.parse(body) as { session_id: string };
    return Response.json({ schema_version: 'deft.app_connection_form_runtime.v1', session_id: input.session_id, runtime_session_ref: 'r'.repeat(43),
      state: 'not_connected', input_consumed: false, account: null, receipt: null });
  }) as typeof fetch;
  const registry = new AppConnectionSessionRegistry(config(), fetcher, [], true);
  for (const s of [scopeFor(), scopeFor()]) {
    // Admission: the declared policy and the reviewed operator select the profile.
    assert.deepEqual(registry.profile(s.scope.org_id, s.scope.installation_id, policy, s.scope.operator_user_id), s.profile);
    assert.equal(registry.transportDigest(s.scope.org_id, s.scope.installation_id, s.profile), connectionTransportEntryDigest(template));
    assert.equal(registry.reviewedProtocol(s.scope.org_id, s.scope.installation_id, s.profile), 'credential_form.v1');
    assert.equal(registry.protocol(s.scope, s.profile), 'credential_form.v1');
    assert.doesNotThrow(() => registry.assertReady(s.scope, s.profile));
    // The Runtime authenticates to the Host with the template's authority token only.
    assert.doesNotThrow(() => registry.authenticate(s.scope, 'Bearer ' + authorityToken));
    assert.doesNotThrow(() => registry.preauthenticateTransport(s.scope, 'Bearer ' + authorityToken));
    assert.throws(() => registry.authenticate(s.scope, 'Bearer ' + runtimeToken));
    assert.throws(() => registry.preauthenticateTransport(s.scope, 'Bearer ' + runtimeToken));
    assert.throws(() => registry.authenticate(s.scope, undefined));
    // Only the credential form may be carried; no OAuth protocol is reachable.
    assert.throws(() => registry.runtime(s.scope, s.profile), unavailable);
    assert.throws(() => registry.runtimeV2(s.scope, s.profile), unavailable);
    assert.throws(() => registry.upgradeRuntime(s.scope, s.profile), unavailable);
    assert.throws(() => registry.channelInstallRuntime(s.scope, s.profile), unavailable);
    const input = { schema_version: 'deft.app_connection_form_runtime.v1' as const, session_id: randomUUID(), scope: s.scope, operation: 'begin' as const,
      expires_at: new Date(Date.now() + 20000).toISOString(), setup_expires_at: new Date(Date.now() + 200000).toISOString(), action_consents: [], source: null };
    const reply = await registry.formRuntime(s.scope, s.profile).request(input, new AbortController().signal);
    assert.equal(reply.state, 'not_connected');
    const sent = requests.at(-1)!;
    assert.equal(sent.url, template.endpoint); assert.equal(sent.authorization, 'Bearer ' + runtimeToken);
    assert.deepEqual(JSON.parse(sent.body).scope, s.scope); assert.ok(!sent.body.includes(authorityToken));
  }
  assert.equal(requests.length, 2);
});

test('a template never answers for a profile it does not describe exactly', () => {
  const registry = new AppConnectionSessionRegistry(config(), fetch, [], true), s = scopeFor();
  const org = s.scope.org_id, installation = s.scope.installation_id, operator = s.scope.operator_user_id;
  // Admission needs the reviewed operator and the exact declared policy.
  assert.throws(() => registry.profile(org, installation, policy), unavailable);
  for (const changed of [{ provider_profile_key: 'other_account' }, { resource_key: 'other' }, { runtime_requirement_key: 'other' },
    { action_keys: [] }, { action_keys: ['publish_record', 'second'] }])
    assert.throws(() => registry.profile(org, installation, { ...policy, ...changed }, operator), unavailable, JSON.stringify(changed));
  // A scope whose profile digest is not the template completed with its own operator.
  const foreignOperator = scopeFor(randomUUID());
  assert.throws(() => registry.protocol({ ...s.scope, profile_digest: foreignOperator.scope.profile_digest }, undefined as never), unavailable);
  assert.throws(() => registry.authenticate({ ...s.scope, operator_user_id: randomUUID() }, 'Bearer ' + authorityToken));
  const moved = { ...s.profile, authorization_origin: 'https://elsewhere.example.test' };
  assert.throws(() => registry.protocol({ ...s.scope, profile_digest: connectionProfileDigest(moved) }, moved), unavailable);
  assert.throws(() => registry.transportDigest(org, installation, moved), unavailable);
  assert.throws(() => registry.reviewedProtocol(org, installation, moved), unavailable);
  assert.throws(() => registry.protocol(s.scope, moved), unavailable);
  assert.throws(() => registry.preauthenticateTransport({ ...s.scope, profile_digest: connectionProfileDigest(moved) }, 'Bearer ' + authorityToken));
});

test('exact entries stay the complete review for their installation; a template fills only what no entry covers', () => {
  const s = scopeFor(), entryToken = 'c'.repeat(43);
  const entry = { org_id: s.scope.org_id, installation_id: s.scope.installation_id, runtime_registration_id: s.scope.runtime_registration_id,
    runtime_epoch: 1, profile: s.profile, connection_protocol: 'credential_form.v1' as const,
    endpoint: 'https://reviewed.example.test/v1/connections', runtime_auth_token: 'd'.repeat(43), authority_token_sha256: sha(entryToken) };
  const registry = new AppConnectionSessionRegistry(config({ entries: [entry] }), fetch, [], true);
  // The reviewed entry, not the template, answers for its own registration.
  assert.equal(registry.transportDigest(s.scope.org_id, s.scope.installation_id, s.profile), connectionTransportEntryDigest(entry));
  assert.doesNotThrow(() => registry.authenticate(s.scope, 'Bearer ' + entryToken));
  assert.throws(() => registry.authenticate(s.scope, 'Bearer ' + authorityToken));
  // Another registration of that reviewed installation and profile is not widened by the template.
  const sibling = { ...s.scope, runtime_registration_id: randomUUID() };
  assert.throws(() => registry.protocol(sibling, s.profile), unavailable);
  assert.throws(() => registry.authenticate(sibling, 'Bearer ' + authorityToken));
  assert.throws(() => registry.authenticate({ ...s.scope, runtime_epoch: 2 }, 'Bearer ' + entryToken));
  // An installation no entry mentions is still served by the template.
  const other = scopeFor();
  assert.equal(registry.protocol(other.scope, other.profile), 'credential_form.v1');
  assert.doesNotThrow(() => registry.authenticate(other.scope, 'Bearer ' + authorityToken));
});
