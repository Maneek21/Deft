import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c09_experience_action_lock_test(?:_v[0-9]+)?$/.test(target);
async function load() {
  process.env.DEFT_APPS_ENABLED = 'true'; process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true'; process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  const key = (purpose: string) => createHash('sha256').update(`experience-action-lock:${purpose}`).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('enc') } },
    receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('sig') } },
    fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key('fp') } } });
  const [database, schema, kit, appService, review, modules, experience, management, ring, action, runtime, orm] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/module-service.js'), import('../src/lib/app-experience-service.js'),
    import('../src/lib/app-runtime-management.js'), import('./fixtures/app-run-test-keyrings.js'),
    import('../src/lib/app-runtime-action-service.js'), import('../src/lib/app-run-runtime.js'), import('drizzle-orm'),
  ]);
  const keys = await ring.databaseCompleteAppRunTestKeyringFixture('experience-action-lock');
  process.env.DEFT_APP_RUN_KEYRINGS = keys.environment; keys.keys.destroy();
  return { ...database, schema, kit, appService, review, modules, experience, management, action, runtime, ...orm };
}
let host: Awaited<ReturnType<typeof load>>;
before(async () => { if (safe) host = await load(); });
after(async () => { if (safe) { await host.runtime.shutdownAppRunRuntime(); await host.closeDb(); } });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture() {
  const { db, schema, eq, and } = host;
  const suffix = randomUUID().replaceAll('-', ''); const orgId = randomUUID();
  const [operatorId, callerId] = [randomUUID(), randomUUID()].sort(); assert.ok(operatorId && callerId && operatorId < callerId);
  const sid = randomUUID();
  await db.insert(schema.orgs).values({ id: orgId, name: 'Experience lock test', slug: `experience-lock-${suffix}` });
  await db.insert(schema.users).values([
    { id: callerId, name: 'Caller owner', email: `experience-caller-${suffix}@example.test` },
    { id: operatorId, name: 'Earlier operator', email: `experience-operator-${suffix}@example.test` },
  ]);
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), org_id: orgId, user_id: callerId, role: 'owner', is_active: true },
    { id: randomUUID(), org_id: orgId, user_id: operatorId, role: 'member', is_active: true },
  ]);
  await db.insert(schema.webSessions).values({ id: sid, org_id: orgId, user_id: callerId,
    refresh_token_hash: 'synthetic-action-lock', expires_at: new Date(Date.now() + 86_400_000) });
  const actor = host.modules.humanModuleActor({ orgId, userId: callerId, role: 'owner', source: 'rest' });
  const object = { type: 'object' as const, properties: { shipment_id: { type: 'string' as const, maxLength: 120 } },
    required: ['shipment_id'], additionalProperties: false as const };
  const artifact = await host.kit.prepareDeftExperienceArtifact('experiences/main.json', {
    schema_version: 'deft.experience_bundle.v1', worker_source: 'self.onmessage = () => {};',
    entry_view: 'main', resource_keys: [], action_keys: ['create_shipping_label'],
  });
  const pkg = await host.kit.buildDeftAppPackage({ manifest: {
    schema_version: '4', id: `community.example.lock.a${suffix}`, version: '1.0.0', name: 'Lock fixture',
    license: 'AGPL-3.0-only', compatibility: { app_protocol: '4' }, modules: [], navigation: [],
    runtime_requirements: [{ key: 'carrier', protocol_version: 'deft.app_runtime_channel.v1' }],
    private_capabilities: [{ key: 'label', version: '1', input_schema: object, output_schema: object }],
    runtime_actions: [{ key: 'create_shipping_label', label: 'Create shipping label', capability_key: 'label', runtime_requirement_key: 'carrier' }],
    experiences: [{ key: 'main', label: 'Shipping Label', artifact_path: artifact.path, artifact_digest: artifact.digest,
      bridge_version: 'deft.experience_bridge.v1', renderer_version: 'deft.trusted_renderer.v1' }], public_actions: [],
  }, artifacts: [artifact] });
  const staged = await host.appService.stageAppPackage(actor, pkg.json);
  const [version] = await db.select().from(schema.appVersions).where(eq(schema.appVersions.id, staged.version_id)); assert.ok(version?.requested_grant_snapshot_id);
  const [requested] = await db.select().from(schema.appGrantSnapshots).where(eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)); assert.ok(requested);
  const reviewRequest = { app_version_id: version.id, expected_package_digest: version.package_digest,
    expected_requested_snapshot_digest: requested.snapshot_digest, expected_lifecycle_epoch: staged.lifecycle_epoch,
    expected_grant_epoch: staged.grant_epoch };
  const reviewed = await host.review.prepareRuntimeAppReview(actor, staged.id, reviewRequest);
  const active = await host.review.activateRuntimeApp(actor, staged.id, { ...reviewRequest,
    expected_review_digest: reviewed.review_digest, accept_host_policy: true });
  const [effective] = await db.select().from(schema.appGrantSnapshots).where(and(
    eq(schema.appGrantSnapshots.org_id, orgId), eq(schema.appGrantSnapshots.id, active.grant_snapshot_id))); assert.ok(effective);
  const bindRequest = { installation_id: staged.id, action_key: 'create_shipping_label', operator_user_id: operatorId,
    expected_app_version_id: version.id, expected_package_digest: version.package_digest,
    expected_grant_snapshot_digest: effective.snapshot_digest, expected_lifecycle_epoch: active.installation.lifecycle_epoch,
    expected_grant_epoch: active.installation.grant_epoch };
  const bindingReview = await host.management.prepareRuntimeBindingReview(actor, bindRequest);
  const binding = await host.management.activateRuntimeBinding(actor, { ...bindRequest,
    expected_review_digest: bindingReview.review_digest, accept_host_policy: true });
  const caller = { org_id: orgId, user_id: callerId, sid };
  const session = await host.experience.appExperienceService.create(caller, staged.id, 'main');
  return { orgId, operatorId, callerId, actor, caller, session, binding, bindRequest };
}
function guardedService(entered: ReturnType<typeof gate>, resume: ReturnType<typeof gate>) {
  return new host.experience.AppExperienceService(new host.action.AppRuntimeActionService({
    async submitReviewedRuntime(actor, request, admission) {
      return (await host.runtime.getAppRunRuntime()).service.submitReviewedRuntime(actor, request, async tx => {
        entered.release(); await resume.promise; assert.ok(admission); await admission(tx);
      });
    },
    async reviewRuntimeInput(actor, runId) { return (await host.runtime.getAppRunRuntime()).service.reviewRuntimeInput(actor, runId); },
  }));
}
function errors(value: unknown): string {
  if (!(value instanceof Error)) return String(value);
  return `${value.message}${value.cause ? `; ${errors(value.cause)}` : ''}`;
}

test('v4 Experience action and Runtime management share sorted participant locks without deadlock and retain one approval identity', { skip: !safe }, async () => {
  const f = await fixture(); const entered = gate(); const resume = gate();
  const managerHeldOperator = gate(); const releaseManager = gate(); const actionAttemptsOperator = gate();
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  const service = guardedService(entered, resume);
  const actionPromise = service.action(f.caller, f.session.pin.session_id, 'create_shipping_label', {
    request_id: 'request_1', input: { shipment_id: 'lock-proof' },
  });
  // Attach rejection observation before introducing the conflicting transaction.
  const actionResult = actionPromise.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  const original = pg.Client.prototype.query;
  let actionPid = 0; let managementPid = 0; let managerPaused = false;
  const replacement = mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: unknown[]) {
    const raw = args[0]; const text = typeof raw === 'string' ? raw : (raw as { text?: string })?.text ?? '';
    const values = args[1] as unknown[] | undefined;
    const membership = /org_members/i.test(text) && values?.includes(f.operatorId);
    const response = Reflect.apply(original, this, args);
    const result = response instanceof Promise ? response.catch((error: unknown) => {
      const failure = error as { code?: string; message?: string; detail?: string };
      if (failure.code === '40P01') console.log('V4_ACTION_POSTGRES_DEADLOCK', JSON.stringify({
        sqlstate: failure.code, message: failure.message, detail: failure.detail,
      }));
      throw error;
    }) : response;
    if (membership && /for update/i.test(text) && !managerPaused) {
      managerPaused = true; managementPid = (this as pg.Client & { processID: number }).processID;
      return (result as Promise<unknown>).then(async value => {
        managerHeldOperator.release(); await releaseManager.promise; return value;
      });
    }
    if (membership && /for share/i.test(text)) {
      actionPid = (this as pg.Client & { processID: number }).processID;
      actionAttemptsOperator.release();
    }
    return result;
  });
  let managementResult: Promise<{ value: unknown } | { error: unknown }> | undefined;
  try {
    managementResult = host.management.prepareRuntimeBindingReview(f.actor, f.bindRequest)
      .then(value => ({ value }), error => ({ error }));
    await managerHeldOperator.promise; resume.release(); await actionAttemptsOperator.promise;
    let blocked = false;
    for (let attempt = 0; attempt < 250; attempt++) {
      const [row] = (await observer.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [actionPid, managementPid])).rows;
      if (row.blocked) { blocked = true; break; } await delay(20);
    }
    assert.equal(blocked, true, 'the real action transaction waits for the real management operator lock');
    releaseManager.release();
    const [invoked, managed] = await Promise.all([actionResult, managementResult]);
    const failures = [invoked, managed].filter(item => 'error' in item).map(item => errors(item.error));
    console.log('V4_ACTION_LOCK_CONTENTION', JSON.stringify({ operator_before_caller: true,
      action_pid: actionPid, management_pid: managementPid, failures }));
    assert.deepEqual(failures, [], 'both actual governed paths must complete without a deadlock');
    assert.ok('value' in invoked); assert.equal(invoked.value.run.state, 'pending_approval');
    const replay = await host.experience.appExperienceService.action(f.caller, f.session.pin.session_id,
      'create_shipping_label', { request_id: 'request_1', input: { shipment_id: 'lock-proof' } });
    assert.equal(replay.run.id, invoked.value.run.id);
    const runs = (await observer.query('SELECT id,state,origin_runtime_binding_id FROM app_runs WHERE org_id=$1', [f.orgId])).rows;
    const approvals = (await observer.query('SELECT id,app_run_id FROM agent_actions WHERE org_id=$1 AND app_run_id=$2', [f.orgId, replay.run.id])).rows;
    assert.equal(runs.length, 1); assert.equal(runs[0].id, replay.run.id);
    assert.equal(runs[0].state, 'pending_approval'); assert.equal(runs[0].origin_runtime_binding_id, f.binding.binding_id);
    assert.equal(approvals.length, 1); assert.equal(approvals[0].app_run_id, replay.run.id);
    console.log('V4_ACTION_LOCK_IDENTITY', JSON.stringify({ run_id: replay.run.id, approval_id: approvals[0].id }));
  } finally {
    resume.release(); releaseManager.release(); replacement.mock.restore();
    await actionResult; if (managementResult) await managementResult; await observer.end();
  }
});

test('v4 Experience final action admission rejects revoked registration and substituted human without a Run or approval', { skip: !safe }, async () => {
  const f = await fixture(); const entered = gate(); const resume = gate();
  await assert.rejects(host.experience.appExperienceService.action({ ...f.caller, user_id: f.operatorId },
    f.session.pin.session_id, 'create_shipping_label', { request_id: 'request_1', input: { shipment_id: 'wrong-human' } }));
  const pending = guardedService(entered, resume).action(f.caller, f.session.pin.session_id, 'create_shipping_label', {
    request_id: 'request_2', input: { shipment_id: 'revoked-registration' },
  });
  const observed = pending.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  try {
    assert.equal((await host.management.revokeRuntimeRegistration(f.actor, f.binding.registration_id)).revoked, true);
  } finally { resume.release(); }
  const result = await observed; assert.ok('error' in result);
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs WHERE org_id=$1', [f.orgId])).rows[0].count, 0);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM agent_actions WHERE org_id=$1 AND app_run_id IS NOT NULL', [f.orgId])).rows[0].count, 0);
    console.log('V4_ACTION_AUTHORITY_DENIAL', JSON.stringify({ registration_revoked: true, substituted_human_denied: true, runs: 0, approvals: 0 }));
  } finally { await observer.end(); }
});
