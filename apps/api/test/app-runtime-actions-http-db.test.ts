import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runtimeV3PackageJson } from './fixtures/runtime-v3-package.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1' && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_c03_(?:public|root)(?:_v[0-9]+)?$/.test(new URL(target).pathname);

test('authenticated HTTP pairing, packed install, reviews, action and Runtime receipt', { skip: !safe }, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_DEVELOPER_PAIRING_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  const key = (purpose: string) => createHash('sha256').update(`runtime-http:${purpose}`).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
    schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('enc') } },
    receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('sig') } },
    fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key('fp') } },
  });
  const [{ app }, { db, closeDb }, schema, sessionModule, runModule, keyringFixture, serverModule] = await Promise.all([
    import('../src/index.js'), import('../src/lib/db.js'), import('@deft/db/schema'),
    import('../src/lib/web-sessions.js'), import('../src/lib/app-run-runtime.js'),
    import('./fixtures/app-run-test-keyrings.js'), import('@hono/node-server'),
  ]);
  const { and, eq } = await import('drizzle-orm');
  const base = 'http://127.0.0.1:4337';
  let server: ReturnType<typeof serverModule.serve> | undefined;
  let child: ChildProcess | undefined;
  try {
    await new Promise<void>((resolve) => {
      server = serverModule.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4337 }, () => resolve());
    });
    const ring = await keyringFixture.databaseCompleteAppRunTestKeyringFixture('runtime-http');
    process.env.DEFT_APP_RUN_KEYRINGS = ring.environment;
    ring.keys.destroy();
    const suffix = randomUUID();
    const orgId = randomUUID();
    const ownerId = randomUUID();
    const otherId = randomUUID();
    const foreignOrgId = randomUUID();
    const email = `runtime-http-${suffix}@example.test`;
    await db.insert(schema.orgs).values({ id: orgId, name: 'Runtime HTTP journey', slug: `runtime-http-${suffix}` });
    await db.insert(schema.orgs).values({ id: foreignOrgId, name: 'Foreign Runtime org',
      slug: `runtime-foreign-${suffix}` });
    await db.insert(schema.users).values([{ id: ownerId, email, name: 'Runtime owner' },
      { id: otherId, email: `runtime-other-${suffix}@example.test`, name: 'Other member' }]);
    await db.insert(schema.orgMembers).values([
      { id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'owner', is_active: true },
      { id: randomUUID(), org_id: orgId, user_id: otherId, role: 'member', is_active: true },
      { id: randomUUID(), org_id: foreignOrgId, user_id: otherId, role: 'owner', is_active: true },
    ]);
    const web = await sessionModule.createWebSession({ id: ownerId, email, org_id: orgId });
    const otherWeb = await sessionModule.createWebSession({ id: otherId,
      email: `runtime-other-${suffix}@example.test`, org_id: orgId });
    const foreignWeb = await sessionModule.createWebSession({ id: otherId,
      email: `runtime-other-${suffix}@example.test`, org_id: foreignOrgId });
    const auth = { Authorization: `Bearer ${web.accessToken}` };
    async function call(path: string, method = 'GET', body?: unknown, token = auth.Authorization) {
      const response = await fetch(new Request(`${base}${path}`, {
        method, headers: { Authorization: token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      const value = await response.json() as any;
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    }
    const pairing = (await call('/api/apps/pairings', 'POST')).pairing;
    const exchanged = await call('/api/app-developer/pair/exchange', 'POST', { code: pairing.code }, '');
    assert.equal(exchanged.audience, 'app-developer');
    const packageJson = await runtimeV3PackageJson();
    const installResponse = await fetch(new Request(`${base}/api/app-developer/install`, {
      method: 'POST', headers: { Authorization: `Bearer ${exchanged.token}`,
        'Content-Type': 'application/json' }, body: packageJson,
    }));
    const installed = await installResponse.json() as any;
    assert.equal(installResponse.status, 201, JSON.stringify(installed));
    const staged = installed.app;
    assert.equal(staged.state, 'staged');
    const grants = (await call(`/api/apps/${staged.id}/grants`)).grants;
    const version = grants.versions.find((row: any) => row.id === staged.version_id);
    const requested = grants.snapshots.find((row: any) => row.id === version.requested_grant_snapshot_id);
    assert.ok(requested);
    const reviewInput = { app_version_id: version.id,
      expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: grants.installation.lifecycle_epoch,
      expected_grant_epoch: grants.installation.grant_epoch };
    const review = await call(`/api/app-runtime-review/${staged.id}/review`, 'POST', reviewInput);
    const activated = await call(`/api/app-runtime-review/${staged.id}/activate`, 'POST', {
      ...reviewInput, expected_review_digest: review.review_digest, accept_host_policy: true,
    });
    const effective = (await call(`/api/apps/${staged.id}/grants`)).grants;
    const grant = effective.snapshots.find((row: any) => row.id === activated.grant_snapshot_id);
    assert.ok(grant);
    const bindingInput = { installation_id: staged.id, action_key: 'create_shipping_label',
      operator_user_id: ownerId, expected_app_version_id: version.id,
      expected_package_digest: version.package_digest,
      expected_grant_snapshot_digest: grant.snapshot_digest,
      expected_lifecycle_epoch: effective.installation.lifecycle_epoch,
      expected_grant_epoch: effective.installation.grant_epoch };
    const bindingReview = (await call('/api/apps/runtime/reviews/prepare', 'POST', bindingInput)).review;
    const binding = (await call('/api/apps/runtime/bindings/activate', 'POST', {
      ...bindingInput, expected_review_digest: bindingReview.review_digest, accept_host_policy: true,
    })).binding;
    const invoke = { runtime_binding_id: binding.binding_id, idempotency_key: `http-shipping:${suffix}`,
      input: { shipment_id: 'synthetic-http-shipment' } };
    const denied = await fetch(new Request(`${base}/api/app-runtime-actions/invoke`, {
      method: 'POST', headers: { Authorization: `Bearer ${exchanged.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(invoke),
    }));
    assert.equal(denied.status, 401, 'developer audience cannot act as a human');
    for (const malformed of [{ ...invoke, policy: { review_requirement: 'never' } },
      { ...invoke, initiating_actor: { actor_type: 'human', user_id: ownerId } },
      { ...invoke, padding: 'x'.repeat(70_000) }]) {
      const rejected = await fetch(new Request(`${base}/api/app-runtime-actions/invoke`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(malformed),
      }));
      assert.equal(rejected.status, 400);
    }
    assert.deepEqual(await db.select({ id: schema.appRuns.id }).from(schema.appRuns)
      .where(eq(schema.appRuns.org_id, orgId)), []);
    const { run } = await call('/api/app-runtime-actions/invoke', 'POST', invoke);
    assert.equal(run.state, 'pending_approval');
    assert.equal((await call('/api/app-runtime-actions/invoke', 'POST', invoke)).run.id, run.id);
    const reviewPath = `/api/app-runtime-actions/${run.id}/review`;
    const reviewed = await fetch(`${base}${reviewPath}`, { headers: auth });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.headers.get('cache-control'), 'no-store');
    const reviewValue = (await reviewed.json() as any).review;
    assert.deepEqual(reviewValue.input, { shipment_id: 'synthetic-http-shipment' });
    assert.equal(reviewValue.run_id, run.id);
    assert.equal(reviewValue.runtime_binding_id, binding.binding_id);
    assert.deepEqual(reviewValue.policy, { risk_class: 'external_write',
      review_requirement: 'always', review_scope: 'per_invocation', retry_class: 'unsafe_or_unknown' });
    for (const token of [otherWeb.accessToken, foreignWeb.accessToken]) {
      const foreign = await fetch(`${base}${reviewPath}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(foreign.status, 403);
      assert.equal((await foreign.json() as any).code, 'APP_RUN_ACCESS_DENIED');
    }
    const [approval] = await db.select().from(schema.agentActions).where(and(
      eq(schema.agentActions.org_id, orgId), eq(schema.agentActions.app_run_id, run.id)));
    assert.ok(approval);
    const [storedRun] = await db.select({ safe_preview: schema.appRuns.safe_preview }).from(schema.appRuns)
      .where(and(eq(schema.appRuns.org_id, orgId), eq(schema.appRuns.id, run.id)));
    assert.ok(storedRun);
    assert.equal(JSON.stringify({ safe_preview: storedRun.safe_preview, approval: approval.params })
      .includes('synthetic-http-shipment'), false, 'approval projections contain no private input');
    const runtime = await runModule.getAppRunRuntime();
    assert.equal((await runtime.approvalResolver.approve(approval.id, ownerId)).status, 'approved');
    const session = (await call(`/api/apps/runtime/bindings/${binding.binding_id}/sessions`, 'POST')).session;
    const ledgerDir = await mkdtemp(join(tmpdir(), 'deft-runtime-http-'));
    const ledgerPath = join(ledgerDir, 'synthetic-carrier.jsonl');
    child = fork(fileURLToPath(new URL('./fixtures/app-runtime-provider-child.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, DEFT_RUNTIME_PROVIDER_FIXTURE: 'true' },
    });
    const events: Array<Record<string, unknown>> = [];
    const completed = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Runtime child timed out: ${JSON.stringify(events)}`)), 30_000);
      child!.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        const event = message as Record<string, unknown>;
        events.push(event);
        if (event.type === 'result' || event.type === 'error') {
          clearTimeout(timer);
          if (event.type === 'error') reject(new Error(`Runtime child: ${JSON.stringify(event)}`));
          else resolve(event);
        }
      });
      child!.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Runtime child exited ${code}: ${JSON.stringify(events)}`));
      });
    });
    child.send({ type: 'start', channel_url: `${base}/api/app-runtime/channel`,
      session_id: session.session_id, session_token: session.session_token,
      ledger_path: ledgerPath, mode: 'normal' });
    const completedEvent = await completed;
    assert.equal(completedEvent.type, 'result');
    assert.ok(events.some((event) => event.type === 'effect_committed'));
    const ledger = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(ledger, [{ run_id: run.id, item_id: 'synthetic-http-shipment',
      effect: 'synthetic_carrier_label' }]);
    const outcome = await runtime.repository.inspect(orgId, run.id);
    assert.equal(outcome?.state, 'succeeded');
    assert.ok((await runtime.receiptReader.readVerified(orgId, run.id))
      .some((receipt) => receipt.receipt_kind === 'attempt_terminal' && receipt.verified));
    const [eventRows, receiptRows] = await Promise.all([
      db.select({ payload: schema.appRunEvents.payload }).from(schema.appRunEvents)
        .where(and(eq(schema.appRunEvents.org_id, orgId), eq(schema.appRunEvents.run_id, run.id))),
      db.select({ envelope: schema.appRunReceipts.envelope }).from(schema.appRunReceipts)
        .where(and(eq(schema.appRunReceipts.org_id, orgId), eq(schema.appRunReceipts.run_id, run.id))),
    ]);
    assert.equal(JSON.stringify({ events: eventRows, receipts: receiptRows })
      .includes('synthetic-http-shipment'), false,
      'event and signed receipt projections contain no private input');
    const closedReview = await fetch(`${base}${reviewPath}`, { headers: auth });
    assert.equal(closedReview.status, 409);
    assert.equal((await closedReview.json() as any).code, 'APP_RUN_AUTHORIZATION_STALE');
    const pendingAfter = (await call('/api/app-runtime-actions/invoke', 'POST', {
      ...invoke, idempotency_key: `review-revoke:${suffix}`,
    })).run;
    assert.equal(pendingAfter.state, 'pending_approval');
    await call(`/api/apps/runtime/bindings/${binding.binding_id}/revoke`, 'POST');
    const revokedReview = await fetch(`${base}/api/app-runtime-actions/${pendingAfter.id}/review`, {
      headers: auth,
    });
    assert.equal(revokedReview.status, 409);
    assert.equal((await revokedReview.json() as any).code, 'APP_RUN_AUTHORIZATION_STALE');
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await runModule.shutdownAppRunRuntime();
    await closeDb();
  }
});
