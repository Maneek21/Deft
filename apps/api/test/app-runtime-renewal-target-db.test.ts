import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildDeftAppPackage } from '@deft/app-kit';
import { AppRuntimeActionResourcesRequestSchema } from '../src/lib/app-runtime-contract.js';
import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';

test('public opt-in issuance pins finite original private target authority and rejects revoked custody', { timeout: 120_000, skip:process.env.DATABASE_URL!=='postgresql://gate_g_test@127.0.0.1:55439/deft_runtime_renewal_test'||process.env.DEFT_TEST_DATABASE_URL!==process.env.DATABASE_URL }, async t => {
  assert.equal(process.env.DATABASE_URL,'postgresql://gate_g_test@127.0.0.1:55439/deft_runtime_renewal_test');assert.equal(process.env.DEFT_TEST_DATABASE_URL,process.env.DATABASE_URL);
  Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true' });
  const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`action-resource-test:${id}`).digest('base64') } });
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: ring('resources-enc'), receipt_signing: ring('resources-sign'), fingerprint: ring('resources-fp') });
  const complete=await (await import('./fixtures/app-run-test-keyrings.js')).databaseCompleteAppRunTestKeyringFixture('renewal-target');process.env.DEFT_APP_RUN_KEYRINGS=complete.environment;complete.keys.destroy();
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

  const personal=await resource('personal'),work=await resource('work');
  const {actions}=await call(`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`,undefined,undefined,'Bearer','GET');
  const input={...actions.find((row:any)=>row.key==='archive_message').review_request,owner_resource_binding_id:personal.binding_id};
  const {review}=await call('/api/apps/blob/composition/runtime/reviews/prepare',input);
  const {binding}=await call('/api/apps/blob/composition/runtime/bindings/activate',{...input,expected_review_digest:review.review_digest,accept_host_policy:true});
  const issue=`/api/apps/blob/composition/runtime/bindings/${binding.binding_id}/sessions`;
  const {session}=await call(issue,{technical_renewal:{requested_until:'2099-01-01T00:00:00.000Z'}});
  const [target]=await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id,personal.binding_id));assert.ok(target?.consent_expires_at);
  const sid=(await web.verifyWebAccess(tokens.get(owner)!)).sid;
  const [principal]=await db.select().from(s.webSessions).where(eq(s.webSessions.id,sid));assert.ok(principal);
  assert.equal(Date.parse(session.renewable_until),Math.min(target.consent_expires_at.getTime(),principal.expires_at.getTime()));
  const [stored]=await db.select().from(s.appRuntimeSessions).where(eq(s.appRuntimeSessions.id,session.session_id));assert.equal(stored.renewal_web_session_id,sid);
  const renew=()=>request('/api/app-runtime/channel/renew',{schema_version:'deft.app_runtime_channel.v1',session_id:session.session_id,expected_expires_at:session.expires_at},session.session_token,'AppRuntime');
  assert.equal((await renew()).status,200);
  for(const body of [{technical_renewal:{}},{technical_renewal:{requested_until:'never'}},{technical_renewal:{requested_until:'2099-01-01T00:00:00Z',sid:'foreign'}},{technical_renewal:{requested_until:'2000-01-01T00:00:00Z'}}])closed(await request(issue,body));
  assert.equal((await request(issue,{technical_renewal:{requested_until:'2099-01-01T00:00:00Z'}},tokens.get(other)!)).status,403);
  const [legacy]=await db.select().from(s.appRuntimeSessions).where(eq(s.appRuntimeSessions.id,(await call(issue,{})).session.session_id));assert.equal(legacy.renewable_until,null);
  // A different account's still-current consent cannot replace the original target.
  await db.update(s.appResourceBindings).set({state:'revoked',revoked_at:new Date(),updated_at:new Date()}).where(eq(s.appResourceBindings.id,personal.binding_id));
  assert.equal((await renew()).status,403);
  closed(await request(issue,{technical_renewal:{requested_until:'2099-01-01T00:00:00Z'}}));
  const [otherTarget]=await db.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id,work.binding_id));assert.equal(otherTarget.state,'active');
  const live=await import('../src/lib/app-runtime-authority.js');
  assert.equal(await db.transaction(tx=>live.loadLiveRuntimeAuthority(tx,org,session.session_id,live.hashAppRuntimeToken(session.session_token),()=>new Date())),null,'same denial in dispatch authority');
});
