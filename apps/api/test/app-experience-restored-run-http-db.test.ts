import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';
const safe=securityTestDatabaseIsSafe();

test('a reopened v7 Experience restores only current owner Run metadata', { skip: !safe, timeout: 90000 }, async t => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`private-state-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1', run_encryption: ring('private-enc'), receipt_signing: ring('private-sign'), fingerprint: ring('private-fp') });
  const [{ app }, { db, closeDb }, s, orm, web, runtime] = await Promise.all([import('../src/index.js'), import('../src/lib/db.js'),
    import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'), import('../src/lib/app-run-runtime.js')]);
  t.after(async () => { await runtime.shutdownAppRunRuntime(); await closeDb(); });
  const org = randomUUID(), owner = randomUUID(), member = randomUUID(), suffix = randomUUID();
  await db.insert(s.orgs).values({ id: org, name: 'Restored Run fixture', slug: `restored-run-${suffix}` });
  await db.insert(s.users).values([{ id: owner, name: 'Owner', email: `run-owner-${suffix}@example.test` }, { id: member, name: 'Member', email: `run-member-${suffix}@example.test` }]);
  await db.insert(s.orgMembers).values([{ id: randomUUID(), org_id: org, user_id: owner, role: 'owner', is_active: true }, { id: randomUUID(), org_id: org, user_id: member, role: 'member', is_active: true }]);
  const first = await web.createWebSession({ id: owner, org_id: org, email: `run-owner-${suffix}@example.test` });
  const second = await web.createWebSession({ id: owner, org_id: org, email: `run-owner-${suffix}@example.test` });
  const outsider = await web.createWebSession({ id: member, org_id: org, email: `run-member-${suffix}@example.test` });
  const request = (path: string, method = 'GET', body?: unknown, token = first.accessToken) => app.request('http://localhost' + path, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const call = async (path: string, method = 'GET', body?: unknown, token = first.accessToken) => {
    const response = await request(path, method, body, token); const result = await response.json() as any;
    assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(result)}`); return result;
  };
  const packed = (await runtimeSecurityPackage()).json;
  const parsed = JSON.parse(packed);
  const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', packed);
  const context = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
  const { review } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', context.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...context.review_request, expected_review_digest: review.review_digest, accept_host_policy: true });
  const setup = await call(`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`);
  const bindingRequest = setup.actions.find((action: any) => action.key === 'send_message').review_request;
  const { review: bindingReview } = await call('/api/apps/blob/composition/runtime/reviews/prepare', 'POST', bindingRequest);
  const { binding } = await call('/api/apps/blob/composition/runtime/bindings/activate', 'POST', { ...bindingRequest, expected_review_digest: bindingReview.review_digest, accept_host_policy: true });
  const experienceKey = parsed.manifest.experiences[0].key;
  const create = (token = first.accessToken) => call(`/api/app-experiences/${installed.id}/${experienceKey}/sessions`, 'POST', {}, token);
  const old = await create(); assert.equal(old.protocol_version, '7');
  const { run } = await call(`/api/app-experiences/sessions/${old.pin.session_id}/actions/send_message`, 'POST', {
    request_id: 'request_1', input: { to: 'recipient@example.test', subject: 'Status probe', body: 'PRIVATE-RUN-INPUT', message_id: '<status-probe@example.test>' },
  });
  assert.equal(run.state, 'pending_approval');
  const reopened = await create(second.accessToken);
  const path = `/api/app-experiences/sessions/${reopened.pin.session_id}/runs/${run.id}`;
  const output = await call(path, 'GET', undefined, second.accessToken);
  assert.deepEqual(Object.keys(output.run).sort(), ['created_at', 'id', 'started_at', 'state', 'terminal_at', 'updated_at']);
  assert.equal(output.run.id, run.id); assert.equal(output.run.state, 'pending_approval');
  assert.equal(JSON.stringify(output).includes('PRIVATE-RUN-INPUT'), false);
  const reviewTarget = await call(path + '/review-target', 'GET', undefined, second.accessToken);
  assert.deepEqual(Object.keys(reviewTarget).sort(), ['approval_id','run_id','run_state','runtime_binding_id','schema_version']);
  assert.equal(reviewTarget.run_id, run.id); assert.equal(reviewTarget.runtime_binding_id, binding.binding_id);
  assert.equal(typeof reviewTarget.approval_id, 'string'); assert.equal(reviewTarget.run_state, 'pending_approval');
  assert.equal(JSON.stringify(reviewTarget).includes('PRIVATE-RUN-INPUT'), false);
  assert.ok((await request(path + '/review-target', 'GET', undefined, first.accessToken)).status >= 400);
  assert.ok((await request(path + '/review-target', 'GET', undefined, outsider.accessToken)).status >= 400);
  assert.equal((await request(path + '/review-target?include=input', 'GET', undefined, second.accessToken)).status, 400);
  assert.equal((await request(path.replace(run.id, randomUUID()) + '/review-target', 'GET', undefined, second.accessToken)).status, 403);
  assert.ok((await request(path, 'GET', undefined, first.accessToken)).status >= 400);
  assert.ok((await request(path, 'GET', undefined, outsider.accessToken)).status >= 400);
  assert.equal((await request(path + '?include=result', 'GET', undefined, second.accessToken)).status, 400);
  assert.equal((await request(path.replace(run.id, randomUUID()), 'GET', undefined, second.accessToken)).status, 403);
  const otherOrg = randomUUID(); await db.insert(s.orgs).values({ id: otherOrg, name: 'Other tenant', slug: `run-other-${suffix}` });
  await db.insert(s.orgMembers).values({ id: randomUUID(), org_id: otherOrg, user_id: owner, role: 'owner', is_active: true });
  const otherTenant = await web.createWebSession({ id: owner, org_id: otherOrg, email: `run-owner-${suffix}@example.test` });
  assert.ok((await request(path, 'GET', undefined, otherTenant.accessToken)).status >= 400);
  await call(`/api/app-experiences/sessions/${reopened.pin.session_id}`, 'DELETE', undefined, second.accessToken);
  assert.ok((await request(path + '/review-target', 'GET', undefined, second.accessToken)).status >= 400);
  assert.ok((await request(path, 'GET', undefined, second.accessToken)).status >= 400);
  await db.update(s.orgMembers).set({ is_active: false }).where(orm.and(orm.eq(s.orgMembers.org_id, org), orm.eq(s.orgMembers.user_id, owner)));
  assert.ok((await request(`/api/app-experiences/sessions/${old.pin.session_id}/runs/${run.id}`)).status >= 400);
  await db.update(s.orgMembers).set({ is_active: true }).where(orm.and(orm.eq(s.orgMembers.org_id, org), orm.eq(s.orgMembers.user_id, owner)));
  await db.update(s.appRuntimeBindings).set({ state: 'revoked' }).where(orm.eq(s.appRuntimeBindings.id, binding.binding_id));
  assert.equal((await request(`/api/app-experiences/sessions/${old.pin.session_id}/runs/${run.id}`)).status, 403);
});
