import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { appResourceBindings, appRuntimeRegistrations } from '@deft/db/schema';

const hash = 'sha256:' + 'a'.repeat(64), org = randomUUID(), installation = randomUUID();
const owner = randomUUID(), operator = randomUUID(), version = randomUUID(), grant = randomUUID();
const priorRegistration = randomUUID(), registrationId = randomUUID(), bindingId = randomUUID(), proofId = randomUUID();
let revoked = false, proofChecks = 0;
const proof = { org_id: org, installation_id: installation, version_id: version, grant_id: grant,
  owner_id: owner, operator_id: operator, transport_digest: hash, connection_protocol: 'v2',
  source_scope: { runtime_registration_id: priorRegistration, runtime_epoch: 1, profile_digest: hash,
    consent_expires_at: null, consent_lifetime: 'until_revoked' } };
mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { db: {} } });
mock.module(new URL('../src/lib/app-upgrade-trust-continuity.ts', import.meta.url).href, { namedExports: {
  UPGRADE_ALIAS_ACTION: 'app.upgrade_registration',
  readContinuityProof: async (_tx: unknown, actualOrg: string, id: string) => {
    assert.equal(actualOrg, org); assert.equal(id, proofId); return proof;
  },
  assertContinuityProof: async () => { proofChecks++; if (revoked) throw Error('REVOKED'); },
} });
mock.module(new URL('../src/lib/app-connection-session-registry.ts', import.meta.url).href, { namedExports: {
  AppConnectionSessionRegistryConfigSchema: {}, connectionProfileDigest: () => hash, connectionTransportEntryDigest: () => hash,
} });
const { trustedUpgradeRegistryEntries } = await import('../src/lib/app-upgrade-trust-registry.js');

function fixture() {
  revoked = false; proofChecks = 0;
  const alias = { schema_version: 'deft.app_upgrade_registration.v1', proof_id: proofId, org_id: org,
    installation_id: installation, registration_id: registrationId, binding_id: bindingId, runtime_epoch: 2,
    source_registration_id: priorRegistration, source_runtime_epoch: 1, profile_digest: hash, transport_digest: hash };
  const binding: Record<string, unknown> = { id: bindingId, org_id: org, state: 'active', app_installation_id: installation,
    app_version_id: version, grant_snapshot_id: grant, runtime_registration_id: registrationId,
    owner_user_id: owner, consent_expires_at: null, consent_lifetime: 'until_revoked' };
  const registration: Record<string, unknown> = { id: registrationId, org_id: org, state: 'active',
    app_version_id: version, grant_snapshot_id: grant, runtime_epoch: 2, operator_user_id: operator };
  const calls: { text: string; values: unknown[] }[] = [];
  const tx = drizzle({ query: async (query: any, values: unknown[]) => {
    const text = typeof query === 'string' ? query : query.text; calls.push({ text, values });
    if (text.includes('from "audit_log"')) return { rows: [[alias]] };
    assert.ok(text.includes('left join "app_runtime_registrations"'));
    assert.ok(values.includes(org) && values.includes(bindingId) && values.includes(registrationId));
    if (binding.org_id !== org || binding.id !== bindingId || registration.org_id !== org || registration.id !== registrationId) return { rows: [] };
    return { rows: [[...Object.values(getTableColumns(appResourceBindings)).map(column => binding[column.name] ?? null),
      ...Object.values(getTableColumns(appRuntimeRegistrations)).map(column => registration[column.name] ?? null)]] };
  } } as never);
  const root = { org_id: org, installation_id: installation, runtime_registration_id: priorRegistration,
    runtime_epoch: 1, profile: { operator_user_id: operator }, connection_protocol: 'v2' };
  return { calls, binding, registration, run: () => trustedUpgradeRegistryEntries([root] as never, tx as never) };
}

test('current successor reads binding and registration in one typed, independently scoped query', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.length, 1); assert.equal(result[0]!.runtime_registration_id, registrationId);
  assert.equal(proofChecks, 1); assert.equal(f.calls.length, 2);
  const query = f.calls[1]!.text;
  for (const table of ['app_resource_bindings', 'app_runtime_registrations']) {
    for (const field of ['org_id', 'id']) assert.match(query, new RegExp('"' + table + '"\\."' + field + '" = \\$\\d+', 'u'));
  }
});

test('successor reuse never hides current revocation, cross-org rows or runtime epoch drift', async () => {
  const f = fixture(); assert.equal((await f.run()).length, 1);
  revoked = true; assert.deepEqual(await f.run(), []); assert.equal(proofChecks, 2);
  revoked = false; f.registration.runtime_epoch = 3; assert.deepEqual(await f.run(), []);
  f.registration.runtime_epoch = 2; f.binding.org_id = randomUUID(); assert.deepEqual(await f.run(), []);
  f.binding.org_id = org; f.registration.org_id = randomUUID(); assert.deepEqual(await f.run(), []);
});
