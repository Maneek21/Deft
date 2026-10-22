import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { appInstallations, appConnectionSessions, appResourceBindings, appRuntimeRegistrations,
  appOwnerConnectionAdmissions, appRuntimeBindings } from '@deft/db/schema';

const hash = 'sha256:' + 'a'.repeat(64), expires = '2030-01-01T00:00:00.000Z';
mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { db: {} } });
mock.module(new URL('../src/lib/module-service.ts', import.meta.url).href, { namedExports: { assertCurrentModuleManagerWithExecutor: async () => {} } });
mock.module(new URL('../src/lib/app-connection-current-locators.ts', import.meta.url).href, { namedExports: { currentConsentContinuationSourceLocators: () => { throw Error('not used'); } } });
mock.module(new URL('../src/lib/app-connection-session-authority.ts', import.meta.url).href, { namedExports: { currentAppConnectionReadAuthority: async () => { throw Error('not used'); } } });
mock.module(new URL('../src/lib/app-connection-upgrade-fence.ts', import.meta.url).href, { namedExports: { appConnectionUpgradeSourceIsAvailable: async () => true } });
mock.module(new URL('../src/lib/app-connection-session-registry.ts', import.meta.url).href, { namedExports: {
  AppConnectionSessionRegistryConfigSchema: {}, connectionProfileDigest: () => hash, connectionTransportEntryDigest: () => hash,
  getAppConnectionSessionRegistry: async () => { throw Error('not used'); },
} });
const { UpgradeContinuityProofSchema, rowDigest } = await import('../src/lib/app-upgrade-trust-continuity.js');
const { trustedUpgradeRegistryEntries } = await import('../src/lib/app-upgrade-trust-registry.js');
type Row = Record<string, any>;
const complete = (table: any, values: Row): Row => Object.fromEntries(Object.values(getTableColumns(table)).map(column =>
  [column.name, values[column.name] ?? (column.name === 'expires_at' ? new Date(expires) : null)]));
const driver = (value: unknown) => value instanceof Date ? value.toISOString().replace('T', ' ').replace(/Z$/u, '') : value;
const fields = (table: any, value: Row | null) => Object.values(getTableColumns(table)).map(column => driver(value?.[column.name] ?? null));

function fixture() {
  const org = randomUUID(), installation = randomUUID(), owner = randomUUID(), operator = randomUUID();
  const prior = randomUUID(), target = randomUUID(), grant = randomUUID(), sourceRegistration = randomUUID();
  const registrationId = randomUUID(), bindingId = randomUUID();
  const profile = { schema_version: 'deft.app_connection_profile.v1', key: 'mail', provider_id: 'mail', operator_user_id: operator,
    runtime_requirement_key: 'mail', resource_key: 'messages', action_keys: [], authorization_origin: 'https://provider.example.test', credential_custody: 'runtime', executable: false };
  const scope = { org_id: org, owner_user_id: owner, installation_id: installation, app_version_id: prior, grant_snapshot_id: randomUUID(),
    package_digest: hash, grant_snapshot_digest: hash, lifecycle_epoch: 1, grant_epoch: 1, target_key: 'primary', resource_key: 'messages',
    resource_binding_id: randomUUID(), runtime_registration_id: sourceRegistration, operator_user_id: operator, runtime_epoch: 1,
    profile_digest: hash, consent_expires_at: null, consent_lifetime: 'until_revoked' };
  const source = { session_id: randomUUID(), revision: 2, scope, profile, state: 'connected', callback_state_hash: 'a'.repeat(64), callback_consumed: true,
    callback_expires_at: expires, runtime_session_ref: 'private_reference', account: { account_ref: randomUUID(), label: 'Fixture' }, created_at: expires, updated_at: expires };
  const pinRow = (table: any, id = randomUUID()) => complete(table, { id, org_id: org, state: 'active', created_at: new Date('2026-01-01T00:00:00.123Z') });
  const binding = pinRow(appResourceBindings, scope.resource_binding_id), registration = pinRow(appRuntimeRegistrations, sourceRegistration);
  const admission = pinRow(appOwnerConnectionAdmissions), action = pinRow(appRuntimeBindings);
  const proof = UpgradeContinuityProofSchema.parse({ schema_version: 'deft.app_upgrade_continuity.v1', request_id: randomUUID(), org_id: org,
    installation_id: installation, prior_version_id: prior, version_id: target, grant_id: grant, lifecycle_epoch: 2, grant_epoch: 2,
    trust_revision: 7, owner_id: owner, operator_id: operator, owner_role: 'owner', operator_role: 'member', source_session_id: source.session_id,
    source_revision: source.revision, source_scope: scope, source_profile: profile, connection_protocol: 'v2', transport_digest: hash,
    source_binding: { id: binding.id, digest: rowDigest(binding) }, source_registration: { id: registration.id, digest: rowDigest(registration) },
    source_admission: { id: admission.id, digest: rowDigest(admission) }, source_actions: [{ id: action.id, digest: rowDigest(action) }],
    source_observations: [], source_data: [], web_session_id: randomUUID(), issuance_expires_at: expires });
  const alias = { schema_version: 'deft.app_upgrade_registration.v1', proof_id: proof.request_id, org_id: org,
    installation_id: installation, registration_id: registrationId, binding_id: bindingId, runtime_epoch: 2,
    source_registration_id: sourceRegistration, source_runtime_epoch: 1, profile_digest: hash, transport_digest: hash };
  const current: Row = {
    installation: complete(appInstallations, { id: installation, org_id: org, state: 'active', active_version_id: target,
      active_grant_snapshot_id: grant, lifecycle_epoch: 2, grant_epoch: 2 }),
    prior: { id: prior, manifest: { schema_version: '7', id: 'community.example.fixture', compatibility: { app_protocol: '7' }, version: '1.0.0' } },
    target: { id: target, manifest: { schema_version: '7', id: 'community.example.fixture', compatibility: { app_protocol: '7' }, version: '1.0.1' } },
    source: complete(appConnectionSessions, { org_id: org, owner_user_id: owner, session_id: source.session_id, record: source }),
    binding, registration, admission, trust: { after_state: { trusted: true, revision: 7 } },
    owner: { id: owner, role: 'owner', active: true, kind: 'human', agent: false },
    operator: { id: operator, role: 'member', active: true, kind: 'human', agent: false },
    successor_binding: complete(appResourceBindings, { id: bindingId, org_id: org, state: 'active', app_installation_id: installation,
      app_version_id: target, grant_snapshot_id: grant, runtime_registration_id: registrationId, owner_user_id: owner, consent_lifetime: 'until_revoked' }),
    successor_registration: complete(appRuntimeRegistrations, { id: registrationId, org_id: org, state: 'active',
      app_version_id: target, grant_snapshot_id: grant, runtime_epoch: 2, operator_user_id: operator }),
  };
  const state = { aliasRows: 1, proofRows: 1, aliasTotal: 1, auditOrg: org, actions: [action], proofPresent: true };
  const calls: { text: string; values: unknown[] }[] = [];
  const nativeRow = (ordinal: number) => [ordinal, state.aliasTotal, state.auditOrg, alias, state.proofPresent ? proof.request_id : null,
    state.proofPresent ? proof : null, ...fields(appInstallations, current.installation), current.prior?.id ?? null, current.prior?.manifest ?? null,
    current.target?.id ?? null, current.target?.manifest ?? null, ...fields(appConnectionSessions, current.source),
    ...fields(appResourceBindings, current.binding), ...fields(appRuntimeRegistrations, current.registration), ...fields(appOwnerConnectionAdmissions, current.admission),
    current.trust?.after_state ?? null, ...['owner', 'operator'].flatMap(name => ['id', 'role', 'active', 'kind', 'agent'].map(key => current[name]?.[key] ?? null)),
    ...fields(appResourceBindings, current.successor_binding), ...fields(appRuntimeRegistrations, current.successor_registration)];
  const tx = drizzle({ query: async (query: any, values: unknown[]) => {
    const text = typeof query === 'string' ? query : query.text; calls.push({ text, values });
    if (text.includes('registry_alias_limit')) return { rows: Array.from({ length: state.aliasRows }, (_, index) =>
      Array.from({ length: state.proofRows }, () => nativeRow(index + 1))).flat() };
    assert.match(text, /from "app_runtime_bindings"/u);
    return { rows: state.actions.map(row => fields(appRuntimeBindings, row)) };
  } } as never);
  const root = { org_id: org, installation_id: installation, runtime_registration_id: sourceRegistration, runtime_epoch: 1, profile, connection_protocol: 'v2' };
  return { calls, current, proof, alias, state, action, run: () => trustedUpgradeRegistryEntries([root] as never, tx as never) };
}

test('one current typed point snapshot plus one complete action-pin query replaces five registry reads', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.length, 1); assert.equal(result[0]!.runtime_registration_id, f.alias.registration_id); assert.equal(f.calls.length, 2);
  const query = f.calls[0]!.text;
  assert.match(query, /left join lateral/u); assert.ok(f.calls[0]!.values.includes(257) && f.calls[0]!.values.includes(2));
  assert.match(query, /count\(\*\) over/u); assert.match(query, /"alias_total" <= 256/u);
  for (const table of ['app_installations', 'registry_prior_version', 'registry_target_version', 'app_connection_sessions',
    'app_resource_bindings', 'app_runtime_registrations', 'app_owner_connection_admissions', 'registry_successor_binding', 'registry_successor_registration'])
    assert.match(query, new RegExp('"' + table + '"\\."org_id" = "registry_aliases"\\."org_id"', 'u'));
  assert.ok(!query.split(' from ')[0]!.includes('"package"')); assert.match(f.calls[1]!.text, /"app_runtime_bindings"\."org_id" = \$/u);
  await f.run(); assert.equal(f.calls.length, 4, 'no current alias, membership or row-set authority is cached');
});

test('revocation owner epoch membership trust and every complete pin still fence a later invocation', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => { f.current.binding.state = 'revoked'; },
    (f: ReturnType<typeof fixture>) => { f.current.installation.id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.current.installation.org_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.current.source.org_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.current.source.owner_user_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.current.source.session_id = randomUUID(); },
    ...(['binding', 'registration', 'admission'] as const).map(name => (f: ReturnType<typeof fixture>) => {
      f.current[name].org_id = randomUUID(); f.proof[('source_' + name) as 'source_binding' | 'source_registration' | 'source_admission'].digest = rowDigest(f.current[name]);
    }),
    (f: ReturnType<typeof fixture>) => { f.action.org_id = randomUUID(); f.proof.source_actions[0]!.digest = rowDigest(f.action); },
    (f: ReturnType<typeof fixture>) => { f.current.successor_binding.org_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.current.successor_binding.id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.current.successor_registration.org_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.current.successor_registration.id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.current.registration.created_at = new Date(0); },
    (f: ReturnType<typeof fixture>) => { f.current.admission.updated_at = new Date(0); },
    (f: ReturnType<typeof fixture>) => { f.action.updated_at = new Date(0); },
    (f: ReturnType<typeof fixture>) => { f.current.successor_binding.state = 'revoked'; },
    (f: ReturnType<typeof fixture>) => { f.current.successor_binding.owner_user_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.current.successor_registration.runtime_epoch++; },
    (f: ReturnType<typeof fixture>) => { f.current.installation.lifecycle_epoch++; },
    (f: ReturnType<typeof fixture>) => { f.current.installation.grant_epoch++; },
    (f: ReturnType<typeof fixture>) => { f.current.source.record.revision++; },
    (f: ReturnType<typeof fixture>) => { f.current.owner.active = false; },
    (f: ReturnType<typeof fixture>) => { f.current.operator.kind = 'agent'; },
    (f: ReturnType<typeof fixture>) => { f.current.trust.after_state.revision++; },
    (f: ReturnType<typeof fixture>) => { f.current.trust.after_state.trusted = false; },
    (f: ReturnType<typeof fixture>) => { f.current.target.manifest.future_authority = true; },
  ];
  for (const change of changes) { const f = fixture(); assert.equal((await f.run()).length, 1); change(f); assert.deepEqual(await f.run(), []); }
});

test('alias/proof set insertion, proof cardinality, owner/org replay and missing or duplicate source pins fail closed', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.aliasRows = 2; f.state.aliasTotal = 2; },
    (f: ReturnType<typeof fixture>) => { f.state.aliasTotal = 257; },
    (f: ReturnType<typeof fixture>) => { f.state.proofRows = 2; },
    (f: ReturnType<typeof fixture>) => { f.state.proofPresent = false; },
    (f: ReturnType<typeof fixture>) => { f.state.auditOrg = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.proof.org_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.proof.installation_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.proof.request_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.proof.owner_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.state.actions.length = 0; },
    (f: ReturnType<typeof fixture>) => { f.proof.source_actions.push(f.proof.source_actions[0]!); },
    (f: ReturnType<typeof fixture>) => { f.proof.source_actions.push({ id: randomUUID(), digest: hash }); },
  ]) { const f = fixture(); change(f); assert.deepEqual(await f.run(), []); }
  const malformed = fixture(); malformed.alias.runtime_epoch = 0; await assert.rejects(malformed.run());
});

test('full native Date decoding preserves proof bytes and additional current row fields cannot disappear through a subset', async () => {
  const f = fixture(); assert.ok(f.current.binding.created_at instanceof Date); assert.equal((await f.run()).length, 1);
  f.current.binding.updated_at = new Date('2026-01-01T00:00:00.999Z'); assert.deepEqual(await f.run(), []);
});
