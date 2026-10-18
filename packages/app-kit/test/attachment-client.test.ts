import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeftResourceSyncClientV3, type ResourceSyncClaimV3 } from '../src/resource-sync-client-v3.js';
import { AttachmentStageHeaderSchema } from '../src/resource-sync-attachments.js';
import { ResourceSyncClaimSchema } from '../src/resource-sync-client.js';

const credential = { session_id: crypto.randomUUID(), session_token: 's'.repeat(43) };
const claim: ResourceSyncClaimV3 = { schema_version: 'deft.app_runtime_channel.v3', audience: 'app_resource_sync',
  work_kind: 'sync_page', org_id: crypto.randomUUID(), app_installation_id: crypto.randomUUID(), app_version_id: crypto.randomUUID(),
  grant_snapshot_id: crypto.randomUUID(), lifecycle_epoch: 1, grant_epoch: 1, runtime_registration_id: crypto.randomUUID(),
  resource_binding_id: crypto.randomUUID(), runtime_epoch: 1, session_id: credential.session_id, session_epoch: 1,
  run_id: crypto.randomUUID(), attempt_id: crypto.randomUUID(), attempt_number: 1, claim_token: crypto.randomUUID(), sequence: 7,
  lease_expires_at: '2037-01-01T00:00:00Z', descriptor_digest: `sha256:${'1'.repeat(64)}` };
const metadata = { parent_resource_id: 'mail:1', parent_revision: '1', attachment_key: 'part:1',
  filename: '☃.csv', declared_media_type: 'text/csv' as const };
const outer = { schema_version: 'deft.app_runtime_channel.v3', audience: 'app_resource_sync', work_kind: 'sync_page' };

test('channel3 sends bounded exact binary framing and permits heartbeat while one per-Run stage is held', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let observed!: () => void; const entered = new Promise<void>(resolve => { observed = resolve; });
  const stagingId = crypto.randomUUID(); const bytes = new Uint8Array([1, 2, 255]);
  let stageCalls = 0;
  const client = createDeftResourceSyncClientV3({ channel_url: 'http://127.0.0.1:4444/api/sync/v3', credential,
    fetch: async (url, init) => {
      assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
      assert.equal((init?.headers as Record<string, string>).authorization, `AppRuntime ${credential.session_token}`);
      if (String(url).endsWith('/heartbeat')) return Response.json({ ...outer, run_id: claim.run_id,
        attempt_id: claim.attempt_id, sequence: 7, renewed: true, lease_expires_at: '2037-01-01T00:01:00Z' });
      stageCalls++;
      assert.equal((init?.headers as Record<string, string>)['content-type'], 'application/vnd.deft.sync-attachment.v1');
      const frame = new Uint8Array(init?.body as ArrayBuffer);
      const length = new DataView(frame.buffer).getUint32(0, false);
      const header = AttachmentStageHeaderSchema.parse(JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + length))));
      assert.equal(header.sequence, 7); assert.equal(header.claim_token, claim.claim_token);
      assert.equal(Object.hasOwn(header, 'session_token'), false);
      assert.deepEqual(frame.subarray(4 + length), bytes);
      observed(); await held;
      return Response.json({ schema_version: 'deft.app_sync_attachment_staged.v1', staging_id: stagingId, state: 'ready', size_bytes: 3 });
    } });
  const pending = client.stageAttachment(claim, metadata, bytes); await entered;
  await assert.rejects(client.stageAttachment(claim, { ...metadata, attachment_key: 'part:2' }, bytes), /Serialize/);
  assert.equal(await client.heartbeat(claim), '2037-01-01T00:01:00Z');
  release(); assert.equal((await pending).staging_id, stagingId); assert.equal(stageCalls, 1);
  assert.throws(() => ResourceSyncClaimSchema.parse(claim));
});

test('channel3 rejects wrong session, oversized bytes and substituted acknowledgment without automatic retry', async () => {
  let calls = 0;
  const client = createDeftResourceSyncClientV3({ channel_url: 'http://127.0.0.1:4444/api/sync/v3', credential,
    fetch: async () => { calls++; return Response.json({ schema_version: 'deft.app_sync_attachment_staged.v1',
      staging_id: crypto.randomUUID(), state: 'ready', size_bytes: 4 }); } });
  await assert.rejects(client.stageAttachment({ ...claim, session_id: crypto.randomUUID() }, metadata, new Uint8Array(3)));
  await assert.rejects(client.stageAttachment(claim, metadata, new Uint8Array(2_097_153)));
  assert.equal(calls, 0);
  await assert.rejects(client.stageAttachment(claim, metadata, new Uint8Array(3)));
  assert.equal(calls, 1);
});
