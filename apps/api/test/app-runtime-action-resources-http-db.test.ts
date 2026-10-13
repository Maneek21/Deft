import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildDeftAppPackage } from '@deft/app-kit';
import { AppRuntimeActionResourcesRequestSchema } from '../src/lib/app-runtime-contract.js';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';

test('Runtime source request is input-key-only and rejects nominated authority or record identifiers', () => {
  const request = { schema_version: 'deft.app_runtime_channel.v1', session_id: 'session', session_token: 't'.repeat(32),
    run_id: 'run', attempt_id: 'attempt', claim_token: 'claim', sequence: 1,
    action_resources_version: 'deft.app_action_resources.v1', input_key: 'source_records' };
  assert.ok(AppRuntimeActionResourcesRequestSchema.safeParse(request).success);
  for (const key of ['record_ids', 'resource_binding_id', 'account_id', 'owner_id', 'org_id', 'resource_key', 'data'])
    assert.equal(AppRuntimeActionResourcesRequestSchema.safeParse({ ...request, [key]: randomUUID() }).success, false);
  for (const input_key of ['', '../inbox', 'Upper', 'x'.repeat(49)])
    assert.equal(AppRuntimeActionResourcesRequestSchema.safeParse({ ...request, input_key }).success, false);
  assert.equal(AppRuntimeActionResourcesRequestSchema.safeParse({ ...request, action_resources_version: 'unreviewed' }).success, false);
});

test('started human Runtime source reads use exact private owner/target/current checkpoint', { timeout: 120_000 }, async t => {
  assert.ok(securityTestDatabaseIsSafe(), 'Set matching guarded disposable DATABASE_URL and DEFT_TEST_DATABASE_URL');
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`action-resource-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('resources-enc'), receipt_signing: ring('resources-sign'), fingerprint: ring('resources-fp') });
  const [{ db, closeDb }, s, { and, eq, sql }, web, runtimeModule, attachments, { Hono }, blob, channel, sync, agent, auth] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js'), import('hono'),
    import('../src/routes/app-attachments.js'), import('../src/routes/app-runtime-channel.js'), import('../src/routes/app-attachment-sync-channel.js'),
    import('../src/routes/agent.js'), import('../src/middleware/auth.js'),
  ]);
  t.after(async () => { await attachments.shutdownAppAttachmentRuntime(); await runtimeModule.shutdownAppRunRuntime(); await closeDb(); });
  const app = new Hono(); app.route('/api/apps/blob', blob.appAttachmentRoutes);
  app.route('/api/app-runtime/channel', channel.appRuntimeChannelRoutes); app.route('/api/app-resource-sync-channel/v3', sync.appAttachmentSyncChannelRoutes);
  app.use('/api/agent/*', auth.authMiddleware); app.route('/api/agent', agent.agentRoutes);
  const org = randomUUID(), foreignOrg = randomUUID(), owner = randomUUID(), other = randomUUID(), foreign = randomUUID(), suffix = randomUUID();
  await db.insert(s.orgs).values([{ id: org, name: 'Exact source test', slug: `sources-${suffix}` },
    { id: foreignOrg, name: 'Foreign source test', slug: `foreign-sources-${suffix}` }]);
  const tokens = new Map<string, string>();
  for (const [id, org_id] of [[owner, org], [other, org], [foreign, foreignOrg]] as const) {
    const email = `source-${id}@example.test`;
    await db.insert(s.users).values({ id, name: 'Synthetic source owner', email });
    await db.insert(s.orgMembers).values({ id: randomUUID(), org_id, user_id: id, role: 'owner', is_active: true });
    tokens.set(id, (await web.createWebSession({ id, org_id, email })).accessToken);
  }
  const request = async (path: string, body?: unknown, token = tokens.get(owner)!, scheme = 'Bearer', method = 'POST', signal?: AbortSignal) => {
    const response = await app.request(`http://localhost${path}`, { method, headers: { authorization: `${scheme} ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
    const output: any = await response.json(); return { status: response.status, body: output };
  };
  const call = async (...args: Parameters<typeof request>) => { const response = await request(...args);
    assert.ok(response.status >= 200 && response.status < 300, `${args[0]} ${response.status} ${JSON.stringify(response.body)}`); return response.body; };
  const closed = (response: { status: number; body: any }) => { assert.ok([400, 403, 404, 409].includes(response.status));
    assert.equal(typeof response.body.code, 'string'); assert.ok(!JSON.stringify(response.body).includes('PRIVATE-ACTION-RESOURCE')); assert.equal(response.body.resources, undefined); };
  const fixture = JSON.parse((await runtimeSecurityPackage()).json);
  fixture.manifest.id = `community.example.resource-test.a${suffix.replaceAll('-', '')}`;
  const capability = fixture.manifest.private_capabilities.find((row: any) => row.key === 'archive_message');
  capability.input_schema = { type: 'object', properties: {
    source_records: { type: 'string', maxLength: 925, format: 'resource_record_list', maxItems: 25, resourceKey: 'inbox' },
    note: { type: 'string', maxLength: 200 },
  }, required: ['source_records', 'note'], additionalProperties: false };
  fixture.manifest.sync_descriptors[0].record_schema.properties.account_id = { type: 'string', maxLength: 200 };
  fixture.manifest.sync_descriptors[0].record_schema.required.push('account_id');
  const packed = JSON.parse((await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts })).json);
  const install = async (person = owner) => {
    const token = tokens.get(person)!;
    const { app: installed } = await call('/api/apps/blob/composition/stage', packed, token);
    const context = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`, undefined, token, 'Bearer', 'GET');
    const { review } = await call(`/api/apps/blob/composition/${installed.id}/review`, context.review_request, token);
    await call(`/api/apps/blob/composition/${installed.id}/activate`, { ...context.review_request, expected_review_digest: review.review_digest, accept_host_policy: true }, token);
    return installed;
  };
  const installed = await install(), foreignInstall = await install(foreign);
  const resource = async (target: string, person = owner, installation = installed) => {
    const token = tokens.get(person)!;
    const { setup } = await call(`/api/apps/blob/sync/setup?installation_id=${installation.id}&operator_user_id=${person}`, undefined, token, 'Bearer', 'GET');
    const input = { ...setup.descriptors[0].consent_request, target_key: target };
    const { review } = await call('/api/apps/blob/sync/reviews/prepare', input, token);
    return (await call('/api/apps/blob/sync/bindings/activate', { ...input, expected_review_digest: review.review_digest, accept_host_policy: true }, token)).binding;
  };
  const personal = await resource('personal'), work = await resource('work'), otherResource = await resource('personal', other), foreignResource = await resource('personal', foreign, foreignInstall);
  const publish = async (binding: any, target: string, person = owner) => {
    const token = tokens.get(person)!;
    const admitted = await call(`/api/apps/blob/sync/bindings/${binding.binding_id}/sync`, {}, token);
    const { session } = await call(`/api/apps/blob/sync/bindings/${binding.binding_id}/sessions`, {}, token);
    const prefix = '/api/app-resource-sync-channel/v3', identity = { schema_version: 'deft.app_runtime_channel.v3', audience: 'app_resource_sync', session_id: session.session_id };
    const { claim } = await call(prefix + '/claim', { ...identity, max_claims: 1 }, session.session_token, 'AppRuntime'); assert.equal(claim.run_id, admitted.run_id);
    const exact = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
    await call(prefix + '/start', exact, session.session_token, 'AppRuntime');
    const result = await call(prefix + '/result', { ...exact, status: 'returned', provider_succeeded: true, page: {
      schema_version: 'deft.app_sync_page.v2', upserts: [{ id: 'same-private-native-id', revision: 'current-1',
        data: { subject: `PRIVATE-ACTION-RESOURCE-${target}`, body: `PRIVATE-ACTION-RESOURCE-${target}-BODY`, account_id: target }, attachments: [] }],
      tombstones: [], next_cursor: null, has_more: false } }, session.session_token, 'AppRuntime'); assert.equal(result.accepted, true);
    const rows = await db.select({ id: s.appResourceProjections.id }).from(s.appResourceProjections).innerJoin(s.appSyncCheckpoints,
      and(eq(s.appSyncCheckpoints.id, s.appResourceProjections.checkpoint_id), eq(s.appSyncCheckpoints.state, 'active')))
      .where(and(eq(s.appResourceProjections.resource_binding_id, binding.binding_id), eq(s.appResourceProjections.state, 'live')));
    assert.equal(rows.length, 1); return rows[0]!.id;
  };
  const ids = { personal: await publish(personal, 'personal'), work: await publish(work, 'work'),
    other: await publish(otherResource, 'other-owner', other), foreign: await publish(foreignResource, 'foreign-org', foreign) };
  const { actions } = await call(`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`, undefined, undefined, 'Bearer', 'GET');
  const bind = async (resourceBindingId: string) => {
    const input = { ...actions.find((row: any) => row.key === 'archive_message').review_request, owner_resource_binding_id: resourceBindingId };
    const { review } = await call('/api/apps/blob/composition/runtime/reviews/prepare', input);
    return (await call('/api/apps/blob/composition/runtime/bindings/activate', { ...input, expected_review_digest: review.review_digest, accept_host_policy: true })).binding;
  };
  const action = await bind(personal.binding_id), workAction = await bind(work.binding_id), runtime = await runtimeModule.getAppRunRuntime();
  const started = async (sourceId: string, binding = action) => {
    const { run } = await call('/api/apps/blob/composition/runtime/invoke', { runtime_binding_id: binding.binding_id, idempotency_key: randomUUID(), input: { source_records: sourceId, note: 'Reviewed source read' } });
    assert.equal(run.state, 'pending_approval');
    const [approval] = await db.select().from(s.agentActions).where(and(eq(s.agentActions.org_id, org), eq(s.agentActions.app_run_id, run.id)));
    assert.ok(approval); assert.equal((await call(`/api/agent/actions/${approval.id}/approve`, {})).status, 'approved');
    const { session } = await call(`/api/apps/blob/composition/runtime/bindings/${binding.binding_id}/sessions`, {});
    const identity = { schema_version: 'deft.app_runtime_channel.v1', session_id: session.session_id };
    const { claim } = await call('/api/app-runtime/channel/claim', { ...identity, max_claims: 1 }, session.session_token, 'AppRuntime'); assert.equal(claim.run_id, run.id);
    const fields = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
    const read = (extra: Record<string, unknown> = {}, signal?: AbortSignal) => request('/api/app-runtime/channel/resources', { ...fields,
      action_resources_version: 'deft.app_action_resources.v1', input_key: 'source_records', ...extra }, session.session_token, 'AppRuntime', 'POST', signal);
    return { run, fields, session, read, start: () => call('/api/app-runtime/channel/start', fields, session.session_token, 'AppRuntime') };
  };
  const withHeldInput = async (current: Awaited<ReturnType<typeof started>>, work: (held: {
    pending: ReturnType<typeof current.read>; abort(): void; release(): void; waitForBlockedMutation(): Promise<void>;
  }) => Promise<void>) => {
    const original = runtime.secretRepository.readInput.bind(runtime.secretRepository);
    let entered!: () => void, release!: () => void, backendPid = 0;
    const atInput = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    runtime.secretRepository.readInput = async (...args) => {
      const value = await original(...args);
      if (args[0] === org && args[1] === current.run.id) {
        const result = await args[2]!.execute(sql`SELECT pg_backend_pid() AS pid`);
        backendPid = Number(result.rows[0]!.pid); entered(); await held;
      }
      return value;
    };
    const controller = new AbortController(), pending = current.read({}, controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([atInput, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Source input boundary not reached')), 5000); })]);
      await work({ pending, abort: () => controller.abort(), release, waitForBlockedMutation: async () => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const result = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname=current_database() AND ${backendPid}=ANY(pg_blocking_pids(pid))`);
          if (Number(result.rows[0]!.count) > 0) return;
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        assert.fail('Expected exact source transaction to fence the concurrent mutation');
      } });
    } finally { if (timer) clearTimeout(timer); release(); runtime.secretRepository.readInput = original; await pending; }
  };
  await t.test('claimed-only source is denied; started exact source decrypts current checkpoint with owner annotations', async () => {
    const current = await started(ids.personal); closed(await current.read()); await current.start(); const result = await current.read();
    assert.equal(result.status, 200); assert.equal(result.body.resources.schema_version, 'deft.app_action_resources.v1');
    assert.deepEqual(result.body.resources.scope, { org_id: org, owner_id: owner, installation_id: installed.id });
    assert.equal(result.body.resources.resource_binding_id, personal.binding_id); assert.equal(result.body.resources.resource_key, 'inbox');
    assert.deepEqual(result.body.resources.records, [{ record_id: ids.personal, revision: 'current-1', label: 'PRIVATE-ACTION-RESOURCE-personal',
      data: { subject: 'PRIVATE-ACTION-RESOURCE-personal', body: 'PRIVATE-ACTION-RESOURCE-personal-BODY', account_id: 'personal' } }]);
    for (const extra of [{ input_key: 'note' }, { account_id: 'work' }, { record_ids: [ids.work] }, { owner_id: other }, { org_id: foreignOrg }, { resource_binding_id: work.binding_id },
      { claim_token: 'wrong-claim' }, { sequence: current.fields.sequence + 1 }, { attempt_id: randomUUID() }, { session_id: randomUUID() }]) closed(await current.read(extra));
    closed(await request('/api/app-runtime/channel/resources', { ...current.fields, action_resources_version: 'deft.app_action_resources.v1', input_key: 'source_records' }, tokens.get(other)!));
  });
  await t.test('retained Run IDs from another owner/org/target cannot nominate private plaintext', async () => {
    for (const id of [ids.work, ids.other, ids.foreign]) { const current = await started(id); await current.start(); closed(await current.read()); }
  });
  await t.test('encrypted native source companion releases only exact Run input and remains immutable across restart',async()=>{
    const id=randomUUID(),current=await started(id),source={record_id:id,resource_key:'inbox',resource_binding_id:personal.binding_id,revision:'native-1',label:'Native mailbox source',data:{subject:'Native mailbox source',body:'private source',account_id:'personal'},provider_source:{schema_version:'deft.email_provider_source.v1',account_id:'personal',provider:'gmail',authority_epoch:1,logical_message_id:'logical-test',conversation_id:'conversation-test',locator:{kind:'gmail',message_id:'PRIVATE-ACTION-RESOURCE-native',thread_id:'native-thread',label_ids:['INBOX']}}};
    const [retainedRun]=await db.select().from(s.appRuns).where(and(eq(s.appRuns.org_id,org),eq(s.appRuns.id,current.run.id)));
    const exact=await runtime.secretRepository.readInput(org,current.run.id),value={schema_version:'deft.app_action_resource_snapshot.v1' as const,org_id:org,owner_id:owner,installation_id:installed.id,app_version_id:retainedRun!.origin_app_version_id!,grant_snapshot_id:retainedRun!.origin_app_grant_snapshot_id!,runtime_binding_id:retainedRun!.origin_runtime_binding_id!,input_digest:`sha256:${createHash('sha256').update((await import('@deft/shared')).canonicalCapabilityJson(exact)).digest('hex')}`,resources:{source_records:[source]}};
    await db.transaction(async tx=>{await runtime.secretRepository.retainActionResources(tx,{org_id:org,run_id:current.run.id,value,expires_at:new Date(Date.now()+60000)});});
    closed(await current.read());await current.start();const result=await current.read();assert.equal(result.status,200);assert.deepEqual(result.body.resources.records,[{record_id:id,revision:source.revision,label:source.label,data:source.data,provider_source:source.provider_source}]);
    await assert.rejects(db.transaction(async tx=>runtime.secretRepository.retainActionResources(tx,{org_id:org,run_id:current.run.id,value:{...value,resources:{source_records:[{...source,label:'Changed immutable source'}]}},expires_at:new Date(Date.now()+60000)})),/immutable/);
    const [secret]=await db.select().from(s.appRunSecretPayloads).where(and(eq(s.appRunSecretPayloads.org_id,org),eq(s.appRunSecretPayloads.run_id,current.run.id),eq(s.appRunSecretPayloads.payload_kind,'action_resources')));assert.ok(secret);assert.ok(!secret.ciphertext_b64.includes('PRIVATE-ACTION-RESOURCE'));
    await assert.rejects(runtime.secretRepository.readActionResources(org,current.run.id,db,new Date(Date.now()+120000)),/expired/);
    closed(await current.read({input_key:'note'}));closed(await current.read({record_ids:[randomUUID()]}));
  });
  await t.test('cancellation waits for the held source lock; aborted output and later reads are denied without losing the dispatch marker', async () => {
    const current = await started(ids.personal); await current.start();
    await withHeldInput(current, async held => {
      const cancelled = runtime.service.cancel(org, current.run.id, { actor_type: 'human', user_id: owner });
      try { await held.waitForBlockedMutation(); held.abort(); held.release(); closed(await held.pending); }
      finally { held.release(); await cancelled; }
    });
    closed(await current.read()); const [attempt] = await db.select().from(s.appRunAttempts).where(eq(s.appRunAttempts.id, current.fields.attempt_id));
    assert.ok(attempt); assert.equal(attempt.state, 'provider_call_started'); assert.ok(attempt.provider_call_started_at);
  });
  await t.test('abort while exact retained input is held denies decrypted output', async () => {
    const current = await started(ids.personal); await current.start();
    await withHeldInput(current, async held => { held.abort(); held.release(); closed(await held.pending); });
  });
  await t.test('revocation waits for held source authority; aborted output is denied and the other target remains isolated', async () => {
    const personalRun = await started(ids.personal), workRun = await started(ids.work, workAction); await personalRun.start(); await workRun.start();
    await withHeldInput(personalRun, async held => {
      const revoked = call(`/api/apps/blob/sync/bindings/${personal.binding_id}/revoke`, {});
      try { await held.waitForBlockedMutation(); held.abort(); held.release(); closed(await held.pending); }
      finally { held.release(); await revoked; }
    });
    closed(await personalRun.read());
    const result = await workRun.read(); assert.equal(result.status, 200); assert.equal(result.body.resources.records[0].data.account_id, 'work');
  });
});
