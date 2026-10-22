import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  AppConnectionSessionRegistryConfigSchema: {}, connectionProfileDigest: () => hash,
  connectionTransportEntryDigest: (entry: any) => entry.runtime_auth_token === 'a'.repeat(43)
    && entry.endpoint === 'https://runtime.example.test/v1/connections' && entry.authority_token_sha256 === hash ? hash : 'sha256:' + 'b'.repeat(64),
  getAppConnectionSessionRegistry: async () => { throw Error('not used'); },
} });
const { UpgradeContinuityProofSchema, rowDigest } = await import('../src/lib/app-upgrade-trust-continuity.js');
const { trustedUpgradeRegistryEntries } = await import('../src/lib/app-upgrade-trust-registry.js');
type Row = Record<string, any>;
const complete = (table: any, values: Row): Row => Object.fromEntries(Object.values(getTableColumns(table)).map(column =>
  [column.name, values[column.name] ?? (column.name === 'expires_at' ? new Date(expires) : null)]));
const driver = (value: unknown) => value instanceof Date ? value.toISOString().replace('T', ' ').replace(/Z$/u, '') : value;
const fields = (table: any, value: Row | null) => Object.values(getTableColumns(table)).map(column => driver(value?.[column.name] ?? null));
const installationFields = ['id', 'org_id', 'state', 'active_version_id', 'active_grant_snapshot_id', 'lifecycle_epoch', 'grant_epoch'];
const sourceFields = ['org_id', 'owner_user_id', 'session_id', 'record'];
const successorBindingFields = ['id', 'org_id', 'state', 'app_installation_id', 'app_version_id', 'grant_snapshot_id',
  'runtime_registration_id', 'owner_user_id', 'consent_expires_at', 'consent_lifetime'];
const successorRegistrationFields = ['id', 'org_id', 'state', 'runtime_epoch', 'app_version_id', 'grant_snapshot_id', 'operator_user_id'];
const projected = (value: Row, fields: string[]) => fields.map(field => driver(value[field] ?? null));

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
  const state = { aliasRows: 1, proofRows: 1, aliasTotal: 1, auditOrg: org, actions: [action], proofPresent: true,
    alternateVersion: undefined as string | undefined, fingerprint: undefined as string | undefined, beforeFull: undefined as (() => void) | undefined, rawFull: [] as unknown[][] };
  const fingerprint = () => state.fingerprint ?? 'sha256:' + createHash('sha256').update(JSON.stringify({
    ...current, installation: Object.fromEntries(installationFields.map(key => [key, current.installation?.[key] ?? null])),
    source: Object.fromEntries(sourceFields.map(key => [key, current.source?.[key] ?? null])), successor_binding: Object.fromEntries(successorBindingFields.map(key => [key, current.successor_binding?.[key] ?? null])),
    successor_registration: Object.fromEntries(successorRegistrationFields.map(key => [key, current.successor_registration?.[key] ?? null])),
  })).digest('hex');
  const calls: { text: string; values: unknown[]; name?: string }[] = [];
  const nativeRow = (ordinal: number) => [ordinal, state.aliasTotal, state.auditOrg, alias.registration_id,
    state.proofPresent ? proof.version_id : null,
    'sha256:' + createHash('sha256').update(JSON.stringify([alias, state.proofPresent ? proof.request_id : null, state.proofPresent ? proof : null])).digest('hex'),
    fingerprint(), alias, state.proofPresent ? proof.request_id : null, state.proofPresent ? proof : null,
    ...projected(current.installation, installationFields), current.prior?.id ?? null, current.prior?.manifest ?? null,
    current.target?.id ?? null, current.target?.manifest ?? null, ...projected(current.source, sourceFields),
    ...fields(appResourceBindings, current.binding), ...fields(appRuntimeRegistrations, current.registration), ...fields(appOwnerConnectionAdmissions, current.admission),
    current.trust?.after_state ?? null, ...['owner', 'operator'].flatMap(name => ['id', 'role', 'active', 'kind', 'agent'].map(key => current[name]?.[key] ?? null)),
    ...projected(current.successor_binding, successorBindingFields), ...projected(current.successor_registration, successorRegistrationFields)];
  const tx = drizzle({ query: async (query: any, values: unknown[]) => {
    const text = typeof query === 'string' ? query : query.text; calls.push({ text, values, name: query.name });
    if (text.includes('registry_alias_limit')) {
      const full = query.name?.startsWith('deft_registry_full_');
      if (full && state.beforeFull) { const change = state.beforeFull; state.beforeFull = undefined; change(); }
      const rows = Array.from({ length: state.aliasRows }, (_, index) =>
        Array.from({ length: state.proofRows }, () => nativeRow(index + 1))).flat().map(row => structuredClone(row));
      if (state.alternateVersion && rows[1]) {
        rows[1][3] = registrationId.replace(/.$/u, registrationId.endsWith('a') ? 'b' : 'a'); rows[1][4] = state.alternateVersion;
        (rows[1][7] as Row).registration_id = rows[1][3]; (rows[1][9] as Row).version_id = state.alternateVersion;
      }
      if (full) state.rawFull = rows;
      return { rows: full ? rows : rows.map(row => row.slice(0, 7)) };
    }
    assert.match(text, /from "app_runtime_bindings"/u);
    return { rows: state.actions.map(row => fields(appRuntimeBindings, row)) };
  } } as never);
  const root = { org_id: org, installation_id: installation, runtime_registration_id: sourceRegistration, runtime_epoch: 1, profile, connection_protocol: 'v2', endpoint: 'https://runtime.example.test/v1/connections',
    runtime_auth_token: 'a'.repeat(43), authority_token_sha256: hash };
  return { calls, current, proof, alias, state, action, root, run: (entries = [root]) => trustedUpgradeRegistryEntries(entries as never, tx as never) };
}

test('cold probe/full snapshot and warm content probe retain one complete fresh action-pin query', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.length, 1); assert.equal(result[0]!.runtime_registration_id, f.alias.registration_id); assert.equal(f.calls.length, 3);
  const query = f.calls[1]!.text;
  assert.match(query, /left join lateral/u); assert.ok(f.calls[1]!.values.includes(257) && f.calls[1]!.values.includes(2));
  assert.match(query, /count\(\*\) over/u); assert.match(query, /"alias_total" <= 256/u);
  for (const table of ['app_installations', 'registry_prior_version', 'registry_target_version', 'app_connection_sessions',
    'app_resource_bindings', 'app_runtime_registrations', 'app_owner_connection_admissions', 'registry_successor_binding', 'registry_successor_registration'])
    assert.match(query, new RegExp('"' + table + '"\\."org_id" = "registry_aliases"\\."org_id"', 'u'));
  const select = query.split(' from ')[0]!;
  assert.ok(!select.includes('"package"'));
  for (const [table, fields] of [['registry_successor_binding', successorBindingFields], ['registry_successor_registration', successorRegistrationFields]] as const) {
    const selected = [...select.matchAll(new RegExp('"' + table + '"\\."([^"]+)"', 'gu'))].map(match => match[1]);
    assert.deepEqual(selected, [...fields, ...fields], 'hash and typed successor selection use exactly the validator inputs');
  }
  assert.match(f.calls[2]!.text, /"app_runtime_bindings"\."org_id" = \$/u);
  assert.deepEqual(f.calls.slice(0, 2).map(call => call.name), ['deft_registry_probe_v2_o1', 'deft_registry_full_v2_o1']);
  const probeSelect = f.calls[0]!.text.split(' from ')[0]!;
  assert.match(probeSelect, /sha256\(convert_to\(/u); assert.match(probeSelect, /to_jsonb\("app_resource_bindings"\)/u);
  assert.doesNotMatch(probeSelect, /to_jsonb\("registry_(?:prior|target)_version"\)/u);
  assert.doesNotMatch(probeSelect, /"package"/u);
  assert.match(probeSelect, /to_jsonb\(ROW\(/u);
  for (const [table, fields] of [['app_installations', installationFields], ['app_connection_sessions', sourceFields]] as const) {
    const selected = [...select.matchAll(new RegExp('"' + table + '"\\."([^"]+)"', 'gu'))].map(match => match[1]);
    assert.deepEqual(selected, [...fields, ...fields], 'hash and typed facts include only the consumed columns');
  }
  await f.run(); assert.equal(f.calls.length, 5, 'no current alias, membership or row-set authority is cached');
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


test('narrow successor Date selection preserves exact finite consent and still rejects expiry drift', async () => {
  const f = fixture();
  for (const scope of [f.proof.source_scope, f.current.source.record.scope]) {
    scope.consent_expires_at = expires; delete scope.consent_lifetime;
  }
  f.current.successor_binding.consent_expires_at = new Date(expires);
  f.current.successor_binding.consent_lifetime = null;
  assert.equal((await f.run()).length, 1);
  f.current.successor_binding.consent_expires_at = new Date(Date.parse(expires) + 1);
  assert.deepEqual(await f.run(), []);
});


test('a cold miss discards probe A and validates, nominates and seeds only complete full B', async () => {
  const f = fixture(), originalManifest = structuredClone(f.current.target.manifest), originalPin = structuredClone(f.proof.source_actions[0]!);
  const originalAction = f.action;
  const nextAction = { ...originalAction, id: randomUUID() };
  f.state.beforeFull = () => {
    f.current.target.manifest.version = '1.0.2';
    f.proof.source_actions = [{ id: nextAction.id, digest: rowDigest(nextAction) }]; f.state.actions = [nextAction];
  };
  assert.equal((await f.run()).length, 1);
  assert.ok(f.calls[2]!.values.includes(nextAction.id)); assert.ok(!f.calls[2]!.values.includes(originalPin.id));
  const afterCold = f.calls.length; await f.run(); assert.equal(f.calls.length - afterCold, 2, 'B seeds only its own fingerprint');
  f.current.target.manifest = originalManifest; f.proof.source_actions = [originalPin]; f.state.actions = [originalAction];
  const beforeA = f.calls.length; assert.equal((await f.run()).length, 1);
  assert.equal(f.calls.length - beforeA, 3, 'A was never seeded with B facts');
});

test('B zero aliases, overflow, malformed proof and duplicate proof replace all A nomination facts', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.aliasRows = 0; },
    (f: ReturnType<typeof fixture>) => { f.state.aliasTotal = 257; },
    (f: ReturnType<typeof fixture>) => { f.state.proofRows = 2; },
    (f: ReturnType<typeof fixture>) => { f.proof.request_id = randomUUID(); }]) {
    const f = fixture(); f.state.beforeFull = () => change(f); assert.deepEqual(await f.run(), []);
    assert.equal(f.calls.filter(call => call.text.includes('from "app_runtime_bindings"')).length, 0);
  }
});

test('warm exact bytes still recheck source expiry, fresh action pins and current deployment roots', async () => {
  const f = fixture();
  for (const scope of [f.proof.source_scope, f.current.source.record.scope]) { scope.consent_expires_at = expires; delete scope.consent_lifetime; }
  f.current.successor_binding.consent_expires_at = new Date(expires); f.current.successor_binding.consent_lifetime = null;
  await f.run(); const before = f.calls.length;
  const now = mock.method(Date, 'now', () => Date.parse(expires) + 1);
  try { assert.deepEqual(await f.run(), []); } finally { now.mock.restore(); }
  assert.equal(f.calls.length - before, 2, 'expiry denied on warm content without a full re-read');
  const g = fixture(); await g.run(); g.action.updated_at = new Date(0); assert.deepEqual(await g.run(), []);
  const h = fixture(); await h.run(); h.root.profile.operator_user_id = randomUUID(); assert.deepEqual(await h.run(), []);
  for (const field of ['runtime_auth_token', 'endpoint', 'authority_token_sha256'] as const) {
    const rotated = fixture(); await rotated.run(); const count = rotated.calls.length;
    rotated.root[field] += 'changed'; assert.deepEqual(await rotated.run(), []);
    assert.equal(rotated.calls.length - count, 2, 'warm facts must still match the current transport root');
  }
});

test('cached facts own decoded full trees, and mutable driver-returned JSON cannot poison later hits', async () => {
  const f = fixture(); await f.run(); const before = f.calls.length;
  const recordIndex = 10 + installationFields.length + 4 + sourceFields.indexOf('record');
  (f.state.rawFull[0]![recordIndex] as Row).scope.owner_user_id = randomUUID();
  assert.equal((await f.run()).length, 1); assert.equal(f.calls.length - before, 2);
});

test('malformed fingerprints and multiple orgs or target versions bypass content reuse', async () => {
  const f = fixture(); f.state.fingerprint = 'advertised-package-digest'; await f.run(); const before = f.calls.length; await f.run();
  assert.equal(f.calls.length - before, 3);
  const g = fixture(), entries = [g.root, { ...g.root, org_id: randomUUID() }];
  await g.run(entries); const beforeMulti = g.calls.length; await g.run(entries);
  assert.equal(g.calls.length - beforeMulti, 2); assert.ok(g.calls.every(call => !call.name?.includes('_probe_')));
  const h = fixture(); h.state.aliasRows = 2; h.state.aliasTotal = 2; h.state.alternateVersion = randomUUID();
  await h.run(); const beforeVersions = h.calls.length; await h.run();
  assert.equal(h.calls.length - beforeVersions, 3, 'multiple target versions never reuse decoded facts');
});


test('warm caches cannot hide alias/proof removal, duplicate insertion, overflow or new source pins', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.aliasRows = 0; },
    (f: ReturnType<typeof fixture>) => { f.state.aliasRows = 2; f.state.aliasTotal = 2; },
    (f: ReturnType<typeof fixture>) => { f.state.proofRows = 2; },
    (f: ReturnType<typeof fixture>) => { f.state.proofPresent = false; },
    (f: ReturnType<typeof fixture>) => { f.state.aliasTotal = 257; },
    (f: ReturnType<typeof fixture>) => { f.proof.source_actions.push({ id: randomUUID(), digest: hash }); }]) {
    const f = fixture(); assert.equal((await f.run()).length, 1); change(f); assert.deepEqual(await f.run(), []);
  }
});

test('prepared handles use current transaction clients and stable per-mode/org-count SQL shapes', async () => {
  const a = fixture(), b = fixture(); await a.run(); await b.run();
  for (const index of [0, 1]) {
    assert.equal(a.calls[index]!.text, b.calls[index]!.text);
    assert.equal(a.calls[index]!.name, b.calls[index]!.name);
    assert.notDeepEqual(a.calls[index]!.values, b.calls[index]!.values, 'current org values are parameters');
  }
  const c = fixture(); await c.run([c.root, { ...c.root, org_id: randomUUID() }]);
  assert.equal(c.calls[0]!.name, 'deft_registry_full_v2_o2');
  assert.notEqual(c.calls[0]!.text, a.calls[1]!.text);
});


test('fresh actual manifest bytes invalidate decoding and semantic validation under unchanged advertised pins', async () => {
  const f = fixture(); assert.equal((await f.run()).length, 1); const advertised = f.proof.source_scope.package_digest;
  const first = f.calls.length; f.current.target.manifest.version = '1.0.2';
  assert.equal((await f.run()).length, 1); assert.equal(f.calls.length - first, 3, 'same version ID with new content reloads full B');
  assert.equal(f.proof.source_scope.package_digest, advertised);
  const warm = f.calls.length; assert.equal((await f.run()).length, 1); assert.equal(f.calls.length - warm, 2);
  f.current.target.manifest.future_authority = true; assert.deepEqual(await f.run(), []);
  assert.equal(f.proof.source_scope.package_digest, advertised, 'advertised package pins cannot hide unknown authority bytes');
});

test('unconsumed installation and session columns are outside the decoding fingerprint', async () => {
  const f = fixture(); await f.run(); const before = f.calls.length;
  f.current.installation.updated_at = new Date(0); f.current.source.web_session_id = randomUUID();
  assert.equal((await f.run()).length, 1); assert.equal(f.calls.length - before, 2);
});
