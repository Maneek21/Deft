import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildDeftAppPackage } from '@deft/app-kit';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import { processTestDatabaseUrl } from './fixtures/safe-test-database-target.js';


test('ordinary reviewed version upgrade retains compatible owner account identifiers for fresh consent', { timeout: 180000 }, async t => {
  assert.ok(processTestDatabaseUrl(), 'Requires a disposable test database shared by the test and runtime clients');
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_PRIVATE_STATE_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true',
    DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
    DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`owner-connections:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('owner-enc'), receipt_signing: ring('owner-sign'), fingerprint: ring('owner-fp') });
  const [{ db, closeDb }, s, { and, eq }, web, runtime, attachments, { Hono }, { serve }, ownerRoutes,
    blobRoutes, experienceRoutes, channelRoutes, humanRoutes, { AppExperienceHumanActionService }, { AppExperienceExposureService }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/app-attachment-runtime.js'), import('hono'), import('@hono/node-server'),
    import('../src/routes/app-owner-connections.js'), import('../src/routes/app-attachments.js'), import('../src/routes/app-experiences.js'),
    import('../src/routes/app-runtime-channel.js'), import('../src/lib/app-experience-human-action-routes.js'),
    import('../src/lib/app-experience-human-action-service.js'), import('../src/lib/app-experience-exposure.js'),
  ]);
  await runtime.getAppRunRuntime();
  const app = new Hono();
  app.route('/api/app-resource-sync-channel/v3', (await import('../src/routes/app-attachment-sync-channel.js')).appAttachmentSyncChannelRoutes);
  app.route('/api/app-owner-connections', ownerRoutes.appOwnerConnectionRoutes);
  app.route('/api/apps/blob', blobRoutes.appAttachmentRoutes);
  app.route('/api/app-experiences', experienceRoutes.appExperienceRoutes);
  app.route('/api/app-experiences', humanRoutes.createExperienceHumanActionRoutes(async () => {
    const current = await runtime.getAppRunRuntime();
    return new AppExperienceHumanActionService(new AppExperienceExposureService(current.keys), current);
  }));
  app.route('/api/app-runtime/channel', channelRoutes.appRuntimeChannelRoutes);
  let server!: ReturnType<typeof serve>;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    address => resolve(`http://127.0.0.1:${address.port}`)); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve()));
    await attachments.shutdownAppAttachmentRuntime(); await runtime.shutdownAppRunRuntime(); await closeDb(); });
  const org = randomUUID(), foreignOrg = randomUUID(), suffix = randomUUID();
  await db.insert(s.orgs).values([{ id: org, name: 'Owner connection test', slug: `owner-connect-${suffix}` },
    { id: foreignOrg, name: 'Foreign connection test', slug: `foreign-connect-${suffix}` }]);
  const people = {
    owner: { id: randomUUID(), role: 'owner' as const, org }, admin: { id: randomUUID(), role: 'admin' as const, org },
    member: { id: randomUUID(), role: 'member' as const, org }, other: { id: randomUUID(), role: 'member' as const, org },
    guest: { id: randomUUID(), role: 'guest' as const, org }, agent: { id: randomUUID(), role: 'member' as const, org },
    inactive: { id: randomUUID(), role: 'member' as const, org }, foreign: { id: randomUUID(), role: 'owner' as const, org: foreignOrg },
  };
  const tokens: Record<keyof typeof people, string> = {} as Record<keyof typeof people, string>;
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    const person = people[key], email = `connect-${key}-${suffix}@example.test`;
    await db.insert(s.users).values({ id: person.id, name: `Connection ${key}`, email,
      kind: key === 'agent' ? 'agent' : 'human', is_agent: key === 'agent' });
    await db.insert(s.orgMembers).values({ id: randomUUID(), org_id: person.org, user_id: person.id, role: person.role, is_active: true });
    tokens[key] = (await web.createWebSession({ id: person.id, org_id: person.org, email })).accessToken;
  }
  const membership = (id: string) => and(eq(s.orgMembers.org_id, org), eq(s.orgMembers.user_id, id));
  await db.update(s.orgMembers).set({ is_active: false }).where(membership(people.inactive.id));
  const request = async (path: string, method = 'GET', body?: unknown, token = tokens.owner, scheme = 'Bearer') => {
    const response = await fetch(base + path, { method, headers: { authorization: `${scheme} ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (path: string, method = 'GET', body?: unknown, token = tokens.owner, scheme = 'Bearer') => {
    const result = await request(path, method, body, token, scheme);
    assert.ok(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`); return result.body;
  };
  const fixture = JSON.parse((await runtimeSecurityPackage()).json);
  fixture.manifest.id = `community.example.ownerconnect.a${suffix.replaceAll('-', '')}`;
  fixture.manifest.owner_connections = [{ key: 'personal_mailbox', resource_key: 'inbox', action_keys: ['send_message'], max_consent_seconds: 86400 * 30 }];
  const packed = (await buildDeftAppPackage({ manifest: fixture.manifest, artifacts: fixture.artifacts })).json;
  const { app: installed } = await call('/api/apps/blob/composition/stage', 'POST', packed);
  const installContext = await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);
  const { review: installReview } = await call(`/api/apps/blob/composition/${installed.id}/review`, 'POST', installContext.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`, 'POST', { ...installContext.review_request,
    expected_review_digest: installReview.review_digest, accept_host_policy: true });
  const root = '/api/app-owner-connections', contextPath = `${root}/${installed.id}/context`;
  const currentPins = async () => {
    const [installation] = await db.select().from(s.appInstallations).where(eq(s.appInstallations.id, installed.id));
    const [version] = await db.select().from(s.appVersions).where(eq(s.appVersions.id, installation!.active_version_id!));
    const [grant] = await db.select().from(s.appGrantSnapshots).where(and(eq(s.appGrantSnapshots.app_installation_id, installed.id), eq(s.appGrantSnapshots.app_version_id, version!.id), eq(s.appGrantSnapshots.snapshot_kind, 'effective')));
    return { expected_app_version_id: version!.id, expected_package_digest: version!.package_digest, expected_grant_snapshot_digest: grant!.snapshot_digest,
      expected_lifecycle_epoch: installation!.lifecycle_epoch, expected_grant_epoch: installation!.grant_epoch };
  };
  const admissionInput = { installation_id: installed.id, policy_key: 'personal_mailbox', operator_user_id: people.owner.id,
    limits: { max_records_per_page: 25, max_page_bytes: 65536, max_retained_records: 1000, max_retained_bytes: 1048576, min_interval_seconds: 300 }, ...await currentPins() };
  const { review: admissionReview } = await call(`${root}/admissions/review`, 'POST', admissionInput, tokens.admin);
  const { admission } = await call(`${root}/admissions/activate`, 'POST', { ...admissionInput,
    expected_review_digest: admissionReview.review_digest, accept_host_policy: true }, tokens.admin);
  const context = await call(contextPath, 'GET', undefined, tokens.member), policy = context.policies[0];
  assert.equal(policy.status, 'admitted'); assert.equal(policy.admission.operator_user_id, people.owner.id);
  assert.equal(policy.admission.admission_id, admission.admission_id);
  const resourceInput = { ...policy.admission.resource_request, limits: { ...policy.admission.resource_request.limits, max_records_per_page: 1 } };
  for (const target_key of ['fresh_mailbox', 'fresh_recipient']) {
    const input = { ...resourceInput, target_key };
    const { review } = await call(`${root}/resources/review`, 'POST', input, tokens.member);
    await call(`${root}/resources/activate`, 'POST', { ...input, expected_review_digest: review.review_digest, accept_host_policy: true }, tokens.member);
  }
  const next = await buildDeftAppPackage({ manifest: { ...fixture.manifest, version: '9.0.1' }, artifacts: fixture.artifacts });
  const [prior] = await db.select().from(s.appInstallations).where(eq(s.appInstallations.id, installed.id));
  const upgrade = `/api/apps/blob/composition/${installed.id}/upgrade`;
  const staged = await call(upgrade + '/stage', 'POST', { schema_version: 'deft.app_attachment_upgrade_stage.v1', package_json: next.json, expected_lifecycle_epoch: prior!.lifecycle_epoch });
  const upgradeContext = await call(upgrade + `/context?app_version_id=${staged.app_version_id}`);
  const { review: upgradeReview } = await call(upgrade + '/review', 'POST', upgradeContext.review_request);
  await call(upgrade + '/activate', 'POST', { ...upgradeContext.review_request, expected_review_digest: upgradeReview.review_digest, accept_host_policy: true });
  const renewedInput = { ...admissionInput, ...await currentPins() };
  const { review: renewedReview } = await call(`${root}/admissions/review`, 'POST', renewedInput, tokens.admin);
  await call(`${root}/admissions/activate`, 'POST', { ...renewedInput, expected_review_digest: renewedReview.review_digest, accept_host_policy: true }, tokens.admin);
  const recovered = (await call(contextPath, 'GET', undefined, tokens.member)).policies[0];
  assert.deepEqual(recovered.bindings, [], 'new admission has not inherited old binding authority');
  assert.deepEqual(recovered.recovery_targets, [{ key: 'fresh_mailbox' }, { key: 'fresh_recipient' }]);
  const repeated = (await call(contextPath, 'GET', undefined, tokens.member)).policies[0];
  assert.deepEqual(repeated.recovery_targets, recovered.recovery_targets, 'discovery is stable and performs no activation');
});
