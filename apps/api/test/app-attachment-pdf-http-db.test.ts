import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AttachmentPolicySchema, AttachmentStageHeaderSchema, buildDeftAppPackage, frameResourceSyncAttachment,
  parseSyncPageV2, RESOURCE_ATTACHMENT_LIMITS, SyncDescriptorV2Schema } from '@deft/app-kit';
import { appAttachmentMediaAllowed } from '../src/lib/app-attachment-media.js';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';

const pdf = readFileSync(new URL('../../../examples/apps/email/fixtures/launch-stage0/synthetic-brief.pdf', import.meta.url));
const pdfDigest = '7dcd3e988227137bbea91d996b903482a80f1f49ca3fdebd5ad6db9242b6669f';
const policy = { max_attachment_bytes: 8192, max_attachments_per_record: 2, max_attachments_per_run: 4,
  max_attachment_bytes_per_run: 32768, retention_days: 1, allowed_media_types: ['text/csv', 'application/pdf'] as const };

test('PDF contract is explicit reviewed bounded download media and classification is limited to signature/trailer', () => {
  assert.equal(createHash('sha256').update(pdf).digest('hex'), pdfDigest);
  assert.equal(appAttachmentMediaAllowed(pdf, 'application/pdf'), true);
  assert.equal(appAttachmentMediaAllowed(pdf, 'text/csv'), false);
  for (const bytes of [Buffer.from('not a PDF'), pdf.subarray(0, pdf.length - 10),
    Buffer.concat([Buffer.from('<html>'), pdf]), Buffer.concat([pdf, Buffer.from('<script>active suffix</script>')]),
    Buffer.from('%PDF-1.7\nstartxref\n9999999999\n%%EOF\n')]) {
    assert.equal(appAttachmentMediaAllowed(bytes, 'application/pdf'), false);
  }
  const oversized = Buffer.alloc(RESOURCE_ATTACHMENT_LIMITS.attachment_bytes + 1);
  pdf.copy(oversized);pdf.subarray(-100).copy(oversized, oversized.length - 100);
  assert.equal(appAttachmentMediaAllowed(oversized, 'application/pdf'), false);
  assert.deepEqual(AttachmentPolicySchema.parse(policy).allowed_media_types, policy.allowed_media_types);
  assert.equal(AttachmentPolicySchema.parse({ ...policy, allowed_media_types: ['text/plain', 'text/csv', 'application/json',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'] }).allowed_media_types.length, 8);
  assert.throws(() => AttachmentPolicySchema.parse({ ...policy, allowed_media_types: ['application/pdf', 'application/pdf'] }));
  assert.throws(() => AttachmentPolicySchema.parse({ ...policy, allowed_media_types: ['text/html'] }));
  const descriptor = SyncDescriptorV2Schema.parse({ schema_version: 'deft.app_sync_descriptor.v2', key: 'inbox',
    runtime_requirement_key: 'sync', resource_type: 'private_record', requested_visibility: 'user_private', label_field: 'subject',
    record_schema: { type: 'object', properties: { subject: { type: 'string', maxLength: 200 } }, required: ['subject'], additionalProperties: false }, attachments: policy });
  const request = { schema_version: 'deft.app_sync_request.v2', cursor: null, max_items: 1, attachments: policy };
  const page = { schema_version: 'deft.app_sync_page.v2', upserts: [], tombstones: [], next_cursor: null, has_more: false };
  assert.deepEqual(parseSyncPageV2(descriptor, request, page), page);
  assert.throws(() => parseSyncPageV2({ ...descriptor, attachments: { ...policy, allowed_media_types: ['text/csv'] } }, request, page),
    'Adding PDF to the contract does not widen an existing descriptor or consent');
  const header = { schema_version: 'deft.app_sync_attachment_stage.v1', channel_version: 'deft.app_runtime_channel.v3', audience: 'app_resource_sync',
    session_id: randomUUID(), run_id: randomUUID(), attempt_id: randomUUID(), claim_token: randomUUID(), sequence: 1,
    parent_resource_id: 'synthetic-message', parent_revision: '1', attachment_key: 'pdf-1', filename: 'synthetic-brief.pdf',
    declared_media_type: 'application/pdf', declared_size_bytes: pdf.byteLength };
  assert.deepEqual(AttachmentStageHeaderSchema.parse(header), header);
  assert.throws(() => AttachmentStageHeaderSchema.parse({ ...header, declared_size_bytes: oversized.length }));
});

test('current HTTP quarantine links PDF bytes only to an exact owner/target/parent and serves download-only', { timeout: 120_000 }, async t => {
  assert.ok(securityTestDatabaseIsSafe(), 'Set matching DATABASE_URL and DEFT_TEST_DATABASE_URL to the guarded disposable database');
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
    DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`private-state-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1', run_encryption: ring('private-enc'),
    receipt_signing: ring('private-sign'), fingerprint: ring('private-fp') });
  const [{ db, closeDb }, s, { and, eq }, web, runtime, attachments, blob, channel, { Hono }, { serve }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js'), import('../src/routes/app-attachments.js'),
    import('../src/routes/app-attachment-sync-channel.js'), import('hono'), import('@hono/node-server'),
  ]);
  const app = new Hono();app.route('/api/apps/blob', blob.appAttachmentRoutes);
  app.route('/api/private-resources', blob.appAttachmentOwnerRoutes);app.route('/api/app-resource-sync-channel/v3', channel.appAttachmentSyncChannelRoutes);
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, address => resolve(`http://127.0.0.1:${address.port}`)); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve()));await attachments.shutdownAppAttachmentRuntime();await runtime.shutdownAppRunRuntime();await closeDb(); });
  const org = randomUUID(), owner = randomUUID(), other = randomUUID(), suffix = randomUUID().replaceAll('-', '');
  await db.insert(s.orgs).values({ id: org, name: 'Synthetic PDF fixture', slug: `pdf-${suffix}` });
  await db.insert(s.users).values([{ id: owner, name: 'PDF owner', email: `pdf-owner-${suffix}@example.test` },
    { id: other, name: 'Other PDF owner', email: `pdf-other-${suffix}@example.test` }]);
  await db.insert(s.orgMembers).values([{ id: randomUUID(), org_id: org, user_id: owner, role: 'owner', is_active: true },
    { id: randomUUID(), org_id: org, user_id: other, role: 'admin', is_active: true }]);
  const ownerSession = await web.createWebSession({ id: owner, org_id: org, email: `pdf-owner-${suffix}@example.test` });
  const otherSession = await web.createWebSession({ id: other, org_id: org, email: `pdf-other-${suffix}@example.test` });
  const request = async (path: string, method = 'GET', body?: unknown, token = ownerSession.accessToken, scheme = 'Bearer') => {
    const response = await fetch(base + path, { method, headers: { authorization: `${scheme} ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (...args: Parameters<typeof request>) => { const result = await request(...args);assert.ok(result.status >= 200 && result.status < 300, `${args[0]}: ${JSON.stringify(result)}`);return result.body; };
  const fixture = JSON.parse((await runtimeSecurityPackage()).json);fixture.manifest.id = `community.example.pdf.a${suffix}`;
  fixture.manifest.sync_descriptors[0].attachments = policy;
  const packed = (await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts })).json;
  const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', packed);
  const context = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
  const { review } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', context.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...context.review_request, expected_review_digest: review.review_digest, accept_host_policy: true });
  const consent = async (targetKey: string, mediaTypes: readonly string[]) => {
    const { setup } = await call(`/api/apps/blob/sync/setup?installation_id=${installed.id}&operator_user_id=${owner}`);
    const input = { ...setup.descriptors[0].consent_request, target_key: targetKey, attachment_policy: { ...policy, allowed_media_types: mediaTypes } };
    const { review } = await call('/api/apps/blob/sync/reviews/prepare', 'POST', input);
    return (await call('/api/apps/blob/sync/bindings/activate', 'POST', { ...input, expected_review_digest: review.review_digest, accept_host_policy: true })).binding;
  };
  const personal = await consent('personal', policy.allowed_media_types), work = await consent('work', ['text/csv']);
  const begin = async (bindingId: string) => {
    const admitted = await call(`/api/apps/blob/sync/bindings/${bindingId}/sync`, 'POST', {});
    const { session } = await call(`/api/apps/blob/sync/bindings/${bindingId}/sessions`, 'POST', {});
    const identity = { schema_version: 'deft.app_runtime_channel.v3', audience: 'app_resource_sync', session_id: session.session_id };
    const invoke = (path: string, body: unknown) => call('/api/app-resource-sync-channel/v3' + path, 'POST', body, session.session_token, 'AppRuntime');
    const { claim } = await invoke('/claim', { ...identity, max_claims: 1 });assert.equal(claim.run_id, admitted.run_id);
    const pins = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
    const started = (await invoke('/start', pins)).started;
    assert.equal(started.run_id, claim.run_id);assert.equal(started.resource_binding_id, bindingId);
    const stage = async (key: string, bytes: Uint8Array) => {
      const frame = frameResourceSyncAttachment({ schema_version: 'deft.app_sync_attachment_stage.v1', channel_version: 'deft.app_runtime_channel.v3',
        audience: 'app_resource_sync', session_id: session.session_id, run_id: claim.run_id, attempt_id: claim.attempt_id,
        claim_token: claim.claim_token, sequence: claim.sequence, parent_resource_id: 'synthetic-message', parent_revision: '1',
        attachment_key: key, filename: `${key}.pdf`, declared_media_type: 'application/pdf', declared_size_bytes: bytes.byteLength }, bytes);
      const response = await fetch(base + '/api/app-resource-sync-channel/v3/attachments/stage', { method: 'POST',
        headers: { authorization: `AppRuntime ${session.session_token}`, 'content-type': 'application/vnd.deft.sync-attachment.v1' }, body: Uint8Array.from(frame).buffer });
      return { status: response.status, body: await response.json() as any };
    };
    const settle = (links: unknown[]) => invoke('/result', { ...pins, status: 'returned', provider_succeeded: true,
      page: { schema_version: 'deft.app_sync_page.v2', upserts: [{ id: 'synthetic-message', revision: '1',
        data: { subject: 'Synthetic PDF parent', body: 'Synthetic plain body' }, attachments: links }], tombstones: [], next_cursor: null, has_more: false } });
    return { claim, stage, settle };
  };
  const sync = await begin(personal.binding_id), staged = await sync.stage('synthetic-brief', pdf);
  assert.equal(staged.status, 200);assert.equal(staged.body.state, 'ready');
  const blocked = await sync.stage('truncated-brief', pdf.subarray(0, pdf.length - 10));
  assert.equal(blocked.status, 200);assert.equal(blocked.body.state, 'blocked');
  const beforeLink = await request(`/api/private-resources/bindings/${personal.binding_id}/records/${randomUUID()}/attachments/${staged.body.staging_id}/content`);
  assert.equal(beforeLink.status, 409, 'Ready stage IDs carry no standalone delivery authority');
  assert.equal((await sync.settle([{ attachment_key: 'synthetic-brief', staging_id: staged.body.staging_id },
    { attachment_key: 'truncated-brief', staging_id: blocked.body.staging_id }])).accepted, true);
  const [projection] = await db.select().from(s.appResourceProjections).where(and(eq(s.appResourceProjections.org_id, org), eq(s.appResourceProjections.resource_binding_id, personal.binding_id)));
  const path = `/api/private-resources/bindings/${personal.binding_id}/records/${projection.id}/attachments`;
  const contentPath = `${path}/${staged.body.staging_id}/content`;
  await t.test('linked PDF is exact encrypted custody with forced download headers and a blocked malformed sibling', async () => {
    const catalog = await call(path);assert.deepEqual(catalog.attachments.map((entry: any) => entry.state).sort(), ['available', 'blocked']);
    assert.ok(catalog.attachments.every((entry: any) => entry.media_type === 'application/pdf'));
    const response = await fetch(base + contentPath, { headers: { authorization: `Bearer ${ownerSession.accessToken}` } });
    assert.equal(response.status, 200);assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-disposition')!, /^attachment;/u);
    const delivered = Buffer.from(await response.arrayBuffer());assert.deepEqual(delivered, pdf);assert.equal(createHash('sha256').update(delivered).digest('hex'), pdfDigest);
    assert.equal((await request(`${path}/${blocked.body.staging_id}/content`)).status, 409);
    const [stored] = await db.select().from(s.appAttachmentStages).where(eq(s.appAttachmentStages.id, staged.body.staging_id));
    assert.equal(stored.state, 'linked');assert.ok(stored.binary_key_version && stored.content_hmac && stored.parent_body_hmac);
    const ciphertext = await (await attachments.getAppAttachmentRuntime()).objects.get(stored.object_id!, new AbortController().signal);
    assert.notDeepEqual(ciphertext, pdf);assert.equal(ciphertext.includes(Buffer.from('%PDF-')), false);
  });
  await t.test('owner, target, parent and narrowed consent checks deny PDF substitution', async () => {
    for (const denied of [await request(contentPath, 'GET', undefined, otherSession.accessToken),
      await request(contentPath.replace(personal.binding_id, work.binding_id)),
      await request(contentPath.replace(projection.id, randomUUID()))]) {
      assert.equal(denied.status, 409);assert.equal(denied.body.code, 'APP_STALE');assert.equal(JSON.stringify(denied.body).includes('%PDF'), false);
    }
    const narrowed = await begin(work.binding_id), deniedStage = await narrowed.stage('not-consented-pdf', pdf);
    assert.equal(deniedStage.status, 409);assert.equal(deniedStage.body.code, 'APP_STATE_CONFLICT');
    assert.equal((await db.select().from(s.appAttachmentStages).where(eq(s.appAttachmentStages.run_id, narrowed.claim.run_id))).length, 0);
    assert.equal((await narrowed.settle([])).accepted, true);
  });
  await t.test('consent revocation after actual ciphertext I/O fences PDF delivery', async () => {
    const composed = await attachments.getAppAttachmentRuntime(), get = composed.objects.get.bind(composed.objects);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), read = new Promise<void>(resolve => { entered = resolve; });
    composed.objects.get = async (...args) => { const bytes = await get(...args);entered();await gate;return bytes; };
    const pending = fetch(base + contentPath, { headers: { authorization: `Bearer ${ownerSession.accessToken}` } });
    try {
      await read;await call(`/api/apps/blob/sync/bindings/${personal.binding_id}/revoke`, 'POST', {});release();
      const response = await pending;assert.equal(response.status, 409);assert.equal(response.headers.get('cache-control'), 'no-store');
      const denied = await response.json() as any;assert.equal(denied.code, 'APP_STALE');assert.equal(JSON.stringify(denied).includes('%PDF'), false);
    } finally { release();composed.objects.get = get;await pending.catch(() => {}); }
  });
});
