import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, access, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _setPausedStartForTest, PausedStartError, pausedGuardedFetch } from '../src/lib/paused-start.js';
import { AppDataService } from '../src/lib/app-data-service.js';
import { createAppIntegrationDataGateway } from '../src/lib/app-integration-data-gateway.js';
import { decorateAppIntegrationKnowledgeCitations } from '../src/lib/app-integration-knowledge-citations.js';
import { loadAppConnectionRegistry } from '../src/lib/app-connection-registry.js';

afterEach(() => _setPausedStartForTest(false));
after(async () => { const { closeDb } = await import('../src/lib/db.js'); await closeDb(); });

test('paused App data invocation stops before authority lookup and journal creation', async () => {
  let current = 0;
  const service = new AppDataService({ org_id: randomUUID(), user_id: randomUUID() }, async () => {});
  service.current = async () => { current++; throw new Error('authority reached before pause'); };
  _setPausedStartForTest(true);
  await assert.rejects(service.invoke(randomUUID(), { schema_version: 'deft.app_data_request.v1',
    request_id: randomUUID(), operation: 'connection_metadata', input: { store_key: 'records' } }), PausedStartError);
  assert.equal(current, 0);
});

test('paused integration reads never begin or finish an invocation journal, including restored inflight requests', async () => {
  const org = randomUUID(), owner = randomUUID(), hash = `sha256:${'a'.repeat(64)}`, expires = Date.now() + 60_000;
  const caller = { org_id: org, user_id: owner, kind: 'human' as const, principal_id: owner, access_expires_at: expires };
  const scope = { org_id: org, owner_user_id: owner, installation_id: randomUUID(), app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), package_digest: hash, grant_snapshot_digest: hash, lifecycle_epoch: 1, grant_epoch: 1,
    target_key: 'primary', resource_key: 'records', resource_binding_id: randomUUID(), runtime_registration_id: randomUUID(),
    operator_user_id: owner, runtime_epoch: 1, profile_digest: hash, consent_expires_at: new Date(expires).toISOString() };
  const account = { identity: 'principal', expires_at: expires, resource_binding_id: scope.resource_binding_id,
    resource_key: 'records', scope, connection: { session_id: randomUUID(), session_revision: 1,
      runtime_session_ref: 'runtime', account_ref: 'account' }, authority: { consent_id: null, consent_digest: null, data_policy_digest: hash }, profile: {} };
  const recordId = randomUUID();
  const target = { installation_id: scope.installation_id, resource_binding_id: scope.resource_binding_id,
    account_ref: 'account', store_key: 'records', ref: { resource_key: 'records', record_id: recordId, content_digest: hash } };
  const input = { store_key: 'records', resource_key: 'records', record_id: recordId, content_digest: hash };
  const writes: string[] = [];
  let row: any;
  const gateway = createAppIntegrationDataGateway({ account: async () => account,
    journal: { begin: async value => { writes.push('begin'); row = value; return true; },
      read: async () => row, finish: async (_id, state) => { writes.push(state); } },
    authenticate: async () => {}, transport: async () => { await pausedGuardedFetch('https://example.invalid'); return {}; } });
  const restored = await gateway.mint(caller, target, 'read', 'resource_read_presentation', input);
  assert.deepEqual(writes, ['begin'], 'normal operation still creates its journal');
  writes.length = 0;
  _setPausedStartForTest(true);
  await assert.rejects(gateway.mint(caller, target, 'read', 'resource_read_presentation', input), PausedStartError);
  await assert.rejects(gateway.dispatch(restored), PausedStartError);
  assert.deepEqual(writes, [], 'pause must not leave new indeterminate invocations or alter restored ones');
});

test('paused wiki citations keep stored excerpts but skip live source checks and links', async () => {
  const caller = { org_id: randomUUID(), user_id: randomUUID(), kind: 'human' as const, principal_id: randomUUID(), access_expires_at: Date.now() + 60_000 };
  const citation = { source_type: 'app_integration', source_id: randomUUID(), excerpt: 'Stored excerpt' };
  let reads = 0;
  const options = { caller, citations: [citation], records: [{ id: citation.source_id, org_id: caller.org_id, owner_user_id: caller.user_id, target: {} }],
    read: async () => { reads++; } };
  _setPausedStartForTest(true);
  const [result] = await decorateAppIntegrationKnowledgeCitations(options);
  assert.equal(reads, 0);
  assert.equal(result?.excerpt, citation.excerpt);
  assert.equal(result?.source_url, null);
  _setPausedStartForTest(false);
  await decorateAppIntegrationKnowledgeCitations(options);
  assert.equal(reads, 1, 'normal reads still check current source access');
});

test('paused registry loading never initializes a configured adapter factory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deft-paused-adapter-'));
  const modulePath = join(directory, 'adapter.mjs'), configPath = join(directory, 'config.json'), marker = join(directory, 'initialized');
  const source = `import {writeFile} from 'node:fs/promises'; export async function createAppConnectionAdapter({options}) {
    await writeFile(options.marker, 'factory initialized'); return {handle: async () => ({})}; }`;
  try {
    await writeFile(modulePath, source, { mode: 0o600 });
    const pins = { org_id: randomUUID(), owner_user_id: randomUUID(), installation_id: randomUUID(), app_version_id: randomUUID(),
      grant_snapshot_id: randomUUID(), target_key: 'primary', resource_key: 'records', resource_binding_id: randomUUID(), action_key: null, action_binding_id: null };
    await writeFile(configPath, JSON.stringify({ schema_version: 'deft.app_connection_adapters.v1', entries: [{ pins,
      module_path: modulePath, module_sha256: createHash('sha256').update(source).digest('hex'), options: { marker } }] }), { mode: 0o600 });
    _setPausedStartForTest(true);
    await assert.rejects(loadAppConnectionRegistry(configPath), PausedStartError);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    _setPausedStartForTest(false);
    await loadAppConnectionRegistry(configPath);
    await access(marker);
  } finally {
    for (const file of [marker, configPath, modulePath]) await unlink(file).catch(() => {});
    await rmdir(directory);
  }
});
