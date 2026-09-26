import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Only synthetic org/human/membership/SID rows are seeded. Installed App,
 * Module, native proposal/owner consent, endpoint and record authority use HTTP. */
export async function publicNativeHttpFixture(options: { mixedRuntime?: boolean } = {}) {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'true';
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'false';
  process.env.DEFT_APP_PUBLIC_INGRESS_ENABLED = 'true';
  const artifactPath = options.mixedRuntime ? process.env.DEFT_NATIVE_MIXED_AUTHOR_PACKAGE : process.env.DEFT_NATIVE_AUTHOR_PACKAGE;
  assert.ok(artifactPath, 'DEFT_NATIVE_AUTHOR_PACKAGE must identify the retained external packed native Booking artifact');
  const raw = await readFile(artifactPath, 'utf8');
  const pkg = JSON.parse(raw) as { manifest: { schema_version: string; runtime_requirements: unknown[] } };
  assert.equal(pkg.manifest.schema_version, '6');
  assert.equal(pkg.manifest.runtime_requirements.length, options.mixedRuntime ? 1 : 0,
    'native-only N09 author requires no artificial Runtime operator; mixed compatibility is a separate package');
  const [runModule, { app }, { db }, schema, { createWebSession }, { serve }, orm, queues, workers,
    { databaseCompleteAppRunTestKeyringFixture }] = await Promise.all([
    import('../../src/lib/app-run-runtime.js'), import('../../src/index.js'), import('../../src/lib/db.js'),
    import('@deft/db/schema'), import('../../src/lib/web-sessions.js'), import('@hono/node-server'),
    import('drizzle-orm'), import('../../src/lib/queues.js'), import('../../src/workers/index.js'),
    import('./app-run-test-keyrings.js'),
  ]);
  const ring = await databaseCompleteAppRunTestKeyringFixture('public-native-http');
  process.env.DEFT_APP_RUN_KEYRINGS = ring.environment; ring.keys.destroy();
  const suffix = randomUUID(), orgId = randomUUID(), managerId = randomUUID(), ownerId = randomUUID(), foreignId = randomUUID();
  await db.insert(schema.orgs).values({ id: orgId, name: 'External native Booking', slug: `native-booking-${suffix}` });
  await db.insert(schema.users).values([
    { id: managerId, name: 'Booking manager', email: `booking-manager-${suffix}@example.test` },
    { id: ownerId, name: 'Calendar owner', email: `booking-owner-${suffix}@example.test` },
    { id: foreignId, name: 'Other member', email: `booking-other-${suffix}@example.test` },
  ]);
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), org_id: orgId, user_id: managerId, role: 'owner', is_active: true },
    { id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'member', is_active: true },
    { id: randomUUID(), org_id: orgId, user_id: foreignId, role: 'member', is_active: true },
  ]);
  const sessions = {
    manager: await createWebSession({ id: managerId, email: `booking-manager-${suffix}@example.test`, org_id: orgId }),
    owner: await createWebSession({ id: ownerId, email: `booking-owner-${suffix}@example.test`, org_id: orgId }),
    foreign: await createWebSession({ id: foreignId, email: `booking-other-${suffix}@example.test`, org_id: orgId }),
  };
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const observations: Array<{ path: string; status: number; actor: string }> = [];
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  async function request(path: string, body?: unknown, actor: 'manager' | 'owner' | 'foreign' | 'anonymous' = 'manager', method?: string) {
    const response = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { ...(actor === 'anonymous' ? {} : { Authorization: `Bearer ${sessions[actor].accessToken}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const value = await response.json(); observations.push({ path, status: response.status, actor });
    return { response, value };
  }
  async function call(path: string, body?: unknown, actor: 'manager' | 'owner' | 'foreign' | 'anonymous' = 'manager', method?: string) {
    const result = await request(path, body, actor, method);
    assert.ok(result.response.ok, JSON.stringify({ path, status: result.response.status, value: result.value }));
    return result.value;
  }
  try {
    const staged = (await call('/api/apps/stage', raw)).app;
    const context = await call(`/api/apps/native/app/${staged.id}/context?app_version_id=${staged.version_id}`);
    assert.ok(context.review_request);
    const review = await call(`/api/apps/native/app/${staged.id}/review`, context.review_request);
    const active = await call(`/api/apps/native/app/${staged.id}/activate`, { ...context.review_request,
      expected_review_digest: review.review_digest, accept_host_policy: true });
    assert.equal(active.installation.state, 'active');
    const { eq, and } = orm;
    const [grant] = await db.select().from(schema.appGrantSnapshots).where(and(eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, active.grant_snapshot_id)));
    assert.ok(grant);
    const binding = await call('/api/apps/native/bindings/stage', {
      schema_version: 'deft.app_native_binding_stage.v1', installation_id: staged.id, action_key: 'create_booking',
      target: { schema_version: 'deft.app_native_target.v1', provider_kind: 'native', adapter_contract_version: 'deft.native.calendar.v1',
        operation_name: 'calendar.events.create.v1', calendar_owner_user_id: ownerId },
      expected_app_version_id: staged.version_id, expected_package_digest: staged.package_digest,
      expected_grant_snapshot_digest: grant.snapshot_digest, expected_lifecycle_epoch: active.installation.lifecycle_epoch,
      expected_grant_epoch: active.installation.grant_epoch,
    });
    const ownerContext = await call(`/api/apps/native/bindings/${binding.binding_id}/context`, undefined, 'owner');
    assert.ok(ownerContext.review_request);
    const ownerReview = await call(`/api/apps/native/bindings/${binding.binding_id}/review`, ownerContext.review_request, 'owner');
    const accepted = await call(`/api/apps/native/bindings/${binding.binding_id}/accept`, { ...ownerContext.review_request,
      expected_review_digest: ownerReview.review_digest, accept_host_policy: true }, 'owner');
    assert.equal(accepted.state, 'active');
    const stageInput = { installation_id: staged.id, public_action_key: 'reserve',
      binding_target: { schema_version: 'deft.app_public_binding_target.v2', kind: 'native', native_binding_id: binding.binding_id },
      approver_user_id: ownerId, public_label: 'Reserve an external Booking', max_body_bytes: 1024,
      expected_app_version_id: staged.version_id, expected_grant_snapshot_id: grant.id,
      expected_lifecycle_epoch: active.installation.lifecycle_epoch, expected_grant_epoch: active.installation.grant_epoch };
    const endpoint = await call('/api/apps/public/endpoints/stage', stageInput);
    assert.equal(endpoint.owner_user_id, ownerId);
    const activationInput = { expected_review_digest: endpoint.review_digest, expected_endpoint_epoch: endpoint.endpoint_epoch, accept_host_policy: true };
    const enabled = await call(`/api/apps/public/endpoints/${endpoint.endpoint_id}/activate`, activationInput);
    const module = (await call('/api/modules/external-native-booking')).module;
    async function createRecord(title: string) {
      return (await call('/api/modules/external-native-booking/records', { collection_key: 'bookings',
        data: { title, start_at: '2055-11-07T01:30:00-04:00', end_at: '2055-11-07T01:45:00-04:00',
          claim_by: '2055-11-06T23:00:00-04:00', private_note: 'PRIVATE_UNSELECTED_CANONICAL_FIELD' }, relations: {},
        expected_manifest_digest: module.manifest_digest, idempotency_key: randomUUID() })).record;
    }
    async function updateRecord(recordId: string, revision: number, patch: Record<string, unknown>) {
      return (await call(`/api/modules/external-native-booking/records/${recordId}`, { patch,
        expected_revision: revision, expected_manifest_digest: module.manifest_digest, idempotency_key: randomUUID() }, 'manager', 'PATCH')).record;
    }
    return { orgId, managerId, ownerId, foreignId, db, schema, orm, sessions, base, call, request, close, observations,
      staged, active, grant, binding, endpoint, enabled, stageInput, activationInput, module, createRecord, updateRecord, queues, workers,
      runtime: await runModule.getAppRunRuntime(), publicPath: `/api/public/apps/${endpoint.slug}` };
  } catch (error) { await close(); throw error; }
}
