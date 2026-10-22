import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { parseAttachmentAppManifest, digestResourceSyncDescriptorV2, canonicalAppConnectionProfileJson } from '@deft/app-kit/core';
import { digestAppGrantValue } from '../src/lib/app-grant-service.js';

let registryReads = 0, profileChanged = false, transportChanged = false;
const org_id = randomUUID(), installation_id = randomUUID(), operator_user_id = randomUUID();
const policy = { key: 'personal_mailbox', resource_key: 'inbox', action_keys: ['send_message'], max_consent_seconds: 86400,
  provider_profile_key: 'example_provider', runtime_requirement_key: 'sync_provider' };
const profile = { schema_version: 'deft.app_connection_profile.v1' as const, key: 'example_provider', provider_id: 'example_provider',
  operator_user_id, runtime_requirement_key: 'sync_provider', resource_key: 'inbox', action_keys: ['send_message'],
  authorization_origin: 'https://provider.example.test', credential_custody: 'runtime' as const, executable: false as const };
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const registry = { profile: () => profileChanged ? { ...profile, provider_id: 'changed' } : profile,
  transportDigest: () => digest(transportChanged ? 'd' : 'c') };
const connectionProfileDigest = (value: any) => `sha256:${createHash('sha256').update(canonicalAppConnectionProfileJson(value)).digest('hex')}`;
const actions = [{ action_key: 'send_message', contract_digest: digest('e') }];
mock.module(new URL('../src/lib/env.ts', import.meta.url).href, { namedExports: { isAppOwnerConnectionsEnabled: () => true } });
mock.module(new URL('../src/lib/app-attachment-authority.ts', import.meta.url).href, { namedExports: {
  loadReviewedAttachmentApp: async () => { throw new Error('the already locked review must be used'); },
} });
mock.module(new URL('../src/lib/app-runtime-review.ts', import.meta.url).href, { namedExports: { runtimeActionDescriptors: () => actions } });
mock.module(new URL('../src/lib/app-connection-session-registry.ts', import.meta.url).href, { namedExports: {
  connectionProfileDigest, getAppConnectionSessionRegistry: async () => { registryReads++; return registry; },
} });
const { loadOwnerConnectionAdmission } = await import('../src/lib/app-owner-connection-authority.js');

const manifest = JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json', import.meta.url), 'utf8'));
manifest.owner_connections = [policy];
const parsed = parseAttachmentAppManifest(manifest);
const installation = { id: installation_id, org_id, state: 'active', active_version_id: randomUUID(), active_grant_snapshot_id: randomUUID(), lifecycle_epoch: 1, grant_epoch: 2 };
const version = { id: installation.active_version_id, org_id, installation_id, state: 'active', protocol_version: '7', manifest, package_digest: digest('a') };
const grant = { id: installation.active_grant_snapshot_id, org_id, app_installation_id: installation_id, app_version_id: version.id, snapshot_kind: 'effective', snapshot_digest: digest('b') };
const snapshot = { schema_version: 'deft.owner_connection_admission.v1', org_id, installation_id, app_version_id: version.id,
  grant_snapshot_id: grant.id, package_digest: version.package_digest, grant_snapshot_digest: grant.snapshot_digest,
  lifecycle_epoch: 1, grant_epoch: 2, operator_user_id, policy, policy_digest: digestAppGrantValue(policy),
  resource_descriptor_digest: await digestResourceSyncDescriptorV2(parsed.sync_descriptors[0]!),
  actions,
  limits: { max_records_per_page: 50, max_page_bytes: 100000, max_retained_records: 1000, max_retained_bytes: 1000000, min_interval_seconds: 300 },
  connection_profile: profile, connection_profile_digest: connectionProfileDigest(profile), connection_transport_digest: digest('c') };
const row = { id: randomUUID(), org_id, app_installation_id: installation_id, app_version_id: version.id,
  grant_snapshot_id: grant.id, review_digest: digestAppGrantValue(snapshot), policy_key: policy.key, operator_user_id, state: 'active', revoked_at: null, snapshot };
let memberActive = true;
function query(rows: unknown[]) { const value: any = { then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
  for (const method of ['from', 'where', 'limit', 'for', 'innerJoin']) value[method] = () => value; return value; }
const tx = { select: (projection?: unknown) => query(projection ? [{ user_id: operator_user_id, active: memberActive, role: 'member', kind: 'human', is_agent: false }] : [row]) };
const reference = { admission_id: row.id, admission_digest: row.review_digest };
const read = (onRegistry?: (value: unknown) => void) => loadOwnerConnectionAdmission(tx as never, org_id, reference,
  { installation, version, grant } as never, operator_user_id, onRegistry);

test('one admission transaction shares its validated deployment registry without caching later checks', async () => {
  registryReads = 0;
  let captured: unknown;
  await read(value => { captured = value; });
  assert.equal(registryReads, 1, 'profile and transport must use one current, validated registry acquisition');
  assert.strictEqual(captured, registry);
  await read(); assert.equal(registryReads, 2, 'the next authority phase must acquire fresh configuration and proofs');
  for (const mutate of [() => { profileChanged = true; }, () => { transportChanged = true; },
    () => { memberActive = false; }, () => { row.revoked_at = new Date() as never; },
    () => { installation.grant_epoch++; }]) {
    profileChanged = false; transportChanged = false; memberActive = true; row.revoked_at = null; installation.grant_epoch = 2;
    mutate(); let disclosed = false;
    await assert.rejects(read(() => { disclosed = true; }));
    assert.equal(disclosed, false, 'a failed current check cannot publish its registry');
  }
});
