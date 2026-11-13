/**
 * App Run approval flags equal a fresh decision by `/api/agent/actions/:id/approve|reject`
 * for the same viewer, are read without writing, and are bounded per response.
 * Run only against a disposable DB (DEFT_TEST_DATABASE_URL).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import { APP_RUN_CONTRACT_VERSIONS, createCapabilityProviderDiscoverySnapshot } from '@deft/shared';

import { agentRoutes } from '../src/routes/agent.js';
import { _setAppRunApprovalResolverForTest, viewerReviewAuthority } from '../src/lib/agent-approval-resolver.js';
import { PostgresAppRunApprovalResolver } from '../src/lib/app-run-approval-adapter.js';
import { appRunApproveStep, appRunReviewSteps } from '../src/lib/app-run-approval-review.js';
import { PostgresAppRunLiveAuthorization } from '../src/lib/app-run-live-authorization.js';
import { PostgresAppRunRepository } from '../src/lib/app-run-repository.js';
import { AppRunSecretRepository } from '../src/lib/app-run-secret-repository.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';
import { AppRunService } from '../src/lib/app-run-service.js';
import { parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import { durabilityDatabaseUrl, setupDurabilityFixture, type DurabilityFixture } from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;
let app: Hono;
let ownerId: string;
let guestId: string;
let employeeId: string;
let providerId: string;
let snapshotId: string;
let snapshotDigest: string;
let service: AppRunService;
let live: PostgresAppRunLiveAuthorization;
let resolver: PostgresAppRunApprovalResolver;
let clockOffsetMs = 0;
const roles = new Map<string, string>();
const keyBytes = (seed: number) => Buffer.alloc(32, seed).toString('base64');
const keys = parseEnvironmentAppRunKeyrings(JSON.stringify({
  schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
  run_encryption: { current: 'flags-enc', keys: { 'flags-enc': keyBytes(21) } },
  receipt_signing: { current: 'flags-sig', keys: { 'flags-sig': keyBytes(22) } },
  fingerprint: { current: 'flags-fp', keys: { 'flags-fp': keyBytes(23) } },
}));
const policy = { risk_class: 'external_write', review_requirement: 'always', review_scope: 'per_invocation', retry_class: 'unsafe_or_unknown' } as const;

async function addUser(role: string, kind: 'human' | 'agent' = 'human'): Promise<string> {
  const id = randomUUID();
  await f.client.query(`INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, $4, $5, true)`,
    [id, `app-run-flags-${id}@example.test`, `Flags ${role} ${id.slice(0, 4)}`, kind, kind === 'agent']);
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, id, role]);
  roles.set(id, role);
  return id;
}

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('AF');
  roles.set(f.requesterId, 'member');
  roles.set(f.otherId, 'member');
  roles.set(f.adminId, 'admin');
  ownerId = await addUser('owner');
  guestId = await addUser('guest');
  const shadowId = await addUser('member', 'agent');
  employeeId = randomUUID();
  providerId = `flags-provider-${employeeId.slice(0, 8)}`;
  snapshotId = `flags-snapshot-${employeeId.slice(0, 8)}`;
  await f.client.query(`INSERT INTO mcp_connections (id, org_id, name, slug, server_url, transport, auth_type, is_active,
      default_trust_tier, enabled_tools, created_by)
    VALUES ($1, $2, 'Flags provider', $1, 'https://example.test/mcp', 'streamable-http', 'none', true, 'full', $3, $4)`,
  [providerId, f.orgId, ['send_email'], f.requesterId]);
  await f.client.query(`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, mcp_connection_ids,
      trust_level, max_daily_actions, daily_action_count, unhealthy, is_active, is_deleted, is_byoa, created_by)
    VALUES ($1, $2, $3, 'Flags employee', $1, 'custom', 'Test', $4, 'autonomous', 100, 0, false, true, false, true, $5)`,
  [employeeId, f.orgId, shadowId, [providerId], f.requesterId]);
  const provider = { org_id: f.orgId, provider_kind: 'mcp' as const, provider_instance_id: providerId };
  const snapshot = await createCapabilityProviderDiscoverySnapshot({
    adapter_contract_version: 'deft.capability.mcp-adapter.v1', provider, captured_at: new Date().toISOString(),
    operations: [{ identity: { provider, operation_name: 'send_email' }, description: 'Send one email', input_schema: { type: 'object' } }],
  });
  snapshotDigest = snapshot.snapshot_digest;
  await f.client.query(`INSERT INTO capability_provider_snapshots (id, org_id, provider_kind, provider_instance_id,
      adapter_contract_version, snapshot_digest, safe_snapshot, captured_at) VALUES ($1, $2, 'mcp', $3, $4, $5, $6::jsonb, $7)`,
  [snapshotId, f.orgId, providerId, snapshot.adapter_contract_version, snapshot.snapshot_digest, JSON.stringify(snapshot), snapshot.captured_at]);
  const repository = new PostgresAppRunRepository();
  const secrets = new AppRunSecretService(keys);
  service = new AppRunService(repository, new AppRunSecretRepository(secrets), secrets, keys, { async authorize() { return true; } });
  live = new PostgresAppRunLiveAuthorization();
  resolver = new PostgresAppRunApprovalResolver(repository, live, () => new Date(Date.now() + clockOffsetMs));
  _setAppRunApprovalResolverForTest(resolver);

  app = new Hono();
  app.use('*', async (c, next) => {
    const id = c.req.header('x-test-user')!;
    c.set('user', { id, org_id: f.orgId, email: `${id}@example.test`, sid: '', role: roles.get(id) } as any);
    await next();
  });
  app.route('/api/agent', agentRoutes);
});

after(async () => {
  _setAppRunApprovalResolverForTest(null);
  if (!f) return;
  for (const table of ['app_run_receipts', 'app_run_events', 'app_run_attempts', 'app_run_secret_payloads', 'agent_actions',
    'app_runs', 'capability_provider_snapshots', 'mcp_connections']) {
    await f.client.query(`DELETE FROM ${table} WHERE org_id = $1`, [f.orgId]).catch(() => undefined);
  }
  await f.teardown();
  keys.destroy();
});

/** A pending MCP App Run requested by the requester and run by the employee, with its approval. */
async function pendingRun(): Promise<{ actionId: string; runId: string }> {
  const executionActor = { actor_type: 'agent_employee' as const, agent_employee_id: employeeId };
  const initiatingActor = { actor_type: 'human' as const, user_id: f.requesterId };
  const operation = { provider: { org_id: f.orgId, provider_kind: 'mcp' as const, provider_instance_id: providerId }, operation_name: 'send_email' };
  const authorization = await live.capture({ org_id: f.orgId, authenticated_subject: initiatingActor, execution_actor: executionActor,
    provider_instance_id: providerId, provider_snapshot_id: snapshotId, operation_name: 'send_email', policy });
  const run = await service.submit({ org_id: f.orgId, initiating_actor: initiatingActor, execution_actor: executionActor }, {
    schema_version: APP_RUN_CONTRACT_VERSIONS.run, org_id: f.orgId, initiating_actor: initiatingActor, execution_actor: executionActor,
    origin: { origin_kind: 'legacy_connector', connection_id: providerId }, operation, provider_snapshot_digest: snapshotDigest, policy,
    retention_class: 'standard', idempotency_key: `flags-${randomUUID()}`, input: { body: 'hello' }, authorization_snapshot: authorization,
    safe_preview: { schema_version: APP_RUN_CONTRACT_VERSIONS.run, title: 'Send one email', resource_refs: [] },
  });
  const { rows } = await f.client.query<{ id: string }>('SELECT id FROM agent_actions WHERE org_id = $1 AND app_run_id = $2', [f.orgId, run.id]);
  assert.equal(rows.length, 1);
  return { actionId: rows[0]!.id, runId: run.id };
}

const viewer = (id: string) => ({ id, org_id: f.orgId, role: roles.get(id) });

async function runState(runId: string) {
  const { rows } = await f.client.query<{ state: string; release: string | null }>(
    'SELECT state, execution_release_kind AS release FROM app_runs WHERE org_id = $1 AND id = $2', [f.orgId, runId]);
  return rows[0]!;
}

/** Whether the endpoint takes `decision` freshly for this viewer: it answers 200 and records that very decision. */
async function endpointDecides(viewerId: string, ids: { actionId: string; runId: string }, decision: 'approve' | 'reject') {
  const before = await runState(ids.runId);
  const response = await app.request(`/api/agent/actions/${ids.actionId}/${decision}`, {
    method: 'POST', body: '{}', headers: { 'x-test-user': viewerId, 'content-type': 'application/json' },
  });
  const after = await runState(ids.runId);
  return response.status === 200 && (decision === 'approve'
    ? before.release !== 'approved' && after.release === 'approved'
    : before.state !== 'cancelled' && after.state === 'cancelled');
}

type Setup = (ids: { actionId: string; runId: string }) => Promise<void>;
const none: Setup = async () => undefined;

/**
 * Flags for `viewerId` on two twin runs, each compared with the endpoint's
 * fresh decision. `cleanup` undoes `setup` before the next run is created.
 */
async function checkCase(name: string, viewerId: string, setup: Setup, expected: { approve: boolean; reject: boolean },
  cleanup: () => Promise<unknown> = async () => undefined) {
  const flags: Record<'approve' | 'reject', boolean | undefined> = { approve: undefined, reject: undefined };
  for (const decision of ['approve', 'reject'] as const) {
    const ids = await pendingRun();
    await setup(ids);
    try {
      const entry = (await viewerReviewAuthority(viewer(viewerId), [ids.actionId])).get(ids.actionId);
      assert.ok(entry, `${name}: the row has flags`);
      assert.equal(typeof entry.viewer_can_reject, 'boolean', `${name}: reject flag present`);
      const flag = decision === 'approve' ? entry.viewer_can_approve : entry.viewer_can_reject;
      assert.equal(flag, await endpointDecides(viewerId, ids, decision), `${name}: ${decision} flag equals the endpoint`);
      flags[decision] = flag;
    } finally {
      await cleanup();
    }
  }
  assert.deepEqual(flags, expected, name);
}

const setEmployee = (column: 'daily_action_count = max_daily_actions' | 'unhealthy = true') => async () => {
  await f.client.query(`UPDATE agent_employees SET ${column} WHERE id = $1`, [employeeId]);
};
const restoreEmployee = () => f.client.query('UPDATE agent_employees SET daily_action_count = 0, unhealthy = false WHERE id = $1', [employeeId]);
const setRequesterActive = (active: boolean) => f.client.query(
  'UPDATE org_members SET is_active = $3 WHERE org_id = $1 AND user_id = $2', [f.orgId, f.requesterId, active]);

test('App Run flags equal the endpoint decision for each viewer', { skip: !canRun, timeout: 900_000 }, async () => {
  await checkCase('requester, open run', f.requesterId, none, { approve: true, reject: true });
  // The requester is an active human member, so the gate leaves owners/admins out.
  await checkCase('admin while the requester is active', f.adminId, none, { approve: false, reject: false });
  await checkCase('owner while the requester is active', ownerId, none, { approve: false, reject: false });
  await checkCase('another member', f.otherId, none, { approve: false, reject: false });
  await checkCase('guest', guestId, none, { approve: false, reject: false });
});

test('App Run flags follow a requester who lost access', { skip: !canRun, timeout: 900_000 }, async (t) => {
  t.after(() => setRequesterActive(true));
  const deactivate: Setup = async () => { await setRequesterActive(false); };
  const reactivate = () => setRequesterActive(true);
  // The run loses its captured authority: owners/admins may cancel it, nobody may release it.
  await checkCase('requester without access', f.requesterId, deactivate, { approve: false, reject: false }, reactivate);
  await checkCase('admin after the requester lost access', f.adminId, deactivate, { approve: false, reject: true }, reactivate);
  await checkCase('owner after the requester lost access', ownerId, deactivate, { approve: false, reject: true }, reactivate);
});

test('App Run flags follow the run and budget state', { skip: !canRun, timeout: 900_000 }, async (t) => {
  t.after(restoreEmployee);
  const settle = (decision: 'approve' | 'reject'): Setup => async (ids) => {
    assert.equal(await endpointDecides(f.requesterId, ids, decision), true, `setup ${decision}`);
  };
  await checkCase('released run', f.requesterId, settle('approve'), { approve: false, reject: false });
  await checkCase('cancelled run', f.requesterId, settle('reject'), { approve: false, reject: false });
  // The resolver's clock moves past the approval input's lifetime (the column is immutable).
  const inputExpired: Setup = async () => { clockOffsetMs = 8 * 86_400_000; };
  const clockBack = async () => { clockOffsetMs = 0; };
  await checkCase('approval input expired', f.requesterId, inputExpired, { approve: false, reject: true }, clockBack);
  // An approval of an expired input expires the run; after that nothing decides it.
  await checkCase('expired run', f.requesterId, async (ids) => {
    await inputExpired(ids);
    assert.equal(await endpointDecides(f.requesterId, ids, 'approve'), false);
    assert.equal((await runState(ids.runId)).state, 'expired');
  }, { approve: false, reject: false }, clockBack);
  await checkCase('employee at its daily cap', f.requesterId, setEmployee('daily_action_count = max_daily_actions'),
    { approve: false, reject: true }, restoreEmployee);
  await checkCase('unhealthy employee', f.requesterId, setEmployee('unhealthy = true'), { approve: false, reject: true }, restoreEmployee);
});

test('reading App Run flags writes nothing', { skip: !canRun, timeout: 900_000 }, async () => {
  await restoreEmployee();
  const ids = await pendingRun();
  const snapshot = async () => (await f.client.query(`SELECT
      (SELECT row_to_json(e) FROM (SELECT daily_action_count, updated_at FROM agent_employees WHERE id = $2) e) AS employee,
      (SELECT row_to_json(r) FROM (SELECT state, execution_release_kind, budget_reserved_at, budget_reserved_count, updated_at
         FROM app_runs WHERE org_id = $1 AND id = $3) r) AS run,
      (SELECT row_to_json(a) FROM (SELECT approval_status, updated_at FROM agent_actions WHERE id = $4) a) AS action,
      (SELECT count(*) FROM app_run_events WHERE org_id = $1) AS events,
      (SELECT count(*) FROM app_run_receipts WHERE org_id = $1) AS receipts,
      (SELECT count(*) FROM app_run_attempts WHERE org_id = $1) AS attempts,
      (SELECT count(*) FROM job_queue WHERE org_id = $1) AS jobs`, [f.orgId, employeeId, ids.runId, ids.actionId])).rows[0];
  const before = await snapshot();
  const entry = (await viewerReviewAuthority(viewer(f.requesterId), [ids.actionId])).get(ids.actionId);
  assert.deepEqual(entry, { viewer_can_approve: true, viewer_can_reject: true }, 'the live approve check ran');
  assert.deepEqual(await snapshot(), before);
});

test('App Run approve checks stop at 10 per response and run 2 at once', { skip: !canRun, timeout: 900_000 }, async (t) => {
  await restoreEmployee();
  const runs = [];
  for (let i = 0; i < 12; i += 1) runs.push(await pendingRun());
  const actionIds = runs.map((run) => run.actionId);
  const entries = await viewerReviewAuthority(viewer(f.requesterId), actionIds);
  const withApprove = actionIds.filter((id) => 'viewer_can_approve' in entries.get(id)!);
  assert.equal(withApprove.length, 10, 'ten rows get the approve check');
  for (const id of actionIds) assert.equal(entries.get(id)!.viewer_can_reject, true, 'every row has its reject flag');
  for (const id of actionIds.filter((id) => !withApprove.includes(id))) {
    assert.equal(entries.get(id)!.viewer_can_approve, undefined, 'past the limit the approve flag is absent, not false');
  }

  let running = 0;
  let mostAtOnce = 0;
  let reads = 0;
  let onRead = async (_runId: string): Promise<boolean | undefined> => true;
  _setAppRunApprovalResolverForTest(new PostgresAppRunApprovalResolver(new PostgresAppRunRepository(), {
    authorizeApprovalInTransaction: (tx, run, now) => live.authorizeApprovalInTransaction(tx, run, now),
    async authorizeApprovalRead(run) {
      running += 1; reads += 1; mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise((resolve) => setTimeout(resolve, 25));
      running -= 1;
      return onRead(run.id);
    },
  }));
  t.after(() => _setAppRunApprovalResolverForTest(resolver));
  await Promise.all([viewerReviewAuthority(viewer(f.requesterId), actionIds), viewerReviewAuthority(viewer(f.requesterId), actionIds)]);
  assert.equal(reads, 20);
  assert.equal(mostAtOnce, 2, 'two checks at once across requests in this process');

  // A run rejected while its check waits for a slot is read again; a check that could not run leaves approve out.
  let rejected!: () => void;
  const rejection = new Promise<void>((resolve) => { rejected = resolve; });
  onRead = async (runId) => {
    // The first check rejects run 5; the other checks hold their slots until it has.
    if (runId === runs[0]!.runId) {
      assert.equal(await endpointDecides(f.requesterId, runs[5]!, 'reject'), true);
      rejected();
    } else await rejection;
    return runId === runs[6]!.runId ? undefined : true;
  };
  const later = await viewerReviewAuthority(viewer(f.requesterId), actionIds);
  assert.deepEqual(later.get(runs[5]!.actionId), { viewer_can_approve: false, viewer_can_reject: false });
  assert.deepEqual(later.get(runs[6]!.actionId), { viewer_can_reject: true });
});

test('an approval replay reads the resolver clock no more often than before', () => {
  let reads = 0;
  const clock = () => { reads += 1; return new Date(); };
  const pending = { state: 'pending_approval', input_expires_at: new Date(Date.now() + 60_000) } as const;
  const action = { user_id: 'owner', approval_status: 'pending' };
  assert.equal(appRunApproveStep({ ...pending, execution_release_kind: 'approved' } as Parameters<typeof appRunApproveStep>[0], action, clock), 'replay_approved');
  assert.equal(appRunApproveStep({ ...pending, state: 'cancelled', execution_release_kind: null } as Parameters<typeof appRunApproveStep>[0], action, clock), 'replay_rejected');
  assert.equal(reads, 0);
});

test('App Run flags stay in the viewer workspace', { skip: !canRun, timeout: 900_000 }, async () => {
  const ids = await pendingRun();
  const outsider = { id: f.requesterId, org_id: randomUUID(), role: 'owner' };
  assert.equal((await viewerReviewAuthority(outsider, [ids.actionId])).has(ids.actionId), false);
});

test('native and protocol-7 approve is left out unless a common rule refuses; owner-only releases refuse others', () => {
  const now = new Date();
  const open = { state: 'pending_approval', execution_release_kind: null, input_expires_at: new Date(now.getTime() + 60_000) } as const;
  const row = { user_id: 'owner', approval_status: 'pending', approve: true, reject: true };
  const steps = (run: object, protocol: string | null, viewerId = 'owner') =>
    appRunReviewSteps({ ...open, ...run } as Parameters<typeof appRunReviewSteps>[0], protocol, row, viewerId, () => now);
  assert.deepEqual(steps({ provider_kind: 'native', initiating_actor_type: 'human' }, null), { approve: 'unknown', reject: true });
  assert.deepEqual(steps({ provider_kind: 'app_runtime', initiating_actor_type: 'human' }, '7'), { approve: 'unknown', reject: true });
  assert.deepEqual(steps({ provider_kind: 'app_runtime', initiating_actor_type: 'human' }, '6'), { approve: 'live', reject: true });
  assert.deepEqual(steps({ provider_kind: 'app_runtime', initiating_actor_type: 'agent_employee' }, '6', 'admin'), { approve: false, reject: true });
  assert.deepEqual(steps({ provider_kind: 'app_runtime', initiating_actor_type: 'app_public' }, '6', 'admin'), { approve: false, reject: false });
  assert.deepEqual(steps({ provider_kind: 'native', initiating_actor_type: 'human' }, null, 'admin'), { approve: false, reject: true });
  assert.deepEqual(steps({ provider_kind: 'mcp', initiating_actor_type: 'human' }, null, 'admin'), { approve: 'live', reject: true });
  // A settled native or protocol-7 approval is refused by the common rules.
  assert.deepEqual(steps({ provider_kind: 'native', initiating_actor_type: 'human', execution_release_kind: 'approved' }, null),
    { approve: false, reject: false });
  assert.deepEqual(steps({ provider_kind: 'app_runtime', initiating_actor_type: 'human', state: 'expired' }, '7'),
    { approve: false, reject: false });
});
