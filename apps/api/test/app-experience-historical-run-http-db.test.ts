import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';
const safe=securityTestDatabaseIsSafe();

test('historical terminal Run metadata stays scoped after a reviewed version upgrade', { skip: !safe, timeout: 90000 }, async t => {
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true' });
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
  const source = JSON.parse((await runtimeSecurityPackage()).json);
  const kit = await import('@deft/app-kit');
  const artifact = await kit.prepareDeftExperienceArtifact('experiences/status-fixture.json', { schema_version: 'deft.experience_bundle.v3', worker_source: 'self.onmessage=()=>{};', entry_view: 'main', resource_keys: [], action_keys: ['send_message'], state_keys: ['drafts'] });
  const fixture = await kit.buildDeftAppPackage({ manifest: { ...source.manifest, experiences: [{ ...source.manifest.experiences[0], artifact_path: artifact.path, artifact_digest: artifact.digest }] }, artifacts: [artifact] });
  const packed = fixture.json, parsed = JSON.parse(packed);
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
  const rt = await runtime.getAppRunRuntime();
  await rt.service.cancel(org, run.id, { actor_type: 'human', user_id: owner });
  const next = await kit.buildDeftAppPackage({ manifest: { ...parsed.manifest, version: '9.0.1' }, artifacts: parsed.artifacts });
  const [prior] = await db.select().from(s.appInstallations).where(orm.eq(s.appInstallations.id, installed.id));
  const prefix = `/api/apps/blob/composition/${installed.id}/upgrade`;
  const staged = await call(prefix + '/stage', 'POST', { schema_version: 'deft.app_attachment_upgrade_stage.v1', package_json: next.json, expected_lifecycle_epoch: prior.lifecycle_epoch });
  const upgradeContext = await call(prefix + `/context?app_version_id=${staged.app_version_id}`);
  const { review: upgradeReview } = await call(prefix + '/review', 'POST', upgradeContext.review_request);
  await call(prefix + '/activate', 'POST', { ...upgradeContext.review_request, expected_review_digest: upgradeReview.review_digest, accept_host_policy: true });
  const grantAccess = async (id: string, token: string) => {
    const base = `/api/app-experiences/sessions/${id}/access`;
    const review = await call(base + '/review', 'POST', {}, token);
    await call(base + '/accept', 'POST', { review_token: review.review_token, review_digest: review.review_digest, accept_exposure: true }, token);
  };
  const fresh = await create(second.accessToken), historicalPath = `/api/app-experiences/sessions/${fresh.pin.session_id}/runs/${run.id}`;
  assert.ok((await request(historicalPath, 'GET', undefined, second.accessToken)).status >= 400, 'unconsented fresh session cannot read historical metadata');
  await grantAccess(fresh.pin.session_id, second.accessToken);
  const terminal = await call(historicalPath, 'GET', undefined, second.accessToken);
  assert.equal(terminal.run.state, 'cancelled');
  assert.deepEqual(Object.keys(terminal.run).sort(), ['created_at','id','started_at','state','terminal_at','updated_at']);
  assert.equal(JSON.stringify(terminal).includes('PRIVATE-RUN-INPUT'), false);
  assert.ok((await request(historicalPath + '/review-target', 'GET', undefined, second.accessToken)).status >= 400);
  assert.ok((await request(historicalPath, 'GET', undefined, outsider.accessToken)).status >= 400);
  const peerExperience = await create(outsider.accessToken);
  await grantAccess(peerExperience.pin.session_id, outsider.accessToken);
  assert.ok((await request(`/api/app-experiences/sessions/${peerExperience.pin.session_id}/runs/${run.id}`, 'GET', undefined, outsider.accessToken)).status >= 400, 'another valid human Experience cannot read owner history');
  assert.ok((await request(historicalPath, 'GET', undefined, otherTenant.accessToken)).status >= 400);
  // A synthetic retained old-lineage Run exercises denied metadata only; it has
  // no attempt, queued claim, provider input release, or external effect.
  const [oldRow] = await db.select().from(s.appRuns).where(orm.eq(s.appRuns.id, run.id));
  const unresolvedId = randomUUID();
  await db.insert(s.appRuns).values({ ...oldRow, id: unresolvedId, root_run_id: unresolvedId,
    idempotency_fingerprint: 'hmac-sha256:' + createHash('sha256').update(unresolvedId).digest('hex'),
    state: 'pending_approval', cancelled_at: null, terminal_at: null });
  const unresolvedPath = historicalPath.replace(run.id, unresolvedId);
  assert.ok((await request(unresolvedPath, 'GET', undefined, second.accessToken)).status >= 400);
  await db.update(s.appRuns).set({ state: 'running', started_at: new Date(), execution_release_kind: 'approved', execution_released_at: new Date() }).where(orm.eq(s.appRuns.id, unresolvedId));
  await db.update(s.appRuns).set({ state: 'unknown_outcome', unknown_outcome_at: new Date() }).where(orm.eq(s.appRuns.id, unresolvedId));
  assert.ok((await request(unresolvedPath, 'GET', undefined, second.accessToken)).status >= 400);
  const otherPackage = await kit.buildDeftAppPackage({ manifest: { ...parsed.manifest, id: 'community.example.otherhistorical', version: '1.0.0' }, artifacts: parsed.artifacts });
  const { app: otherApp } = await call('/api/apps/blob/composition/stage', 'POST', otherPackage.json);
  const otherContext = await call(`/api/apps/blob/composition/${otherApp.id}/context?app_version_id=${otherApp.version_id}`);
  const { review: otherReview } = await call(`/api/apps/blob/composition/${otherApp.id}/review`, 'POST', otherContext.review_request);
  await call(`/api/apps/blob/composition/${otherApp.id}/activate`, 'POST', { ...otherContext.review_request, expected_review_digest: otherReview.review_digest, accept_host_policy: true });
  const otherExperience = await call(`/api/app-experiences/${otherApp.id}/${experienceKey}/sessions`, 'POST', {}, second.accessToken);
  await grantAccess(otherExperience.pin.session_id, second.accessToken);
  assert.ok((await request(`/api/app-experiences/sessions/${otherExperience.pin.session_id}/runs/${run.id}`, 'GET', undefined, second.accessToken)).status >= 400);
  await call(`/api/app-experiences/sessions/${fresh.pin.session_id}/access`, 'DELETE', undefined, second.accessToken);
  assert.ok((await request(historicalPath, 'GET', undefined, second.accessToken)).status >= 400);
});
