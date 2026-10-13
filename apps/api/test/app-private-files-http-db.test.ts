import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildDeftAppPackage, createAppRuntimeClient } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';

test('real HTTP upload, exact human snapshot and Runtime release preserve one PDF after draft removal',
  { skip: !securityTestDatabaseIsSafe(), timeout: 120000 }, async t => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
    DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`private-state-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('private-enc'), receipt_signing: ring('private-sign'), fingerprint: ring('private-fp') });
  const [{ db, closeDb }, s, { eq }, web, runtime, attachments, { Hono }, { serve }, experienceRoutes, blobRoutes,
    channelRoutes, humanRoutes, { AppExperienceHumanActionService }, { AppExperienceExposureService },
    { AppActionPayloadCapture }, { AppConnectionRegistry }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js'), import('hono'), import('@hono/node-server'),
    import('../src/routes/app-experiences.js'), import('../src/routes/app-attachments.js'), import('../src/routes/app-runtime-channel.js'),
    import('../src/lib/app-experience-human-action-routes.js'), import('../src/lib/app-experience-human-action-service.js'),
    import('../src/lib/app-experience-exposure.js'), import('../src/lib/app-action-payload-capture.js'), import('../src/lib/app-connection-registry.js') ]);
  let registry = new AppConnectionRegistry([]), builderCalls = 0;
  const pdf = Buffer.from('%PDF-1.7\nsynthetic-private-http-pdf\nstartxref\n9\n%%EOF\n');
  const expectedMime = Buffer.concat([Buffer.from('Synthetic immutable trusted MIME\r\n'), pdf]);
  const app = new Hono();
  app.route('/api/apps/blob', blobRoutes.appAttachmentRoutes);
  app.route('/api/app-experiences', experienceRoutes.appExperienceRoutes);
  app.route('/api/app-experiences', humanRoutes.createExperienceHumanActionRoutes(async () => {
    const current = await runtime.getAppRunRuntime();
    return new AppExperienceHumanActionService(new AppExperienceExposureService(current.keys), current, () => new Date(),
      new AppActionPayloadCapture(current.keys, async () => registry));
  }));
  app.route('/api/app-runtime/channel', channelRoutes.appRuntimeChannelRoutes);
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    address => resolve(`http://127.0.0.1:${address.port}`)); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve()));
    await attachments.shutdownAppAttachmentRuntime(); await runtime.shutdownAppRunRuntime(); await closeDb(); });
  const org = randomUUID(), owner = randomUUID(), other = randomUUID(), suffix = randomUUID();
  await db.insert(s.orgs).values({ id: org, name: 'Private file HTTP fixture', slug: `custody-http-${suffix}` });
  await db.insert(s.users).values([{ id: owner, name: 'Owner', email: `custody-owner-${suffix}@example.test` },
    { id: other, name: 'Other', email: `custody-other-${suffix}@example.test` }]);
  await db.insert(s.orgMembers).values([{ id: randomUUID(), org_id: org, user_id: owner, role: 'owner', is_active: true },
    { id: randomUUID(), org_id: org, user_id: other, role: 'admin', is_active: true }]);
  const session = await web.createWebSession({ id: owner, org_id: org, email: `custody-owner-${suffix}@example.test` });
  const otherSession = await web.createWebSession({ id: other, org_id: org, email: `custody-other-${suffix}@example.test` });
  const request = async (path: string, method = 'GET', body?: unknown, token = session.accessToken, scheme = 'Bearer') => {
    const response = await fetch(base + path, { method, headers: { authorization: `${scheme} ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (path: string, method = 'GET', body?: unknown, token = session.accessToken, scheme = 'Bearer') => {
    const result = await request(path, method, body, token, scheme);
    assert.ok(result.status < 300, `${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`); return result.body;
  };
  const fixture = JSON.parse((await runtimeSecurityPackage()).json);
  fixture.manifest.id = `community.example.custody.a${suffix.replaceAll('-', '')}`;
  const declaration = fixture.manifest.private_state.find((state: any) => state.key === 'drafts');
  declaration.max_records = 2;
  declaration.files = { max_file_bytes: 2097152, max_files_per_record: 1, max_total_bytes_per_record: 2097152, allowed_media_types: ['application/pdf'] };
  declaration.action_payloads = [{ action_key: 'send_message', max_payload_bytes: 4194304 }];
  const packed = (await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts })).json;
  const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', packed);
  const installContext = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
  const { review: installReview } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', installContext.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...installContext.review_request,
    expected_review_digest: installReview.review_digest, accept_host_policy: true });
  const { setup } = await call(`/api/apps/blob/sync/setup?installation_id=${installed.id}&operator_user_id=${owner}`);
  const resourceInput = { ...setup.descriptors.find((descriptor: any) => descriptor.resource_key === 'inbox').consent_request, target_key: 'personal' };
  const { review: resourceReview } = await call('/api/apps/blob/sync/reviews/prepare', 'POST', resourceInput);
  const { binding: resource } = await call('/api/apps/blob/sync/bindings/activate', 'POST', { ...resourceInput,
    expected_review_digest: resourceReview.review_digest, accept_host_policy: true });
  const { actions } = await call(`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`);
  const actionInput = { ...actions.find((action: any) => action.key === 'send_message').review_request,
    owner_resource_binding_id: resource.binding_id };
  const { review: actionReview } = await call('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', actionInput);
  const { binding: action } = await call('/api/apps/blob/composition/runtime/bindings/activate', 'POST', { ...actionInput,
    expected_review_digest: actionReview.review_digest, accept_host_policy: true });
  const opened = await call(`/api/app-experiences/${installed.id}/main/sessions`, 'POST', { resource_target_key: 'personal' });
  const path = `/api/app-experiences/sessions/${opened.pin.session_id}`;
  const access = await call(path + '/access/review', 'POST', {});
  await call(path + '/access/accept', 'POST', { review_token: access.review_token, review_digest: access.review_digest, accept_exposure: true });
  const [storedSession] = await db.select().from(s.appExperienceSessions).where(eq(s.appExperienceSessions.id, opened.pin.session_id));
  assert.ok(storedSession);
  registry = new AppConnectionRegistry([{ pins: { org_id: org, owner_user_id: owner, installation_id: installed.id,
    app_version_id: installed.version_id, grant_snapshot_id: storedSession.grant_snapshot_id, target_key: 'personal',
    resource_key: 'inbox', resource_binding_id: resource.binding_id, action_key: 'send_message', action_binding_id: action.binding_id },
    adapter: { handle: async () => new Response('{}'), buildActionPayload: async (input, context) => {
      await context.recheck(); builderCalls++;
      assert.equal(input.binding.resource_target_key, 'personal'); assert.equal(input.files.length, 1);
      assert.deepEqual(Buffer.from(input.files[0]!.bytes), pdf);
      const files = input.files.map(file => file.reference);
      return { bytes: Buffer.from(expectedMime), metadata: { preview: { items: [{ key: 'from', label: 'From', value: 'verified@example.test' }], files },
        payload: { verified_from: 'verified@example.test', to: input.input.to, body: input.input.body, files } } };
    } } }]);
  const draftId = randomUUID(), input = { to: 'recipient@example.test', subject: 'Exact private PDF', body: 'Private outgoing body', message_id: '<custody-http@example.test>' };
  const draft = { mode: 'compose', to: input.to, subject: input.subject, body: input.body, reply_record_id: '' };
  const saved = await call(path + '/state/drafts', 'POST', { operation: 'put', record_id: draftId, expected_revision: 0, value: draft });
  assert.equal(saved.output.item.revision, 1);
  const filePath = `${path}/state/drafts/${draftId}/files`, operation = randomUUID();
  const rawUpload = async (revision: number, token = session.accessToken, bytes = pdf, op = operation) => {
    const query = new URLSearchParams({ expected_revision: String(revision), upload_operation_id: op, filename: 'Private HTTP.pdf' });
    const response = await fetch(base + filePath + '?' + query, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/pdf' }, body: bytes });
    return { status: response.status, body: await response.json() as any };
  };
  const uploaded = await rawUpload(1); assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.draft.revision, 2); assert.equal(uploaded.body.files.length, 1);
  const file = uploaded.body.files[0]; assert.equal(file.upload_operation_id, operation);
  assert.deepEqual((await rawUpload(1)).body, uploaded.body, 'lost upload response recovers exact committed operation');
  assert.equal((await rawUpload(1, session.accessToken, pdf, randomUUID())).status, 409);
  assert.ok((await rawUpload(2, otherSession.accessToken, pdf, randomUUID())).status >= 400);
  assert.ok((await rawUpload(2, session.accessToken, Buffer.from('not a PDF'), randomUUID())).status >= 400);
  assert.ok((await request(filePath, 'GET', undefined, otherSession.accessToken)).status >= 400);
  const draftRef = { draft_state_key: 'drafts', draft_id: draftId, expected_revision: 2 }, humanPath = path + '/human-actions/send_message';
  assert.ok((await request(humanPath + '/snapshot', 'POST', { input, draft_ref: { ...draftRef, expected_revision: 1 } })).status >= 400);
  let snapshot = await call(humanPath + '/snapshot', 'POST', { input, draft_ref: draftRef });
  assert.equal(snapshot.preview.items[0].value, 'verified@example.test'); assert.deepEqual(snapshot.preview.files, uploaded.body.files);
  assert.deepEqual((await call(humanPath + '/snapshot', 'POST', { input, draft_ref: draftRef })).snapshot_ref, snapshot.snapshot_ref);
  assert.equal(builderCalls, 2);
  const oldUnconfirmed = snapshot.snapshot_ref;
  input.body += ' after a normal draft edit';
  const edited = await call(path + '/state/drafts', 'POST', { operation: 'put', record_id: draftId,
    expected_revision: 2, value: { ...draft, body: input.body } });
  assert.equal(edited.output.item.revision, 3);
  draftRef.expected_revision = 3;
  snapshot = await call(humanPath + '/snapshot', 'POST', { input, draft_ref: draftRef });
  const [retired] = await db.select().from(s.appActionPayloads).where(eq(s.appActionPayloads.id, oldUnconfirmed.snapshot_id));
  assert.ok(retired!.purged_at); assert.equal(retired!.ciphertext, null); assert.equal(retired!.metadata_envelope, null);
  assert.ok((await request(humanPath + '/prepare', 'POST', { input, draft_ref: draftRef, idempotency_key: draftId })).status >= 400, 'payload declaration cannot be bypassed');
  assert.ok((await request(humanPath + '/prepare', 'POST', { input, draft_ref: draftRef, idempotency_key: draftId,
    snapshot_ref: { ...snapshot.snapshot_ref, digest: '0'.repeat(64) } })).status >= 400);
  const ticket = await call(humanPath + '/prepare', 'POST', { input, draft_ref: draftRef, snapshot_ref: snapshot.snapshot_ref, idempotency_key: draftId });
  assert.ok((await request(path + '/human-actions/confirm', 'POST', { ticket: ticket.ticket, expected_input_digest: ticket.input_digest })).status >= 400);
  const confirmation = { ticket: ticket.ticket, expected_input_digest: ticket.input_digest, expected_snapshot_digest: snapshot.snapshot_ref.digest };
  const queued = await call(path + '/human-actions/confirm', 'POST', confirmation);
  assert.equal((await call(path + '/human-actions/confirm', 'POST', confirmation)).run.id, queued.run.id);
  const removed = await call(filePath + '/' + file.file_id, 'DELETE', { expected_revision: 3 });
  assert.equal(removed.draft.revision, 4); assert.deepEqual(removed.files, []);
  const laterUpload = await rawUpload(4, session.accessToken, pdf, randomUUID());
  assert.equal(laterUpload.status, 200); assert.equal(laterUpload.body.draft.revision, 5);
  await call(humanPath + '/snapshot', 'POST', { input, draft_ref: { ...draftRef, expected_revision: 5 } });
  const [confirmedPayload] = await db.select().from(s.appActionPayloads).where(eq(s.appActionPayloads.id, snapshot.snapshot_ref.snapshot_id));
  assert.equal(confirmedPayload!.purged_at, null); assert.ok(confirmedPayload!.ciphertext,
    'confirmed old snapshot survives later draft edits and unconfirmed retirement');
  const { session: runtimeSession } = await call(`/api/apps/blob/composition/runtime/bindings/${action.binding_id}/sessions`, 'POST', {});
  const identity = { schema_version: 'deft.app_runtime_channel.v1', session_id: runtimeSession.session_id };
  const { claim } = await call('/api/app-runtime/channel/claim', 'POST', { ...identity, max_claims: 1 }, runtimeSession.session_token, 'AppRuntime');
  assert.ok(claim); assert.equal(claim.run_id, queued.run.id); assert.equal('input' in claim, false);
  const attempt = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
  const oldWorker = await request('/api/app-runtime/channel/start', 'POST', attempt, runtimeSession.session_token, 'AppRuntime');
  assert.equal(oldWorker.status, 403, 'old worker cannot drop a reviewed PDF');
  const [beforeStart] = await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.id, claim.attempt_id));
  assert.equal(beforeStart!.provider_call_started_at, null);
  if (process.env.DEFT_TEST_PURGED_PAYLOAD_START === 'true') {
    await db.update(s.appActionPayloads).set({ expires_at: new Date(Date.now() - 1000), purged_at: new Date(),
      ciphertext: null, key_version: null, nonce_b64: null, auth_tag_b64: null, metadata_envelope: null })
      .where(eq(s.appActionPayloads.id, snapshot.snapshot_ref.snapshot_id));
    const denied = await request('/api/app-runtime/channel/start', 'POST',
      { ...attempt, action_payload_version: 'deft.app_action_payload.v1' }, runtimeSession.session_token, 'AppRuntime');
    assert.equal(denied.status, 403);
    const [afterDenied] = await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.id, claim.attempt_id));
    assert.equal(afterDenied!.provider_call_started_at, null, 'purged payload must be denied before durable Start');
    assert.equal(afterDenied!.state, 'claimed');
    return;
  }
  const { started } = await call('/api/app-runtime/channel/start', 'POST', { ...attempt, action_payload_version: 'deft.app_action_payload.v1' }, runtimeSession.session_token, 'AppRuntime');
  assert.deepEqual(started.snapshot_ref, snapshot.snapshot_ref); assert.deepEqual(started.input, input);
  const payloadRequest = { ...attempt, snapshot_ref: snapshot.snapshot_ref, part: { kind: 'metadata' } };
  const metadata = await call('/api/app-runtime/channel/payload', 'POST', payloadRequest, runtimeSession.session_token, 'AppRuntime');
  assert.equal(metadata.payload.binding.draft_revision, 3); assert.equal(metadata.payload.file_refs[0].file_id, file.file_id);
  assert.equal(metadata.payload.metadata.preview.items[0].value, 'verified@example.test');
  const release = async (part: unknown) => fetch(base + '/api/app-runtime/channel/payload', { method: 'POST',
    headers: { authorization: `AppRuntime ${runtimeSession.session_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...payloadRequest, part }) });
  const mimeResponse = await release({ kind: 'bytes' }); assert.equal(mimeResponse.status, 200);
  assert.deepEqual(Buffer.from(await mimeResponse.arrayBuffer()), expectedMime);
  const fileResponse = await release({ kind: 'file', file_id: file.file_id }); assert.equal(fileResponse.status, 200);
  assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), pdf);
  const sdk = createAppRuntimeClient({ channel_url: base + '/api/app-runtime/channel', credential: runtimeSession,
    action_payload_version: 'deft.app_action_payload.v1' });
  const sdkMetadata = await sdk.payloadMetadata(claim, snapshot.snapshot_ref);
  assert.equal(sdkMetadata.binding.draft_revision, 3);
  assert.deepEqual(sdkMetadata.file_refs, uploaded.body.files);
  assert.deepEqual(Buffer.from(await sdk.payloadBytes(claim, snapshot.snapshot_ref)), expectedMime,
    'actual SDK validates binary response headers and decodes retained bytes');
  assert.deepEqual(Buffer.from(await sdk.fileBytes(claim, snapshot.snapshot_ref, file.file_id)), pdf);
  const wrongFile = await release({ kind: 'file', file_id: randomUUID() }); assert.equal(wrongFile.status, 403);
  const wrongRef = await request('/api/app-runtime/channel/payload', 'POST', { ...payloadRequest,
    snapshot_ref: { ...snapshot.snapshot_ref, digest: '0'.repeat(64) } }, runtimeSession.session_token, 'AppRuntime');
  assert.equal(wrongRef.status, 403); assert.equal(JSON.stringify(wrongRef.body).includes(input.body), false);
  assert.equal((await request('/api/app-runtime/channel/payload', 'POST', payloadRequest, otherSession.accessToken)).status, 403);
  const completed = await sdk.result(claim, { status: 'returned', provider_succeeded: true,
    output: { operation_id: `mail-${queued.run.id}`, transport_outcome: 'accepted', sent_copy_outcome: 'confirmed' } }) as { state: string };
  assert.equal(completed.state, 'succeeded');
});
