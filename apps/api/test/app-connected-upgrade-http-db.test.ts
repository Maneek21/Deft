import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { and, eq, sql } from 'drizzle-orm';
import { agentActions, appActionBindings, appAutomationFires, appGrantSnapshots, appInstallations, appModuleBindings,
  appRunAttempts, appRunReceipts, appRuns, appVersions, auditLog, mcpConnections, moduleVersions, orgMembers, orgs, users } from '@deft/db/schema';
import { RESOURCE_CONTRACT_VERSIONS } from '@deft/shared';
import { db, closeDb } from '../src/lib/db.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { appRoutes } from '../src/routes/apps.js';
import { createWebSession, revokeWebSession } from '../src/lib/web-sessions.js';
import { humanModuleActor, createModuleRecord } from '../src/lib/module-service.js';
import { replaceResourceRelation } from '../src/lib/resource-relation-service.js';
import { stageAppPackage, stageAppUpgrade, activateAppInstallation } from '../src/lib/app-service.js';
import { prepareConnectedAppReview, activateConnectedAppInstallation, activateConnectedAppUpgrade } from '../src/lib/app-review-service.js';
import { CapabilityService } from '../src/lib/capability-service.js';
import { createReviewedAppAutomationDefinition, persistAppAutomationFire, prepareAppAutomationDefinitionReview } from '../src/lib/app-automation-definition-service.js';
import { claimAppAutomationFireWithExecutor } from '../src/lib/app-automation-repository.js';
import { runAppAutomationFire } from '../src/lib/app-automation-runtime.js';
import { appActionService } from '../src/lib/app-action-service.js';
import { digestAppGrantValue } from '../src/lib/app-grant-service.js';
import { getAppRunRuntime, shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { AppRunAttemptRunner } from '../src/lib/app-run-attempt-runner.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';
import { PinnedMcpAppRunProviderExecutor } from '../src/lib/app-run-provider-executor.js';
import { PostgresAppRunReceiptWriter } from '../src/lib/app-run-receipts.js';
import { buildPhase5DependencyAppPackage, buildPhase5ConnectedAppPackage, buildTrackAAutomatedConnectedAppPackage } from './fixtures/phase5-connected-app-package.js';

const target = process.env.DATABASE_URL ?? '';
const safe = /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c13_connected_upgrade_test(?:_v[0-9]+)?$/.test(target)
  && target === process.env.DEFT_TEST_DATABASE_URL;
process.env.DEFT_SELF_HOSTED = 'true';
process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
const servers: ServerType[] = [];
const connections: string[] = [];
after(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  const { mcpClientManager } = await import('@deft/mcp');
  await Promise.all(connections.map(id => mcpClientManager.disconnect(id)));
  await shutdownAppRunRuntime(); await closeDb();
});

async function fixture(protocol: '1' | '2' = '2', upgradeProtocol: '1' | '2' = '2') {
  const org = randomUUID(), user = randomUUID(), connection = randomUUID();
  const providerLedger = resolve(tmpdir(), `deft-c13-provider-${org}.jsonl`);
  await db.insert(orgs).values({ id: org, name: 'Connected explicit supersede', slug: `c13-${org}` });
  await db.insert(users).values({ id: user, email: `c13-${user}@example.test`, name: 'Synthetic owner' });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: org, user_id: user, role: 'owner', is_active: true });
  const actor = humanModuleActor({ orgId: org, userId: user, role: 'owner', source: 'rest' });
  const dependencyPackage = await buildPhase5DependencyAppPackage();
  const dependency = await stageAppPackage(actor, dependencyPackage.json);
  await activateAppInstallation(actor, dependency.id, dependency.package_digest);
  const built = await (protocol === '1' ? buildPhase5ConnectedAppPackage() : buildTrackAAutomatedConnectedAppPackage());
  const staged = await stageAppPackage(actor, built.json);
  await db.insert(mcpConnections).values({ id: connection, org_id: org, name: 'Synthetic mail', slug: `c13-${connection}`,
    server_url: null, transport: 'stdio', stdio_command: process.execPath,
    stdio_args: [resolve(import.meta.dirname, '../../../examples/app-platform-sandbox-email-provider/server.mjs'), '--outbox-file', providerLedger],
    auth_type: 'none', is_active: true, created_by: user });
  connections.push(connection);
  const capability = new CapabilityService();
  const pins = async (versionId: string, lifecycle: number, grant: number) => {
    const [version] = await db.select().from(appVersions).where(eq(appVersions.id, versionId));
    const [requested] = await db.select().from(appGrantSnapshots).where(eq(appGrantSnapshots.id, version!.requested_grant_snapshot_id!));
    return { app_version_id: versionId, expected_package_digest: version!.package_digest,
      expected_requested_snapshot_digest: requested!.snapshot_digest, expected_lifecycle_epoch: lifecycle,
      expected_grant_epoch: grant, connector_selections: [{ connector_requirement_key: 'mail_provider', mcp_connection_id: connection }] };
  };
  const initialPins = await pins(staged.version_id, staged.lifecycle_epoch, staged.grant_epoch);
  const initialReview = await prepareConnectedAppReview(actor, staged.id, initialPins, capability);
  await activateConnectedAppInstallation(actor, staged.id, { ...initialPins, expected_review_digest: initialReview.review_digest,
    accept_host_policy: true }, capability);
  const installation = async () => (await db.select().from(appInstallations).where(eq(appInstallations.id, staged.id)))[0]!;
  const prior = await installation();
  const binding = async (appId: string) => (await db.select({ binding: appModuleBindings, version: moduleVersions }).from(appModuleBindings)
    .innerJoin(moduleVersions, eq(moduleVersions.id, appModuleBindings.module_version_id))
    .where(eq(appModuleBindings.app_installation_id, appId)))[0]!;
  const campaigns = await binding(staged.id), contacts = await binding(dependency.id);
  const contact = await createModuleRecord(actor, { module_id: 'org.deft.reference.resource-contacts', collection_key: 'contacts',
    data: { name: 'Synthetic recipient', email: 'recipient@example.test' }, relations: {}, expected_manifest_digest: contacts.version.manifest_digest,
    idempotency_key: randomUUID() });
  const campaign = await createModuleRecord(actor, { module_id: 'org.deft.reference.resource-campaigns', collection_key: 'campaigns',
    data: { name: 'Synthetic campaign', subject: 'Bounded proof', body: 'Synthetic content', status: 'ready' }, relations: {},
    expected_manifest_digest: campaigns.version.manifest_digest, idempotency_key: randomUUID() });
  assert.ok(contact.record && campaign.record);
  const ref = (id: string, type: string, record: string) => ({ schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
    provider: { kind: 'module' as const, provider_instance_id: id }, resource_type: type, resource_id: record });
  const placement = ref(campaigns.binding.module_installation_id, 'campaigns', campaign.record.id);
  const selected = ref(contacts.binding.module_installation_id, 'contacts', contact.record.id);
  await replaceResourceRelation(actor, { schema_version: RESOURCE_CONTRACT_VERSIONS.relation, source: placement, relation_key: 'contacts',
    refs: [selected], expected_revision: 0, idempotency_key: randomUUID() });
  const [action] = await db.select().from(appActionBindings).where(and(eq(appActionBindings.app_installation_id, staged.id),
    eq(appActionBindings.app_version_id, prior.active_version_id!)));
  const makeFire = async () => {
    const createdAt = new Date(Date.now() - 120_000), scheduledAt = new Date(Math.floor((Date.now() - 60_000) / 60_000) * 60_000);
    const input = { app_installation_id: staged.id, app_version_id: prior.active_version_id!, action_binding_id: action!.id,
      automation_request_key: 'daily_campaign_send', placement: { resource_ref: placement, revision: String(campaign.record!.revision),
        content_digest: digestAppGrantValue(campaign.record!.data) }, selected: { resource_ref: selected, revision: String(contact.record!.revision),
        content_digest: digestAppGrantValue(contact.record!.data) }, local_time: scheduledAt.toISOString().slice(11, 16), timezone: 'UTC',
      validity_seconds: 86_400, max_org_runs_per_utc_day: 100, max_pending_org_fires: 25 } as const;
    const review = await prepareAppAutomationDefinitionReview(actor, input);
    const definition = await createReviewedAppAutomationDefinition(actor, { ...input, expected_review_digest: review.review_digest,
      accept_code_owned_policy: true }, { now: () => createdAt });
    const fire = await persistAppAutomationFire({ organization_id: org, definition_id: definition.id, expected_epoch: definition.definition_epoch,
      logical_local_date: scheduledAt.toISOString().slice(0, 10), resolution: { kind: 'resolved', resolved_at_utc: scheduledAt } });
    return { definition, fire };
  };
  const makeRun = async () => {
    const { definition, fire } = await makeFire();
    const claimed = await db.transaction(tx => claimAppAutomationFireWithExecutor(tx, { organization_id: org, definition_id: definition.id,
      fire_id: fire.id, expected_epoch: definition.definition_epoch, claim_owner: 'c13-fixture', claim_token: randomUUID(),
      claimed_at: new Date(), lease_expires_at: new Date(Date.now() + 60_000) }));
    assert.ok(claimed?.claim_token);
    const run = await appActionService.invokeApprovedAutomation({ organization_id: org, definition_id: definition.id, fire_id: fire.id,
      claim_token: claimed.claim_token });
    return { definition, fire, run };
  };
  const makeManualRun = async () => {
    const input = { binding_id: action!.id, resource_ref: placement,
      selections: [{ input_key: 'selected_contact_email', resource_ref: selected }], idempotency_key: randomUUID() };
    // Use the declaration's exact selected-relation input key.
    const manifest = built.package.manifest;
    const declared = manifest.actions[0]!.input_bindings.find(item => item.source.kind === 'selected_relation_field')!;
    input.selections[0]!.input_key = declared.input_key;
    const actionActor = { ...actor, source: 'ui' as const };
    const prepared = await appActionService.prepare({ actor: actionActor }, input);
    return appActionService.invoke({ actor: actionActor }, { ...input, input_candidate: prepared.input_candidate });
  };
  const session = await createWebSession({ id: user, org_id: org, email: `c13-${user}@example.test` });
  const app = new Hono(); app.use('/api/*', authMiddleware); app.route('/api/apps', appRoutes);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }); servers.push(server);
  if (!server.listening) await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = async (path: string, body: unknown, raw = false) => fetch(`http://127.0.0.1:${address.port}/api/apps/${staged.id}${path}`,
    { method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }, body: raw ? String(body) : JSON.stringify(body) });
  const upgrade = await stageAppUpgrade(actor, staged.id, (await (upgradeProtocol === '1'
    ? buildPhase5ConnectedAppPackage({ app_version: '3.0.1' }) : buildTrackAAutomatedConnectedAppPackage({ app_version: '3.0.1' }))).json,
    prior.lifecycle_epoch);
  const upgradePins = { ...await pins(upgrade.version_id, prior.lifecycle_epoch, prior.grant_epoch),
    schema_version: 'deft.connected_app_upgrade_request.v1' as const, prior_app_version_id: prior.active_version_id!,
    pending_work_policy: 'supersede_pending_work' as const };
  const prepare = async () => { const response = await request('/upgrade/review', upgradePins); assert.equal(response.status, 200);
    return await response.json() as Awaited<ReturnType<typeof activateConnectedAppUpgrade>>; };
  const activate = async () => { const review = await prepare(); const response = await request('/upgrade/activate', { ...upgradePins,
    expected_review_digest: review.connected_review.review_digest, expected_upgrade_review_digest: review.upgrade_review_digest, accept_host_policy: true });
    assert.equal(response.status, 200); return response.json(); };
  return { org, actor, prior, installation, makeFire, makeRun, makeManualRun, upgradePins, prepare, activate, request, session, capability, providerLedger };
}

test('connected explicit supersede is strict, blocks legacy upgrade bypass and preserves prior pointers on rollback', { skip: !safe }, async () => {
  const f = await fixture(); const review = await f.prepare();
  const legacy = await prepareConnectedAppReview(f.actor, f.prior.id, f.upgradePins, f.capability);
  assert.deepEqual(review.connected_review, legacy, 'v1 review bytes and digest remain unchanged');
  const { schema_version, prior_app_version_id, pending_work_policy, ...legacyPins } = f.upgradePins;
  const old = await f.request('/review/activate', { ...legacyPins, expected_review_digest: legacy.review_digest, accept_host_policy: true });
  assert.equal(old.status, 409); assert.equal((await old.json() as { code: string }).code, 'APP_REVIEW_REQUIRED');
  assert.equal((await f.request('/upgrade/review', { ...f.upgradePins, pending_work_policy: 'drain_before_activation' })).status, 400);
  assert.equal((await f.request('/upgrade/review', { ...f.upgradePins, extra: true })).status, 400);
  assert.equal((await f.request('/upgrade/review', '{', true)).status, 400);
  assert.equal((await f.request('/upgrade/review?unexpected=true', f.upgradePins)).status, 400);
  const activation = { ...f.upgradePins, expected_review_digest: legacy.review_digest, expected_upgrade_review_digest: review.upgrade_review_digest,
    accept_host_policy: true };
  const tampered = await f.request('/upgrade/activate', { ...activation, expected_upgrade_review_digest: `sha256:${'0'.repeat(64)}` });
  assert.equal(tampered.status, 409);
  await assert.rejects(activateConnectedAppUpgrade(f.actor, f.prior.id, activation, f.capability, { failBeforePointerSwap: true }), /Injected/);
  assert.deepEqual(await f.installation(), f.prior);
  await f.activate();
  const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.org_id, f.org), eq(auditLog.action, 'app.review_activate')))
    .orderBy(sql`${auditLog.created_at} DESC`).limit(1);
  assert.equal(audit!.metadata?.pending_work_policy, 'supersede_pending_work');
});

test('connected upgrade normal dispatcher terminalizes exact old pending and claimed fires without rebinding or creating Runs', { skip: !safe }, async () => {
  const f = await fixture(); const pending = await f.makeFire(), claimed = await f.makeFire();
  const leased = await db.transaction(tx => claimAppAutomationFireWithExecutor(tx, { organization_id: f.org, definition_id: claimed.definition.id,
    fire_id: claimed.fire.id, expected_epoch: claimed.definition.definition_epoch, claim_owner: 'c13-old', claim_token: randomUUID(),
    claimed_at: new Date(), lease_expires_at: new Date(Date.now() + 60_000) }));
  await f.activate();
  for (const value of [pending, claimed]) {
    const delivery = { id: randomUUID(), name: 'app-automation-fire', data: { organization_id: f.org,
      definition_id: value.definition.id, fire_id: value.fire.id, definition_epoch: value.definition.definition_epoch }, attempts: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000) };
    if (value === claimed) await assert.rejects(runAppAutomationFire(delivery), /still leased/);
    await runAppAutomationFire(delivery, value === claimed ? new Date(leased!.lease_expires_at!.getTime() + 1) : new Date());
    const [fire] = await db.select().from(appAutomationFires).where(eq(appAutomationFires.id, value.fire.id));
    assert.equal(fire!.state, 'skipped'); assert.equal(fire!.terminal_reason, 'definition_ineligible'); assert.equal(fire!.app_run_id, null);
    assert.equal(fire!.definition_id, value.definition.id); assert.equal(fire!.definition_epoch, value.definition.definition_epoch);
  }
  assert.equal((await db.select().from(appRuns).where(eq(appRuns.org_id, f.org))).length, 0);
});

test('connected supersede denies old unstarted Run dispatch and normal retention expires it under retained original pins', { skip: !safe }, async () => {
  const f = await fixture(); const { run } = await f.makeRun(); const runtime = await getAppRunRuntime();
  const [before] = await db.select().from(appRuns).where(eq(appRuns.id, run.id));
  await f.activate(); let effects = 0;
  const runner = new AppRunAttemptRunner(runtime.repository, runtime.secretRepository, new AppRunSecretService(runtime.keys),
    { execute: async () => { effects++; return { status: 'indeterminate' }; } }, runtime.liveAuthorization);
  const [attempt] = await db.select().from(appRunAttempts).where(eq(appRunAttempts.run_id, run.id)); assert.ok(attempt);
  await runner.run(f.org, run.id, attempt.id, 'c13-old-delivery'); assert.equal(effects, 0);
  await runtime.service.purgeExpiredSecrets(new Date(before!.input_expires_at.getTime() + 1), 100);
  const [after] = await db.select().from(appRuns).where(eq(appRuns.id, run.id)); assert.equal(after!.state, 'expired');
  assert.equal(after!.origin_app_version_id, f.prior.active_version_id); assert.equal(after!.origin_app_grant_snapshot_id, f.prior.active_grant_snapshot_id);
  assert.equal((await db.select().from(appVersions).where(eq(appVersions.id, before!.origin_app_version_id!))).length, 1);
  assert.equal((await db.select().from(appGrantSnapshots).where(eq(appGrantSnapshots.id, before!.origin_app_grant_snapshot_id!))).length, 1);
});

test('connected upgrade retains started ambiguous effect and signed unknown outcome under old pins without effect retry', { skip: !safe }, async () => {
  const f = await fixture(); const { run } = await f.makeRun(); const runtime = await getAppRunRuntime();
  let started!: () => void, release!: () => void, effects = 0, hold = false;
  const acceptedKeys = new Set<string>(); const secrets = new AppRunSecretService(runtime.keys);
  const provider = new PinnedMcpAppRunProviderExecutor();
  const startedGate = new Promise<void>(done => { started = done; }), released = new Promise<void>(done => { release = done; });
  const runner = new AppRunAttemptRunner(runtime.repository, runtime.secretRepository, secrets, { execute: async request => {
    assert.ok(request.dispatch_pin && request.provider_idempotency_key);
    const accepted = await provider.execute(request);
    assert.equal(accepted.status, 'returned');
    assert.ok(accepted.status === 'returned' && accepted.provider_succeeded, 'real synthetic provider accepted the effect');
    if (!acceptedKeys.has(request.provider_idempotency_key)) { acceptedKeys.add(request.provider_idempotency_key); effects++; }
    if (hold) { started(); await released; } return { status: 'indeterminate' };
  } }, runtime.liveAuthorization, () => new Date(), 60_000, 20_000, new PostgresAppRunReceiptWriter(secrets, runtime.secretRepository));
  const original = await runtime.repository.inspect(f.org, run.id); assert.ok(original);
  for (let number = 1; number < original.attempt_limit; number++) {
    const [current] = await db.select().from(appRunAttempts).where(and(eq(appRunAttempts.run_id, run.id), eq(appRunAttempts.state, 'pending')));
    assert.ok(current); await runner.run(f.org, run.id, current.id, `c13-idempotent-recovery-${number}`);
  }
  hold = true;
  const [attempt] = await db.select().from(appRunAttempts).where(and(eq(appRunAttempts.run_id, run.id), eq(appRunAttempts.state, 'pending'))); assert.ok(attempt);
  const running = runner.run(f.org, run.id, attempt.id, 'c13-started');
  try { await Promise.race([startedGate, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('provider boundary not observed')), 10_000); timer.unref(); })]);
    const [startedAttempt] = await db.select().from(appRunAttempts).where(eq(appRunAttempts.id, attempt.id));
    assert.equal(startedAttempt!.state, 'provider_call_started'); await f.activate();
  } finally { release(); }
  await running; assert.equal((await runtime.repository.inspect(f.org, run.id))!.state, 'unknown_outcome'); assert.equal(effects, 1);
  await runner.run(f.org, run.id, attempt.id, 'c13-duplicate'); assert.equal(effects, 1);
  const [persisted] = await db.select().from(appRuns).where(eq(appRuns.id, run.id));
  assert.equal(persisted!.origin_app_version_id, f.prior.active_version_id);
  assert.equal(persisted!.origin_app_grant_snapshot_id, f.prior.active_grant_snapshot_id);
  const receipts = await db.select().from(appRunReceipts).where(eq(appRunReceipts.run_id, run.id)); assert.equal(receipts.length, original.attempt_limit);
  assert.equal((await runtime.receiptReader.readVerified(f.org, run.id)).length, original.attempt_limit);
  assert.equal((await readFile(f.providerLedger, 'utf8')).trim().split('\n').length, 1, 'real separate-process provider accepted exactly one idempotent effect');
  console.log('[c13 accepted-effect proof]', JSON.stringify({ provider_ledger: f.providerLedger, accepted_effects: 1,
    verified_receipts: original.attempt_limit, post_upgrade_dispatches: 0 }));
});

test('explicit connected supersede preserves supported protocol1 to protocol2 reviewed upgrade', { skip: !safe }, async () => {
  const f = await fixture('1');
  await f.activate();
  const current = await f.installation(); assert.equal(current.active_version_id, f.upgradePins.app_version_id);
  const [prior] = await db.select().from(appVersions).where(eq(appVersions.id, f.prior.active_version_id!));
  assert.equal(prior!.state, 'superseded'); assert.equal(prior!.protocol_version, '1');
});

test('protocol1 upgrade requires explicit supersede and never rebinds a pending manual Run', { skip: !safe }, async () => {
  const f = await fixture('1', '1'); const run = await f.makeManualRun(); const review = await f.prepare();
  const { schema_version, prior_app_version_id, pending_work_policy, ...legacyPins } = f.upgradePins;
  const legacy = await f.request('/review/activate', { ...legacyPins, expected_review_digest: review.connected_review.review_digest, accept_host_policy: true });
  assert.equal(legacy.status, 409); assert.equal((await legacy.json() as { code: string }).code, 'APP_REVIEW_REQUIRED');
  await f.activate(); const runtime = await getAppRunRuntime();
  const [before] = await db.select().from(appRuns).where(eq(appRuns.id, run.id)); assert.ok(before);
  assert.equal(before.origin_app_version_id, f.prior.active_version_id);
  assert.equal(before.origin_app_grant_snapshot_id, f.prior.active_grant_snapshot_id);
  assert.equal(before.state, 'pending_approval');
  const [approval] = await db.select().from(agentActions).where(eq(agentActions.app_run_id, run.id)); assert.ok(approval);
  const decision = await runtime.approvalResolver.approve(approval.id, f.actor.actor_id);
  assert.equal(decision.status, 'error', 'old current authority cannot release a newly unauthorized effect');
  assert.equal((await runtime.repository.inspect(f.org, run.id))!.state, 'expired');
});

test('connected upgrade final web SID fence denies revocation during a real App lock wait and rolls back', { skip: !safe }, async () => {
  const f = await fixture(); const review = await f.prepare();
  const { default: pg } = await import('pg'); const lock = new pg.Client({ connectionString: target }); await lock.connect();
  const pid = (await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await lock.query('BEGIN'); await lock.query('SELECT id FROM app_installations WHERE org_id=$1 AND id=$2 FOR UPDATE', [f.org, f.prior.id]);
  const response = f.request('/upgrade/activate', { ...f.upgradePins, expected_review_digest: review.connected_review.review_digest,
    expected_upgrade_review_digest: review.upgrade_review_digest, accept_host_policy: true });
  try {
    const deadline = Date.now() + 10_000; let waited = false;
    while (Date.now() < deadline) {
      await lock.query('SELECT pg_stat_clear_snapshot()');
      const row = await lock.query<{ waited: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waited', [pid]);
      if (row.rows[0]?.waited) { waited = true; break; }
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(waited, true, 'actual blocked activation observed before revocation');
    await revokeWebSession(f.session.refreshToken);
  } finally { await lock.query('ROLLBACK'); await lock.end(); }
  assert.equal((await response).status, 401); assert.deepEqual(await f.installation(), f.prior);
});
