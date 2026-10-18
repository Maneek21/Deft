import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ServerType } from '@hono/node-server';
const target = process.env.DATABASE_URL ?? '';
const safe = /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c14_native_calendar_test(?:_v[0-9]+)?$/.test(target)
  && process.env.DEFT_TEST_DATABASE_URL === target;
Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
  DEFT_APP_NATIVE_CALENDAR_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
  DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', JWT_SECRET: 'synthetic-native-calendar-only', NODE_ENV: 'test' });
const ring = (key: string) => ({ current: key, keys: { [key]: createHash('sha256').update(`c14-native:${key}`).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('c14-enc'), receipt_signing: ring('c14-sign'), fingerprint: ring('c14-fp') });
let server: ServerType | undefined; let base: string;
after(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  if (safe) { await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime(); await (await import('../src/lib/db.js')).closeDb(); }
});
async function fixture(options: { experience?: boolean; sync?: boolean; search?: boolean } = {}) {
  const [{ db }, schema, orm, kit, web, { Hono }, { authMiddleware }, { appRoutes }, { agentRoutes }, { appRunRoutes }, { serve }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'), import('../src/lib/web-sessions.js'),
    import('hono'), import('../src/middleware/auth.js'), import('../src/routes/apps.js'), import('../src/routes/agent.js'),
    import('../src/routes/app-runs.js'), import('@hono/node-server'),
  ]);
  if (!server) {
    const app = new Hono(); app.use('/api/*', authMiddleware); app.route('/api/apps', appRoutes);
    app.route('/api/agent', agentRoutes); app.route('/api/app-runs', appRunRoutes);
    app.route('/api/app-experiences', (await import('../src/routes/app-experiences.js')).appExperienceRoutes);
    app.route('/api/resources', (await import('../src/routes/resources.js')).resourceRoutes);
    app.route('/api/private-resources', (await import('../src/routes/app-resource-private-read.js')).appResourcePrivateReadRoutes);
    base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(`http://127.0.0.1:${info.port}`)); });
  }
  const org = randomUUID(), manager = randomUUID(), owner = randomUUID(), suffix = randomUUID().replaceAll('-', '');
  await db.insert(schema.orgs).values({ id: org, name: 'Native Calendar fixture', slug: `native-${suffix}` });
  await db.insert(schema.users).values([{ id: manager, name: 'Manager', email: `${manager}@example.test` }, { id: owner, name: 'Calendar owner', email: `${owner}@example.test` }]);
  await db.insert(schema.orgMembers).values([{ org_id: org, user_id: manager, role: 'owner', is_active: true }, { org_id: org, user_id: owner, role: 'member', is_active: true }]);
  const managerWeb = await web.createWebSession({ id: manager, org_id: org, email: `${manager}@example.test` });
  const ownerWeb = await web.createWebSession({ id: owner, org_id: org, email: `${owner}@example.test` });
  const call = async (path: string, value?: unknown, token = managerWeb.accessToken) => {
    const response = await fetch(`${base}${path}`, { method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() as any, cache: response.headers.get('cache-control') };
  };
  const artifact = options.experience ? await kit.prepareDeftExperienceArtifact('experiences/main.json', {
    schema_version: options.search ? 'deft.experience_bundle.v2' : 'deft.experience_bundle.v1',
    ...(options.search ? { search_resource_keys: ['inbox'] } : {}),
    worker_source: 'self.onmessage=()=>{};', entry_view: 'main', resource_keys: options.search ? ['inbox'] : [], action_keys: ['create_event'],
  }) : undefined;
  const manifest = { schema_version: '6' as const, id: `community.example.native.a${suffix}`, version: '1.0.0', name: 'Native Calendar',
    license: 'AGPL-3.0-only', compatibility: { app_protocol: '6' as const }, modules: [], navigation: [],
    runtime_requirements: options.sync ? [{ key: 'provider', protocol_version: 'deft.app_runtime_channel.v2' as const }] : [],
    runtime_actions: [], sync_descriptors: options.sync ? [{ schema_version: 'deft.app_sync_descriptor.v1' as const, key: 'inbox',
      runtime_requirement_key: 'provider', resource_type: 'email_message', requested_visibility: 'user_private' as const, label_field: 'subject',
      record_schema: { type: 'object' as const, properties: { subject: { type: 'string' as const, maxLength: 200 } }, required: ['subject'], additionalProperties: false } }] : [],
    experiences: artifact ? [{ key: 'main', label: 'Calendar', artifact_path: artifact.path,
      artifact_digest: artifact.digest, bridge_version: kit.DEFT_EXPERIENCE_BRIDGE_VERSION, renderer_version: kit.DEFT_EXPERIENCE_RENDERER_VERSION }] : [], public_actions: [],
    private_capabilities: ['create', 'cancel'].map(name => ({ key: `calendar_${name}`, version: '1',
      ...kit.NATIVE_CALENDAR_CONTRACTS[`calendar.events.${name}.v1` as keyof typeof kit.NATIVE_CALENDAR_CONTRACTS] })),
    native_actions: ['create', 'cancel'].map(name => ({ key: `${name}_event`, label: `${name} Calendar event`,
      capability_key: `calendar_${name}`, operation: `calendar.events.${name}.v1` })),
  };
  const pkg = await kit.buildDeftAppPackage({ manifest, artifacts: artifact ? [artifact] : [] });
  const staged = await call('/api/apps/stage', JSON.parse(pkg.json)); assert.equal(staged.status, 201, JSON.stringify(staged.body));
  const installed = staged.body.app, path = `/api/apps/native/app/${installed.id}`;
  const context = await call(`${path}/context?app_version_id=${installed.version_id}`); assert.equal(context.status, 200, JSON.stringify(context.body));
  const request = context.body.review_request, review = await call(`${path}/review`, request); assert.equal(review.status, 200, JSON.stringify(review.body));
  const activated = await call(`${path}/activate`, { ...request, expected_review_digest: review.body.review_digest, accept_host_policy: true });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const [grant] = await db.select().from(schema.appGrantSnapshots).where(orm.eq(schema.appGrantSnapshots.id, activated.body.grant_snapshot_id));
  const stageBinding = async (name: 'create' | 'cancel') => {
    const staged = await call('/api/apps/native/bindings/stage', { schema_version: 'deft.app_native_binding_stage.v1', installation_id: installed.id,
      action_key: `${name}_event`, target: { schema_version: 'deft.app_native_target.v1', provider_kind: 'native', adapter_contract_version: 'deft.native.calendar.v1',
        operation_name: `calendar.events.${name}.v1`, calendar_owner_user_id: owner }, expected_app_version_id: installed.version_id,
      expected_package_digest: installed.package_digest, expected_grant_snapshot_digest: grant!.snapshot_digest,
      expected_lifecycle_epoch: activated.body.installation.lifecycle_epoch, expected_grant_epoch: activated.body.installation.grant_epoch });
    assert.equal(staged.status, 200, JSON.stringify(staged.body)); return staged.body;
  };
  const consent = async (binding: any) => {
    const path = `/api/apps/native/bindings/${binding.binding_id}`;
    const context = await call(`${path}/context`, undefined, ownerWeb.accessToken); assert.equal(context.status, 200, JSON.stringify(context.body));
    const request = context.body.review_request, review = await call(`${path}/review`, request, ownerWeb.accessToken);
    assert.equal(review.status, 200, JSON.stringify(review.body));
    const accepted = await call(`${path}/accept`, { ...request, expected_review_digest: review.body.review_digest, accept_host_policy: true }, ownerWeb.accessToken);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body)); return { ...binding, ...accepted.body };
  };
  return { db, schema, ...orm, kit, org, manager, owner, managerWeb, ownerWeb, call, installed, manifest, activated: activated.body, stageBinding, consent };
}
type Harness = Awaited<ReturnType<typeof fixture>>;
const input = { title: 'Literal <script> ☃ native event', start: '2026-10-10T10:00:00Z', end: '2026-10-10T11:00:00Z' };
async function run(h: Harness, binding: any, value: unknown, idempotencyKey = `native-${randomUUID()}`) {
  const response = await h.call(`/api/apps/native/bindings/${binding.binding_id}/invoke`, {
    expected_consent_digest: binding.consent_digest, idempotency_key: idempotencyKey, input: value }, h.ownerWeb.accessToken);
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function approve(h: Harness, runId: string) {
  const [action] = await h.db.select().from(h.schema.agentActions).where(h.and(h.eq(h.schema.agentActions.org_id, h.org), h.eq(h.schema.agentActions.app_run_id, runId)));
  assert.ok(action);
  const denied = await h.call(`/api/agent/actions/${action.id}/approve`, {}, h.managerWeb.accessToken); assert.notEqual(denied.status, 200);
  const approved = await h.call(`/api/agent/actions/${action.id}/approve`, {}, h.ownerWeb.accessToken);
  assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.status, 'approved');
}
async function execute(h: Harness, runId: string) {
  const queues = await import('../src/lib/queues.js');
  const job = await queues.dequeueJob(queues.QUEUE_NAMES.AGENT_JOBS, { orgId: h.org, jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: runId } });
  assert.ok(job); await (await import('../src/workers/index.js'))._processDequeuedJobForTest(queues.QUEUE_NAMES.AGENT_JOBS, job);
  return (await h.db.select().from(h.schema.appRuns).where(h.eq(h.schema.appRuns.id, runId)))[0]!;
}

async function workerProcess() {
  const child = fork(fileURLToPath(new URL('./fixtures/native-calendar-worker-process.ts', import.meta.url)), [],
    { execArgv: ['--import', 'tsx'], cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const messages: string[] = []; let failure: string | undefined;
  child.on('message', (message: { type: string; name?: string }) => {
    if (message.type === 'failed') failure = `worker ${message.name ?? 'error'}`;
    else messages.push(message.type);
  });
  child.on('exit', (code, signal) => { failure ??= `worker exited code=${code ?? 'none'} signal=${signal ?? 'none'}`; });
  const wait = async (type: string) => {
    for (let i = 0; i < 1000; i++) {
      if (messages.includes(type)) return;
      if (failure) assert.fail(failure);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`worker did not report ${type}`);
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  };
  try { await wait('ready'); return { child, wait, stop }; } catch (error) { await stop(); throw error; }
}

test('native separate-process crash before commit leaves no effect and claimed recovery never replays it', { skip: !safe }, async () => {
  const h = await fixture(), create = await h.consent(await h.stageBinding('create'));
  const created = await run(h, create, input); await approve(h, created.id); await execute(h, created.id);
  const output = (await h.call(`/api/app-runs/${created.id}/result`, undefined, h.ownerWeb.accessToken)).body.value.output;
  const cancel = await h.consent(await h.stageBinding('cancel')), child = await workerProcess();
  const cancelled = await run(h, cancel, { create_run_id: created.id, event_ref: output.event_ref }); await approve(h, cancelled.id);
  const { default: pg } = await import('pg'); const blocker = new pg.Client({ connectionString: target }); await blocker.connect();
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM events WHERE org_id=$1 AND id=$2 FOR UPDATE', [h.org, output.event_ref.resource_id]);
    const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
    child.child.send({ org_id: h.org, run_id: cancelled.id }); await child.wait('leased');
    let waited = false;
    for (let i = 0; i < 150; i++) {
      const { rows: [row] } = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid.id]);
      if (row.n) { waited = true; break; } await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(waited, 'separate native worker actually waited on the Calendar row'); await child.stop(); await blocker.query('COMMIT');
    const [attempt] = await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id, cancelled.id)); assert.ok(attempt);
    assert.equal(attempt.state, 'claimed'); assert.equal(attempt.provider_call_started_at, null);
    const runtime = await (await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();
    const runner = runtime.attemptRunner as unknown as { now: () => Date };
    const clock = runner.now; runner.now = () => new Date(attempt.lease_expires_at!.getTime() + 1);
    try { await runtime.attemptRunner.recoverRun(h.org, cancelled.id, attempt.id); } finally { runner.now = clock; }
    const current = await runtime.repository.inspect(h.org, cancelled.id); assert.equal(current?.state, 'failed');
    const [event] = await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.id, output.event_ref.resource_id));
    assert.equal(event!.metadata.status, 'confirmed');
    assert.equal((await h.db.select().from(h.schema.appRunSecretPayloads).where(h.and(h.eq(h.schema.appRunSecretPayloads.run_id, cancelled.id), h.eq(h.schema.appRunSecretPayloads.payload_kind, 'output')))).length, 0);
    const receipts = await runtime.receiptReader.readVerified(h.org, cancelled.id);
    assert.ok(receipts.some(receipt => receipt.receipt_kind === 'attempt_terminal' && receipt.run_state === 'failed'));
    const recoveredEvents = await h.db.select().from(h.schema.appRunEvents).where(h.eq(h.schema.appRunEvents.run_id, cancelled.id));
    assert.ok(recoveredEvents.some(event => event.payload.recovery_reason === 'native_unstarted_claim_expired' && event.payload.provider_call_attempted === false));
    assert.ok(recoveredEvents.every(event => event.event_type !== 'provider_call_started'));
    await runtime.attemptRunner.run(h.org, cancelled.id, attempt.id, 'redelivery');
    assert.equal((await runtime.repository.inspect(h.org, cancelled.id))?.state, 'failed');
    assert.equal((await runtime.receiptReader.readVerified(h.org, cancelled.id)).length, receipts.length);
  } finally { await child.stop(); await blocker.query('ROLLBACK'); await blocker.end(); await observer.end(); }
});

test('native separate-process lost post-commit delivery recovers exact result and one effect without retry', { skip: !safe }, async () => {
  const h = await fixture(), binding = await h.consent(await h.stageBinding('create')), child = await workerProcess();
  const key = `lost-native-${randomUUID()}`, created = await run(h, binding, input, key); await approve(h, created.id);
  try {
    child.child.send({ org_id: h.org, run_id: created.id, hold_after_commit: true }); await child.wait('committed'); await child.stop();
    const before = await h.call(`/api/app-runs/${created.id}/result`, undefined, h.ownerWeb.accessToken); assert.equal(before.status, 200);
    const [attempt] = await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id, created.id)); assert.ok(attempt);
    const runtime = await (await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();
    const receipts = await runtime.receiptReader.readVerified(h.org, created.id);
    await runtime.attemptRunner.run(h.org, created.id, attempt.id, 'redelivery');
    assert.equal((await run(h, binding, input, key)).id, created.id);
    const recovered = await h.call(`/api/app-runs/${created.id}/result`, undefined, h.ownerWeb.accessToken);
    assert.equal(recovered.status, 200); assert.deepEqual(recovered.body, before.body);
    assert.deepEqual(await runtime.receiptReader.readVerified(h.org, created.id), receipts);
    assert.equal((await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.user_id, h.owner))).length, 1);
    assert.equal((await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id, created.id))).length, 1);
  } finally { await child.stop(); }
});

test('native retained output is unavailable to generic Defty Run-result ingress and web responses are uncached', { skip: !safe }, async () => {
  const h = await fixture(), binding = await h.consent(await h.stageBinding('create')), created = await run(h, binding, input);
  await approve(h, created.id); await execute(h, created.id);
  const { deftyModuleActor } = await import('../src/lib/module-service.js');
  const { executeAppActionOperation } = await import('../src/lib/app-action-operations.js');
  const caller = { actor: deftyModuleActor({ orgId: h.org, userId: h.owner, role: 'member' }) };
  await assert.rejects(executeAppActionOperation(caller, 'app_run_get', { run_id: created.id, include_result: true }),
    (error: any) => error.code === 'APP_RUN_ACCESS_DENIED');
  const owner = await h.call(`/api/app-runs/${created.id}/result`, undefined, h.ownerWeb.accessToken);
  assert.equal(owner.status, 200); assert.equal(owner.cache, 'no-store');
  const denied = await h.call(`/api/app-runs/${created.id}/result`);
  assert.notEqual(denied.status, 200); assert.equal(denied.cache, 'no-store');
});

test('native real COMMIT acknowledgement loss returns transport uncertainty and redelivery retains one exact effect', { skip: !safe }, async () => {
  const h = await fixture(), binding = await h.consent(await h.stageBinding('create')), created = await run(h, binding, input);
  await approve(h, created.id);
  const [attempt] = await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id, created.id)); assert.ok(attempt);
  const runtime = await (await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();
  const { default: pg } = await import('pg');
  const prototype = pg.Client.prototype as unknown as { query: (...args: any[]) => any };
  const original = prototype.query; let committed = false, armed = true;
  prototype.query = function(this: { connectionParameters?: { application_name?: string } }, ...args: any[]) {
    const command = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const result = original.apply(this, args);
    if (armed && this.connectionParameters?.application_name === 'deft-app-native-calendar' && command?.toLowerCase() === 'commit') {
      armed = false;
      // Only the delivery is lost: PostgreSQL's real COMMIT finishes first.
      return Promise.resolve(result).then(() => { committed = true; throw new Error('synthetic native COMMIT acknowledgement lost'); });
    }
    return result;
  };
  try {
    // The ORM may surface its failed cleanup on the discarded socket rather
    // than the original lost acknowledgement. Either is transport uncertainty.
    await assert.rejects(runtime.attemptRunner.run(h.org, created.id, attempt.id, 'commit-ack-loss'), (error: unknown) => error instanceof Error);
    assert.ok(committed, 'real native database commit completed before the response was lost');
  } finally { prototype.query = original; }
  const before = await h.call(`/api/app-runs/${created.id}/result`, undefined, h.ownerWeb.accessToken); assert.equal(before.status, 200);
  const receipts = await runtime.receiptReader.readVerified(h.org, created.id);
  assert.equal((await runtime.attemptRunner.run(h.org, created.id, attempt.id, 'redelivery')).state, 'succeeded');
  const after = await h.call(`/api/app-runs/${created.id}/result`, undefined, h.ownerWeb.accessToken);
  assert.deepEqual(after.body, before.body); assert.deepEqual(await runtime.receiptReader.readVerified(h.org, created.id), receipts);
  assert.equal((await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.user_id, h.owner))).length, 1);
  assert.equal((await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id, created.id))).length, 1);
});

test('native same6 widening upgrade drains old work, refreshes review, revokes old consent and recovers exact activation', { skip: !safe }, async () => {
  const h = await fixture(), binding = await h.consent(await h.stageBinding('create')), old = await run(h, binding, input);
  const manifest = { ...h.manifest, version: '1.1.0', native_actions: [...h.manifest.native_actions,
    { key: 'create_second_event', label: 'Additional explicitly reviewed Calendar action', capability_key: 'calendar_create', operation: 'calendar.events.create.v1' }] };
  const pkg = await h.kit.buildDeftAppPackage({ manifest, artifacts: [] });
  const path = `/api/apps/native/app/${h.installed.id}/upgrade`;
  const staged = await h.call(`${path}/stage`, { schema_version: 'deft.app_native_upgrade_stage.v1', package_json: pkg.json,
    expected_lifecycle_epoch: h.activated.installation.lifecycle_epoch }); assert.equal(staged.status, 200, JSON.stringify(staged.body));
  const targetId = staged.body.app_version_id;
  const context = await h.call(`${path}/context?app_version_id=${targetId}`); assert.equal(context.status, 200, JSON.stringify(context.body));
  const request = context.body.review_request;
  const review = await h.call(`${path}/review`, request); assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.blockers.old_work.pending_approval, 1); assert.equal(review.body.authority_carry_forward, false);
  assert.equal(review.body.fresh_native_binding_consent_required, true);
  assert.equal(review.body.target_authority.native_actions.length, 3);
  const activation = { ...request, expected_review_digest: review.body.review_digest, accept_host_policy: true };
  const blocked = await h.call(`${path}/activate`, activation); assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'APP_UPGRADE_BLOCKED');
  const [prior] = await h.db.select().from(h.schema.appInstallations).where(h.eq(h.schema.appInstallations.id, h.installed.id));
  assert.equal(prior!.active_version_id, h.installed.version_id); assert.equal(prior!.active_grant_snapshot_id, h.activated.grant_snapshot_id);
  await approve(h, old.id); assert.equal((await execute(h, old.id)).state, 'succeeded');
  const oldOutput = await h.call(`/api/app-runs/${old.id}/result`, undefined, h.ownerWeb.accessToken); assert.equal(oldOutput.status, 200);
  assert.equal((await h.call(`${path}/activate`, activation)).status, 409, 'changed drain state requires refreshed explicit review');
  const refreshed = await h.call(`${path}/review`, request); assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.notEqual(refreshed.body.review_digest, review.body.review_digest); assert.deepEqual(refreshed.body.blockers.old_work, {});
  const { resourceSyncWebAuthority } = await import('../src/lib/app-resource-sync-web-authority.js');
  const { actor, guard } = await resourceSyncWebAuthority(`Bearer ${h.managerWeb.accessToken}`);
  const { activateNativeUpgrade } = await import('../src/lib/app-runtime-upgrade.js');
  const freshActivation = { ...request, expected_review_digest: refreshed.body.review_digest, accept_host_policy: true };
  await assert.rejects(activateNativeUpgrade(actor, h.installed.id, freshActivation, { guard, testHooks: { failBeforePointerSwap: true } }));
  const [rolledBack] = await h.db.select().from(h.schema.appInstallations).where(h.eq(h.schema.appInstallations.id, h.installed.id));
  assert.equal(rolledBack!.active_version_id, h.installed.version_id); assert.equal(rolledBack!.active_grant_snapshot_id, h.activated.grant_snapshot_id);
  const [liveConsent] = await h.db.select().from(h.schema.appNativeBindings).where(h.eq(h.schema.appNativeBindings.id, binding.binding_id));
  assert.equal(liveConsent!.state, 'active');
  const activated = await h.call(`${path}/activate`, freshActivation); assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const recovered = await h.call(`${path}/context?app_version_id=${targetId}`); assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.review_request, null);
  assert.deepEqual(recovered.body.current_activation, { grant_snapshot_id: activated.body.grant_snapshot_id, review_digest: refreshed.body.review_digest });
  const [revoked] = await h.db.select().from(h.schema.appNativeBindings).where(h.eq(h.schema.appNativeBindings.id, binding.binding_id)); assert.equal(revoked!.state, 'revoked');
  assert.equal((await h.db.select().from(h.schema.appNativeBindings).where(h.eq(h.schema.appNativeBindings.app_version_id, targetId))).length, 0);
  assert.notEqual((await h.call(`/api/apps/native/bindings/${binding.binding_id}/invoke`, { expected_consent_digest: binding.consent_digest,
    idempotency_key: `old-consent-${randomUUID()}`, input }, h.ownerWeb.accessToken)).status, 200);
  const [retained] = await h.db.select().from(h.schema.appRuns).where(h.eq(h.schema.appRuns.id, old.id));
  assert.equal(retained!.origin_app_version_id, h.installed.version_id); assert.equal(retained!.state, 'succeeded');
  assert.equal((await h.db.select().from(h.schema.appRunSecretPayloads).where(h.and(h.eq(h.schema.appRunSecretPayloads.run_id, old.id), h.eq(h.schema.appRunSecretPayloads.payload_kind, 'output')))).length, 1);
  assert.equal((await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.user_id, h.owner))).length, 1);
});

test('native Calendar two-human consent and normal owner approval create one retained signed event', { skip: !safe }, async () => {
  const h = await fixture(), proposal = await h.stageBinding('create');
  assert.equal((await h.call(`/api/apps/native/bindings/${proposal.binding_id}/context`)).status, 403);
  const preconsent = await h.call(`/api/apps/native/bindings/${proposal.binding_id}/invoke`, { expected_consent_digest: proposal.proposal_digest,
    idempotency_key: `unconsented-${randomUUID()}`, input }, h.ownerWeb.accessToken); assert.notEqual(preconsent.status, 200);
  const binding = await h.consent(proposal), created = await run(h, binding, input);
  const review = await h.call(`/api/apps/native/runs/${created.id}/review`, undefined, h.ownerWeb.accessToken);
  assert.equal(review.status, 200, JSON.stringify(review.body)); assert.deepEqual(review.body.input, input);
  await approve(h, created.id); assert.equal((await execute(h, created.id)).state, 'succeeded');
  const result = await h.call(`/api/app-runs/${created.id}/result`, undefined, h.ownerWeb.accessToken); assert.equal(result.status, 200, JSON.stringify(result.body));
  const output = result.body.value.output; assert.equal(output.status, 'created');
  assert.notEqual((await h.call(`/api/app-runs/${created.id}/result`)).status, 200);
  const ref = encodeURIComponent(JSON.stringify(output.event_ref)); assert.equal((await h.call(`/api/resources/resolve?ref=${ref}`, undefined, h.ownerWeb.accessToken)).status, 200);
  assert.equal((await h.call(`/api/resources/resolve?ref=${ref}`)).body.state, 'unavailable');
  const receipts = await (await (await import('../src/lib/app-run-runtime.js')).getAppRunRuntime()).receiptReader.readVerified(h.org, created.id);
  assert.ok(receipts.some(receipt => receipt.receipt_kind === 'attempt_terminal' && receipt.run_state === 'succeeded'));
  assert.equal((await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.user_id, h.owner))).length, 1);
});

test('native cancel owner kind withdrawal during actual Calendar row wait rolls back effect and terminal receipt', { skip: !safe }, async () => {
  const h = await fixture(), createBinding = await h.consent(await h.stageBinding('create'));
  const created = await run(h, createBinding, input); await approve(h, created.id); assert.equal((await execute(h, created.id)).state, 'succeeded');
  const output = (await h.call(`/api/app-runs/${created.id}/result`, undefined, h.ownerWeb.accessToken)).body.value.output;
  const cancelBinding = await h.consent(await h.stageBinding('cancel'));
  const cancelled = await run(h, cancelBinding, { create_run_id: created.id, event_ref: output.event_ref }); await approve(h, cancelled.id);
  const { default: pg } = await import('pg'); const blocker = new pg.Client({ connectionString: target }); await blocker.connect();
  const observer = new pg.Client({ connectionString: target }); await observer.connect(); let pending: ReturnType<typeof execute> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM events WHERE org_id=$1 AND id=$2 FOR UPDATE', [h.org, output.event_ref.resource_id]);
    const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id'); pending = execute(h, cancelled.id);
    let waited = false;
    for (let i = 0; i < 100; i++) { const { rows: [row] } = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid.id]);
      if (row.n) { waited = true; break; } await new Promise(resolve => setTimeout(resolve, 2)); }
    assert.ok(waited, 'real Calendar event row wait must be observed');
    await observer.query('UPDATE users SET is_agent=true WHERE id=$1', [h.owner]); await blocker.query('COMMIT');
    const state = await pending; assert.notEqual(state.state, 'succeeded');
    const [event] = await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.id, output.event_ref.resource_id));
    assert.equal((event!.metadata as any).status, 'confirmed');
    const terminal = await h.db.select().from(h.schema.appRunReceipts).where(h.and(h.eq(h.schema.appRunReceipts.run_id, cancelled.id), h.eq(h.schema.appRunReceipts.receipt_kind, 'attempt_terminal')));
    assert.equal(terminal.length, 0);
    const outputPayloads = await h.db.select().from(h.schema.appRunSecretPayloads).where(h.and(h.eq(h.schema.appRunSecretPayloads.run_id, cancelled.id), h.eq(h.schema.appRunSecretPayloads.payload_kind, 'output')));
    assert.equal(outputPayloads.length, 0);
  } finally { await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await blocker.end(); await observer.end(); }
});

test('mixed protocol6 reviewed native and private sync planes remain independently usable', { skip: !safe }, async () => {
  const runtimeActionsGate = process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED;
  process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = 'false';
  try {
  const h = await fixture({ sync: true, experience: true, search: true }), native = await h.consent(await h.stageBinding('create'));
  const runtime = await (await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();
  const { AppResourceSyncManagement } = await import('../src/lib/app-resource-sync-management.js');
  const { humanModuleActor } = await import('../src/lib/module-service.js');
  const owner = humanModuleActor({ orgId: h.org, userId: h.manager, role: 'owner', source: 'rest' });
  const operator = humanModuleActor({ orgId: h.org, userId: h.owner, role: 'member', source: 'rest' });
  const [grant] = await h.db.select().from(h.schema.appGrantSnapshots).where(h.eq(h.schema.appGrantSnapshots.id, h.activated.grant_snapshot_id)); assert.ok(grant);
  const management = new AppResourceSyncManagement(runtime.keys, () => new Date());
  const request = { installation_id: h.installed.id, resource_key: 'inbox', operator_user_id: h.owner,
    expected_app_version_id: h.installed.version_id, expected_package_digest: h.installed.package_digest,
    expected_grant_snapshot_digest: grant.snapshot_digest, expected_lifecycle_epoch: h.activated.installation.lifecycle_epoch,
    expected_grant_epoch: h.activated.installation.grant_epoch, consent_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    limits: { max_records_per_page: 100, max_page_bytes: 524_288, max_retained_records: 100_000, max_retained_bytes: 1_073_741_824, min_interval_seconds: 60 } };
  const review = await management.prepareConsent(owner, request);
  const consent = await management.activateConsent(owner, { ...request, expected_review_digest: review.review_digest, accept_host_policy: true });
  const credential = await management.issueOperatorSession(operator, consent.binding_id);
  assert.equal((await runtime.resourceSyncAdmission.admitDue({ org_id: h.org, resource_binding_id: consent.binding_id })).state, 'created');
  const identity = { schema_version: 'deft.app_runtime_channel.v2' as const, audience: 'app_resource_sync' as const,
    session_id: credential.session_id, session_token: credential.session_token };
  const claim = await runtime.resourceSyncChannel.claim({ ...identity, max_claims: 1 }); assert.ok(claim);
  const attempt = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
  assert.ok(await runtime.resourceSyncChannel.start(attempt));
  assert.ok(await runtime.resourceSyncChannel.complete({ ...attempt, status: 'returned', provider_succeeded: true,
    page: { schema_version: 'deft.app_sync_page.v1', upserts: [{ id: 'provider-private', revision: 'r1', data: { subject: 'Mixed private saved record' } }],
      tombstones: [], next_cursor: null, has_more: false } }));
  const page = await h.call(`/api/private-resources/bindings/${consent.binding_id}/records?limit=10`);
  assert.equal(page.status, 200, JSON.stringify(page.body)); assert.equal(page.body.items.length, 1);
  assert.equal(page.body.items[0].data.subject, 'Mixed private saved record');
  assert.notEqual((await h.call(`/api/private-resources/bindings/${consent.binding_id}/records?limit=10`, undefined, h.ownerWeb.accessToken)).status, 200);
  const session = await h.call(`/api/app-experiences/${h.installed.id}/main/sessions`, {});
  assert.equal(session.status, 200, JSON.stringify(session.body));
  const experiencePath = `/api/app-experiences/sessions/${session.body.pin.session_id}`;
  const listRequest = { schema_version: 'deft.experience_resource_request.v1', operation: 'list_summary' };
  const searchRequest = { schema_version: 'deft.experience_resource_request.v2', operation: 'search', query: 'Mixed', field_keys: ['subject'] };
  assert.equal((await h.call(`${experiencePath}/resources/inbox`, listRequest)).status, 404);
  assert.equal((await h.call(`${experiencePath}/resources/inbox`, searchRequest)).status, 404);
  const exposureReview = await h.call(`${experiencePath}/exposure/review`, {});
  assert.equal(exposureReview.status, 200, JSON.stringify(exposureReview.body));
  assert.equal(exposureReview.body.snapshot.schema_version, 'deft.experience_resource_exposure.v2');
  assert.deepEqual(exposureReview.body.snapshot.resources[0].allowed_operations, ['list_summary', 'read_one', 'search']);
  const exposureAccept = await h.call(`${experiencePath}/exposure/accept`, {
    review_token: exposureReview.body.review_token, review_digest: exposureReview.body.review_digest, accept_exposure: true });
  assert.equal(exposureAccept.status, 200, JSON.stringify(exposureAccept.body));
  const summaries = await h.call(`${experiencePath}/resources/inbox`, listRequest);
  assert.equal(summaries.status, 200, JSON.stringify(summaries.body)); assert.equal(summaries.cache, 'no-store');
  assert.equal(summaries.body.output.items.length, 1);
  const exposedRead = await h.call(`${experiencePath}/resources/inbox`, { schema_version: 'deft.experience_resource_request.v1',
    operation: 'read_one', record_id: summaries.body.output.items[0].record_id });
  assert.equal(exposedRead.status, 200, JSON.stringify(exposedRead.body));
  assert.equal(exposedRead.body.output.item.data.subject, 'Mixed private saved record');
  const searched = await h.call(`${experiencePath}/resources/inbox`, searchRequest);
  assert.equal(searched.status, 200, JSON.stringify(searched.body));
  assert.equal(searched.body.output.items.length, 1); assert.equal(searched.body.output.items[0].label, 'Mixed private saved record');
  assert.equal((await h.call(`${experiencePath}/resources/inbox`, searchRequest, h.ownerWeb.accessToken)).status, 404);
  const [webSession] = await h.db.select().from(h.schema.webSessions).where(h.eq(h.schema.webSessions.user_id, h.manager)); assert.ok(webSession);
  const { default: pg } = await import('pg');
  const blocker = new pg.Client({ connectionString: target }), observer = new pg.Client({ connectionString: target });
  await blocker.connect(); await observer.connect(); let pending: ReturnType<Harness['call']> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [webSession.id]);
    const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
    pending = h.call(`${experiencePath}/resources/inbox`, searchRequest);
    let waited = false;
    for (let i = 0; i < 300; i++) {
      const { rows: [row] } = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid.id]);
      if (row.n) { waited = true; break; } await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(waited, 'native exposure actually waited on exact owner SID');
    process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'false'; await blocker.query('COMMIT');
    const denied = await pending; assert.equal(denied.status, 404); assert.equal(denied.cache, 'no-store');
    assert.ok(!JSON.stringify(denied.body).includes('Mixed private saved record'));
  } finally {
    process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'true';
    await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await blocker.end(); await observer.end();
  }
  const created = await run(h, native, input); await approve(h, created.id); assert.equal((await execute(h, created.id)).state, 'succeeded');
  assert.equal((await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.user_id, h.owner))).length, 1);
  } finally { process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = runtimeActionsGate; }
});

test('native cancel exact retained create identity settles once and exact invocation replay returns the original Run', { skip: !safe }, async () => {
  const h = await fixture(), createBinding = await h.consent(await h.stageBinding('create'));
  const created = await run(h, createBinding, input); await approve(h, created.id); await execute(h, created.id);
  const output = (await h.call(`/api/app-runs/${created.id}/result`, undefined, h.ownerWeb.accessToken)).body.value.output;
  const cancelBinding = await h.consent(await h.stageBinding('cancel')), key = `native-cancel-${randomUUID()}`;
  const value = { create_run_id: created.id, event_ref: output.event_ref };
  const cancelled = await run(h, cancelBinding, value, key); await approve(h, cancelled.id);
  assert.equal((await execute(h, cancelled.id)).state, 'succeeded');
  const result = await h.call(`/api/app-runs/${cancelled.id}/result`, undefined, h.ownerWeb.accessToken);
  assert.equal(result.status, 200); assert.equal(result.body.value.output.status, 'cancelled');
  assert.deepEqual(result.body.value.output.event_ref, output.event_ref);
  const replay = await run(h, cancelBinding, value, key); assert.equal(replay.id, cancelled.id);
  const [event] = await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.id, output.event_ref.resource_id));
  assert.equal((event!.metadata as any).status, 'canceled');
  assert.equal((await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.user_id, h.owner))).length, 1);
  const receipts = await (await (await import('../src/lib/app-run-runtime.js')).getAppRunRuntime()).receiptReader.readVerified(h.org, cancelled.id);
  assert.equal(receipts.filter(row => row.receipt_kind === 'attempt_terminal' && row.run_state === 'succeeded').length, 1);
});

test('native cancel substituted unrelated create reference cannot mutate either event or sign terminal success', { skip: !safe }, async () => {
  const h = await fixture(), createBinding = await h.consent(await h.stageBinding('create'));
  const first = await run(h, createBinding, input), second = await run(h, createBinding, { ...input, title: 'Separate identity' });
  await approve(h, first.id); await execute(h, first.id); await approve(h, second.id); await execute(h, second.id);
  const firstOutput = (await h.call(`/api/app-runs/${first.id}/result`, undefined, h.ownerWeb.accessToken)).body.value.output;
  const secondOutput = (await h.call(`/api/app-runs/${second.id}/result`, undefined, h.ownerWeb.accessToken)).body.value.output;
  const binding = await h.consent(await h.stageBinding('cancel'));
  const cancelled = await run(h, binding, { create_run_id: first.id, event_ref: secondOutput.event_ref }); await approve(h, cancelled.id);
  assert.notEqual((await execute(h, cancelled.id)).state, 'succeeded');
  for (const ref of [firstOutput.event_ref, secondOutput.event_ref]) {
    const [event] = await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.id, ref.resource_id));
    assert.equal((event!.metadata as any).status, 'confirmed');
  }
  assert.equal((await h.db.select().from(h.schema.appRunReceipts).where(h.and(h.eq(h.schema.appRunReceipts.run_id, cancelled.id), h.eq(h.schema.appRunReceipts.receipt_kind, 'attempt_terminal')))).length, 0);
  assert.equal((await h.db.select().from(h.schema.appRunSecretPayloads).where(h.and(h.eq(h.schema.appRunSecretPayloads.run_id, cancelled.id), h.eq(h.schema.appRunSecretPayloads.payload_kind, 'output')))).length, 0);
});

test('native approval manager kind withdrawal during final owner SID wait rolls back approval and scheduling', { skip: !safe }, async () => {
  const h = await fixture(), binding = await h.consent(await h.stageBinding('create'));
  const created = await run(h, binding, input);
  const [action] = await h.db.select().from(h.schema.agentActions).where(h.eq(h.schema.agentActions.app_run_id, created.id));
  assert.ok(action);
  const [session] = await h.db.select().from(h.schema.webSessions).where(h.eq(h.schema.webSessions.user_id, h.owner));
  assert.ok(session);
  const { default: pg } = await import('pg'); const blocker = new pg.Client({ connectionString: target }); await blocker.connect();
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  let pending: ReturnType<Harness['call']> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [session.id]);
    const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
    pending = h.call(`/api/agent/actions/${action.id}/approve`, {}, h.ownerWeb.accessToken);
    let waited = false;
    for (let i = 0; i < 300; i++) {
      const { rows: [row] } = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid.id]);
      if (row.n) { waited = true; break; } await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(waited, 'real final owner SID row wait must be observed');
    await observer.query('UPDATE users SET is_agent=true WHERE id=$1', [h.manager]); await blocker.query('COMMIT');
    assert.notEqual((await pending).status, 200);
    const [current] = await h.db.select().from(h.schema.appRuns).where(h.eq(h.schema.appRuns.id, created.id));
    assert.equal(current!.state, 'pending_approval'); assert.equal(current!.execution_released_at, null);
    const [approval] = await h.db.select().from(h.schema.agentActions).where(h.eq(h.schema.agentActions.id, action.id));
    assert.equal(approval!.approval_status, 'pending');
    assert.equal((await h.db.select().from(h.schema.appRunReceipts).where(h.eq(h.schema.appRunReceipts.run_id, created.id))).length, 0);
    assert.equal((await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id, created.id))).length, 0);
  } finally { await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await blocker.end(); await observer.end(); }
});

test('native invocation manager kind withdrawal during final owner SID wait commits no Run or approval', { skip: !safe }, async () => {
  const h = await fixture(), binding = await h.consent(await h.stageBinding('create'));
  const [session] = await h.db.select().from(h.schema.webSessions).where(h.eq(h.schema.webSessions.user_id, h.owner)); assert.ok(session);
  const { default: pg } = await import('pg'); const blocker = new pg.Client({ connectionString: target }); await blocker.connect();
  const observer = new pg.Client({ connectionString: target }); await observer.connect(); let pending: ReturnType<Harness['call']> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [session.id]);
    const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
    pending = h.call(`/api/apps/native/bindings/${binding.binding_id}/invoke`, {
      expected_consent_digest: binding.consent_digest, idempotency_key: `held-sid-${randomUUID()}`, input }, h.ownerWeb.accessToken);
    let waited = false;
    for (let i = 0; i < 300; i++) {
      const { rows: [row] } = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid.id]);
      if (row.n) { waited = true; break; } await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(waited, 'real final invocation SID row wait must be observed');
    await observer.query('UPDATE users SET is_agent=true WHERE id=$1', [h.manager]); await blocker.query('COMMIT');
    assert.notEqual((await pending).status, 200);
    assert.equal((await h.db.select().from(h.schema.appRuns).where(h.eq(h.schema.appRuns.org_id, h.org))).length, 0);
    assert.equal((await h.db.select().from(h.schema.agentActions).where(h.eq(h.schema.agentActions.org_id, h.org))).length, 0);
  } finally { await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await blocker.end(); await observer.end(); }
});

test('native exact-input review manager kind withdrawal during final SID wait discloses no retained input', { skip: !safe }, async () => {
  const h = await fixture(), binding = await h.consent(await h.stageBinding('create')), created = await run(h, binding, input);
  const [session] = await h.db.select().from(h.schema.webSessions).where(h.eq(h.schema.webSessions.user_id, h.owner)); assert.ok(session);
  const { default: pg } = await import('pg'); const blocker = new pg.Client({ connectionString: target }); await blocker.connect();
  const observer = new pg.Client({ connectionString: target }); await observer.connect(); let pending: ReturnType<Harness['call']> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [session.id]);
    const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
    pending = h.call(`/api/apps/native/runs/${created.id}/review`, undefined, h.ownerWeb.accessToken);
    let waited = false;
    for (let i = 0; i < 300; i++) {
      const { rows: [row] } = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid.id]);
      if (row.n) { waited = true; break; } await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(waited, 'real final input review SID wait must be observed');
    await observer.query('UPDATE users SET is_agent=true WHERE id=$1', [h.manager]); await blocker.query('COMMIT');
    const response = await pending; assert.notEqual(response.status, 200); assert.equal(response.body.input, undefined);
  } finally { await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await blocker.end(); await observer.end(); }
});

test('native retained-result manager kind withdrawal during actual output wait discloses no retained result', { skip: !safe }, async () => {
  const h = await fixture(), binding = await h.consent(await h.stageBinding('create')), created = await run(h, binding, input);
  await approve(h, created.id); await execute(h, created.id);
  const { default: pg } = await import('pg'); const blocker = new pg.Client({ connectionString: target }); await blocker.connect();
  const observer = new pg.Client({ connectionString: target }); await observer.connect(); let pending: ReturnType<Harness['call']> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('LOCK TABLE app_run_secret_payloads IN ACCESS EXCLUSIVE MODE');
    const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
    pending = h.call(`/api/app-runs/${created.id}/result`, undefined, h.ownerWeb.accessToken);
    let waited = false;
    for (let i = 0; i < 300; i++) {
      const { rows: [row] } = await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%app_run_secret_payloads%'", [pid.id]);
      if (row.n) { waited = true; break; } await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(waited, 'real retained output query wait must be observed');
    await observer.query('UPDATE users SET is_agent=true WHERE id=$1', [h.manager]); await blocker.query('COMMIT');
    const response = await pending; assert.notEqual(response.status, 200); assert.equal(response.body.value, undefined);
    assert.equal((await h.db.select().from(h.schema.events).where(h.eq(h.schema.events.user_id, h.owner))).length, 1);
  } finally { await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await blocker.end(); await observer.end(); }
});

test('native final human read wait preserves exact executed SID deadline under a local injected clock', { skip: !safe }, async () => {
  const h = await fixture(), binding = await h.consent(await h.stageBinding('create'));
  const { guard } = await (await import('../src/lib/app-resource-sync-web-authority.js')).resourceSyncWebAuthority(`Bearer ${h.ownerWeb.accessToken}`);
  const { loadLiveNativeAuthority } = await import('../src/lib/app-native-authority.js');
  const { nativeFinalAuthorityIsCurrent } = await import('../src/lib/app-native-final-authority.js');
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  await h.db.transaction(async tx => {
    const authority = await loadLiveNativeAuthority(tx, { org_id: h.org, native_binding_id: binding.binding_id });
    let localNow = new Date();
    // Delay only the final complete-human query. The executed real SID guard
    // and the actual SQL read are unchanged; no process/global clock changes.
    const delayed = new Proxy(tx, { get(target, property, receiver) {
      if (property !== 'select') return Reflect.get(target, property, receiver);
      return (fields: Record<string, unknown>) => {
        const builder = target.select(fields as any);
        if (!('is_agent' in fields)) return builder;
        return { from(table: any) { const selected = builder.from(table); return { async where(predicate: any) {
          enter(); await released; return selected.where(predicate);
        } }; } };
      };
    } });
    const pending = nativeFinalAuthorityIsCurrent(delayed, authority.participants, { guard, clock: () => localNow });
    await entered;
    localNow = new Date(guard.current_web_session_expires_at().getTime() + 1); release();
    assert.equal(await pending, false);
    assert.equal((await h.db.select().from(h.schema.appRuns).where(h.eq(h.schema.appRuns.org_id, h.org))).length, 0);
  });
});

test('native App stage manager kind withdrawal during final SID wait rolls back all staged authority', { skip: !safe }, async () => {
  const h = await fixture();
  const manifest = { ...h.manifest, id: `community.example.native.stage${randomUUID().replaceAll('-', '')}` };
  const pkg = await h.kit.buildDeftAppPackage({ manifest, artifacts: [] });
  const [session] = await h.db.select().from(h.schema.webSessions).where(h.eq(h.schema.webSessions.user_id, h.manager)); assert.ok(session);
  const { default: pg } = await import('pg'); const blocker = new pg.Client({ connectionString: target }); await blocker.connect();
  const observer = new pg.Client({ connectionString: target }); await observer.connect(); let pending: ReturnType<Harness['call']> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [session.id]);
    const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
    pending = h.call('/api/apps/stage', JSON.parse(pkg.json));
    let waited = false;
    for (let i = 0; i < 300; i++) {
      const { rows: [row] } = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid.id]);
      if (row.n) { waited = true; break; } await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(waited, 'real final staging SID row wait must be observed');
    await observer.query('UPDATE users SET is_agent=true WHERE id=$1', [h.manager]); await blocker.query('COMMIT');
    assert.notEqual((await pending).status, 201);
    assert.equal((await h.db.select().from(h.schema.appInstallations).where(h.and(h.eq(h.schema.appInstallations.org_id, h.org), h.eq(h.schema.appInstallations.app_id, manifest.id)))).length, 0);
  } finally { await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await blocker.end(); await observer.end(); }
});

test('native Experience action retains the verified session deadline through its final Run guard', { skip: !safe }, async () => {
  const h = await fixture({ experience: true }), binding = await h.consent(await h.stageBinding('create'));
  const opened = await h.call(`/api/app-experiences/${h.installed.id}/main/sessions`, {}, h.ownerWeb.accessToken);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const sessionId = opened.body.pin.session_id;
  const [web] = await h.db.select().from(h.schema.webSessions).where(h.eq(h.schema.webSessions.user_id, h.owner)); assert.ok(web);
  const owner = await (await import('../src/lib/web-sessions.js')).verifyWebAccess(h.ownerWeb.accessToken);
  const expected = Math.min(web.expires_at.getTime(), new Date(opened.body.expires_at).getTime(), owner.exp * 1000);
  const runtime = await (await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();
  const original = runtime.service.submitReviewedNative;
  let observed = false;
  // Inspect the actual adapter metadata around its real DB guard; admission,
  // capsule writes, authority checks and final fence still execute normally.
  runtime.service.submitReviewedNative = async function(caller, request, guard) {
    const metadata = guard as typeof guard & { current_web_session_expires_at?: () => Date };
    assert.ok(metadata?.current_web_session_expires_at);
    assert.equal(metadata.current_web_session_expires_at().getTime(), 0);
    const checked = Object.assign(async (tx: Parameters<NonNullable<typeof guard>>[0]) => {
      await guard!(tx); observed = true;
      assert.equal(metadata.current_web_session_expires_at!().getTime(), expected);
    }, { current_web_session_expires_at: metadata.current_web_session_expires_at });
    return original.call(this, caller, request, checked);
  };
  try {
    const admitted = await h.call(`/api/app-experiences/sessions/${sessionId}/actions/create_event`, { request_id: 'request_1', input }, h.ownerWeb.accessToken);
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body)); assert.ok(observed);
    const [persisted] = await h.db.select().from(h.schema.appRuns).where(h.and(h.eq(h.schema.appRuns.org_id, h.org), h.eq(h.schema.appRuns.id, admitted.body.run.id)));
    assert.equal(persisted!.origin_native_binding_id, binding.binding_id);
    const review = await h.call(`/api/apps/native/runs/${admitted.body.run.id}/review`, undefined, h.ownerWeb.accessToken);
    assert.equal(review.status, 200, JSON.stringify(review.body)); assert.deepEqual(review.body.input, input);
  } finally { runtime.service.submitReviewedNative = original; }
});
