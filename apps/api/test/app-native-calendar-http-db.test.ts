import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { ServerType } from '@hono/node-server';
const target = process.env.DATABASE_URL ?? '';
const safe = /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c14_native_calendar_test(?:_v[0-9]+)?$/.test(target)
  && process.env.DEFT_TEST_DATABASE_URL === target;
Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
  DEFT_APP_NATIVE_CALENDAR_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
  DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true', JWT_SECRET: 'synthetic-native-calendar-only', NODE_ENV: 'test' });
const ring = (key: string) => ({ current: key, keys: { [key]: createHash('sha256').update(`c14-native:${key}`).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('c14-enc'), receipt_signing: ring('c14-sign'), fingerprint: ring('c14-fp') });
let server: ServerType | undefined; let base: string;
after(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  if (safe) { await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime(); await (await import('../src/lib/db.js')).closeDb(); }
});
async function fixture() {
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
    return { status: response.status, body: await response.json() as any };
  };
  const manifest = { schema_version: '6' as const, id: `community.example.native.a${suffix}`, version: '1.0.0', name: 'Native Calendar',
    license: 'AGPL-3.0-only', compatibility: { app_protocol: '6' as const }, modules: [], navigation: [], runtime_requirements: [],
    runtime_actions: [], sync_descriptors: [], experiences: [], public_actions: [],
    private_capabilities: ['create', 'cancel'].map(name => ({ key: `calendar_${name}`, version: '1',
      ...kit.NATIVE_CALENDAR_CONTRACTS[`calendar.events.${name}.v1` as keyof typeof kit.NATIVE_CALENDAR_CONTRACTS] })),
    native_actions: ['create', 'cancel'].map(name => ({ key: `${name}_event`, label: `${name} Calendar event`,
      capability_key: `calendar_${name}`, operation: `calendar.events.${name}.v1` })),
  };
  const pkg = await kit.buildDeftAppPackage({ manifest, artifacts: [] });
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
