import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import {
  APP_RUN_CONTRACT_VERSIONS,
  createCapabilityProviderDiscoverySnapshot,
} from '@deft/shared';
import { AppRunAttemptRunner } from '../src/lib/app-run-attempt-runner.js';
import type {
  AppRunProviderExecutionRequest,
  AppRunProviderExecutionResult,
  AppRunProviderExecutor,
} from '../src/lib/app-run-provider-executor.js';
import { PostgresAppRunRepository } from '../src/lib/app-run-repository.js';
import { AppRunSecretRepository } from '../src/lib/app-run-secret-repository.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';
import { AppRunService } from '../src/lib/app-run-service.js';
import { PostgresAppRunLiveAuthorization } from '../src/lib/app-run-live-authorization.js';
import { approveAction, rejectAction } from '../src/lib/agent-approval-resolver.js';
import { createAppRunAttemptJobHandler } from '../src/lib/app-run-worker-handler.js';
import { parseEnvironmentAppRunKeyrings, type EnvironmentAppRunKeyProvider } from '../src/lib/app-run-keyrings.js';
import { closeDb } from '../src/lib/db.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL
  ?? (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!DATABASE_URL) throw new Error('App Run engine DB tests require DEFT_TEST_DATABASE_URL');
if (process.env.CI !== 'true' && !/phase3|test|ci|acceptance/i.test(new URL(DATABASE_URL).pathname)) {
  throw new Error('App Run engine DB tests require an explicitly disposable database');
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ORG_ID = `app-run-org-${suffix}`;
const SNAPSHOT_ID = `app-run-snapshot-${suffix}`;
const PROVIDER_ID = `app-run-provider-${suffix}`;
const USER_ID = `app-run-user-${suffix}`;
const digest = `sha256:${'a'.repeat(64)}`;
const { Client } = pg;
let client: pg.Client;
const providers: EnvironmentAppRunKeyProvider[] = [];

function key(seed: number): string {
  return Buffer.alloc(32, seed).toString('base64');
}

function keyProvider(
  fingerprintCurrent: 'fp-v1' | 'fp-old' = 'fp-v1',
  includeOld = true,
): EnvironmentAppRunKeyProvider {
  const provider = parseEnvironmentAppRunKeyrings(JSON.stringify({
    schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
    run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key(1) } },
    receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key(2) } },
    fingerprint: {
      current: fingerprintCurrent,
      keys: includeOld ? { 'fp-v1': key(3), 'fp-old': key(4) } : { 'fp-v1': key(3) },
    },
  }));
  providers.push(provider);
  return provider;
}

const allowAll = { async authorize() { return true; } };
const allowExecution = { async authorizeExecution() { return true; } };

function service(
  now: () => Date = () => new Date(),
  allow = allowAll,
  keyOptions: Readonly<{ current?: 'fp-v1' | 'fp-old'; includeOld?: boolean }> = {},
) {
  const keys = keyProvider(keyOptions.current, keyOptions.includeOld);
  const secrets = new AppRunSecretService(keys);
  const repository = new PostgresAppRunRepository();
  const secretRepository = new AppRunSecretRepository(secrets);
  return {
    service: new AppRunService(repository, secretRepository, secrets, keys, allow, now),
    repository,
    secretRepository,
    secrets,
  };
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: APP_RUN_CONTRACT_VERSIONS.run,
    org_id: ORG_ID,
    initiating_actor: { actor_type: 'human', user_id: USER_ID },
    execution_actor: { actor_type: 'human', user_id: USER_ID },
    origin: { origin_kind: 'legacy_connector', connection_id: PROVIDER_ID },
    operation: {
      provider: { org_id: ORG_ID, provider_kind: 'mcp', provider_instance_id: PROVIDER_ID },
      operation_name: 'send_email',
    },
    provider_snapshot_digest: digest,
    policy: {
      risk_class: 'external_write',
      review_requirement: 'policy',
      review_scope: 'per_invocation',
      retry_class: 'unsafe_or_unknown',
    },
    retention_class: 'standard',
    idempotency_key: `retry-${suffix}`,
    input: { body: `raw-marker-${suffix}`, recipient: 'person@example.test' },
    authorization_snapshot: {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      authenticated_subject: { actor_type: 'human', user_id: USER_ID },
      authority_refs: [
        { authority_kind: 'membership', authority_id: USER_ID, version: '1' },
        { authority_kind: 'connector', authority_id: PROVIDER_ID, version: '1' },
      ],
    },
    safe_preview: {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      title: 'Send one email',
      resource_refs: [],
    },
    ...overrides,
  };
}

const trusted = {
  org_id: ORG_ID,
  initiating_actor: { actor_type: 'human' as const, user_id: USER_ID },
  execution_actor: { actor_type: 'human' as const, user_id: USER_ID },
};

before(async () => {
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [ORG_ID, 'App Run Test', ORG_ID]);
  await client.query(
    'INSERT INTO users (id, email, name) VALUES ($1, $2, $3)',
    [USER_ID, `${USER_ID}@example.test`, 'App Run Test User'],
  );
  await client.query(
    `INSERT INTO capability_provider_snapshots
      (id, org_id, provider_kind, provider_instance_id, adapter_contract_version,
       snapshot_digest, safe_snapshot, captured_at)
     VALUES ($1, $2, 'mcp', $3, 'deft.capability.v1', $4, $5::jsonb, now())`,
    [SNAPSHOT_ID, ORG_ID, PROVIDER_ID, digest, JSON.stringify({ operation: 'send_email' })],
  );
});

after(async () => {
  if (client) {
    await client.query('DELETE FROM agent_actions WHERE user_id = $1', [USER_ID]);
    await client.query('DELETE FROM agent_employees WHERE user_id = $1', [USER_ID]);
    await client.query('DELETE FROM mcp_connections WHERE created_by = $1', [USER_ID]);
    await client.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]);
    await client.query('DELETE FROM users WHERE id = $1', [USER_ID]);
    await client.end();
  }
  for (const provider of providers) provider.destroy();
  await closeDb();
});

test('submission is atomic, rotation-safe, tenant-scoped, and replay-conflict aware', async () => {
  const { service: runs } = service();
  const parallel = await Promise.all(Array.from({ length: 20 }, () => runs.submit(trusted, submission())));
  assert.equal(new Set(parallel.map((run) => run.id)).size, 1);
  const runId = parallel[0]!.id;

  const counts = await client.query<{
    runs: string; inputs: string; created_events: string;
  }>(
    `SELECT
       (SELECT count(*) FROM app_runs WHERE org_id = $1 AND id = $2) AS runs,
       (SELECT count(*) FROM app_run_secret_payloads WHERE org_id = $1 AND run_id = $2 AND payload_kind = 'input') AS inputs,
       (SELECT count(*) FROM app_run_events WHERE org_id = $1 AND run_id = $2 AND event_type = 'run_created') AS created_events`,
    [ORG_ID, runId],
  );
  assert.deepEqual(counts.rows[0], { runs: '1', inputs: '1', created_events: '1' });

  await assert.rejects(
    runs.submit(trusted, submission({ input: { body: 'different', recipient: 'person@example.test' } })),
    (error: any) => error?.code === 'APP_RUN_IDEMPOTENCY_CONFLICT',
  );
  const residue = await client.query<{ row: string }>(
    `SELECT row_to_json(safe)::text AS row FROM (
       SELECT id, org_id, state, safe_preview, safe_outcome, idempotency_fingerprint, input_fingerprint
       FROM app_runs WHERE id = $1
     ) safe`,
    [runId],
  );
  assert.doesNotMatch(residue.rows[0]!.row, new RegExp(`raw-marker-${suffix}|retry-${suffix}`));

  const cancelled = await runs.cancel(ORG_ID, runId, trusted.initiating_actor);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await runs.cancel(ORG_ID, runId, trusted.initiating_actor)).state, 'cancelled');

  const oldKeys = service(() => new Date(), allowAll, { current: 'fp-old' });
  const rotationSubmission = submission({ idempotency_key: `rotation-${suffix}` });
  const beforeRotation = await oldKeys.service.submit(trusted, rotationSubmission);
  const rotated = service();
  assert.equal((await rotated.service.submit(trusted, rotationSubmission)).id, beforeRotation.id);
  const missingOld = service(() => new Date(), allowAll, { includeOld: false });
  await assert.rejects(
    missingOld.service.assertReferencedKeysAvailable(),
    (error: any) => error?.code === 'APP_RUN_KEY_VERSION_UNAVAILABLE',
  );
});

test('idempotency keys can be reused once their host-owned horizon expires', async () => {
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const setup = service(() => clock);
  const request = submission({
    idempotency_key: `horizon-${suffix}`,
    retention_class: 'ephemeral',
  });
  const first = await setup.service.submit(trusted, request);
  clock = new Date('2026-01-09T00:00:00.000Z');
  const replacements = await Promise.all(
    Array.from({ length: 20 }, () => setup.service.submit(trusted, request)),
  );
  assert.equal(new Set(replacements.map((run) => run.id)).size, 1);
  assert.notEqual(replacements[0]!.id, first.id);
  const count = await client.query<{ count: string }>(
    `SELECT count(*) FROM app_runs
      WHERE org_id = $1 AND idempotency_fingerprint = (
        SELECT idempotency_fingerprint FROM app_runs WHERE id = $2
      )`,
    [ORG_ID, first.id],
  );
  assert.equal(count.rows[0]!.count, '2');
});

class CountingExecutor implements AppRunProviderExecutor {
  calls: AppRunProviderExecutionRequest[] = [];
  results: AppRunProviderExecutionResult[] = [];
  entered: (() => void) | null = null;
  wait: Promise<void> | null = null;

  async execute(request: AppRunProviderExecutionRequest): Promise<AppRunProviderExecutionResult> {
    this.calls.push(request);
    this.entered?.();
    if (this.wait) await this.wait;
    return this.results.shift() ?? {
      status: 'returned', provider_succeeded: true, output: { message_id: 'message-1' },
    };
  }
}

test('live authority revocation is sticky and the execution budget is reserved exactly once', async () => {
  const providerId = `live-provider-${suffix}`;
  const snapshotId = `live-snapshot-${suffix}`;
  const employeeId = `live-employee-${suffix}`;
  const operationName = 'send_email';
  const policy = {
    risk_class: 'external_write' as const,
    review_requirement: 'policy' as const,
    review_scope: 'per_invocation' as const,
    retry_class: 'unsafe_or_unknown' as const,
  };
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'owner', true)
     ON CONFLICT (org_id, user_id) DO UPDATE SET is_active = true`,
    [`live-member-${suffix}`, ORG_ID, USER_ID],
  );
  await client.query(
    `INSERT INTO mcp_connections
      (id, org_id, name, slug, server_url, transport, auth_type, is_active,
       default_trust_tier, enabled_tools, created_by)
     VALUES ($1, $2, 'Live provider', $3, 'https://example.test/mcp',
       'streamable-http', 'none', true, 'full', $4, $5)`,
    [providerId, ORG_ID, providerId, [operationName], USER_ID],
  );
  await client.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt, mcp_connection_ids,
       trust_level, max_daily_actions, daily_action_count, unhealthy, is_active,
       is_deleted, created_by)
     VALUES ($1, $2, $3, 'Live employee', $4, 'custom', 'Test', $5,
       'autonomous', 5, 0, false, true, false, $3)`,
    [employeeId, ORG_ID, USER_ID, employeeId, [providerId]],
  );
  const snapshot = await createCapabilityProviderDiscoverySnapshot({
    adapter_contract_version: 'deft.capability.mcp-adapter.v1',
    provider: {
      org_id: ORG_ID,
      provider_kind: 'mcp',
      provider_instance_id: providerId,
    },
    captured_at: new Date().toISOString(),
    operations: [{
      identity: {
        provider: {
          org_id: ORG_ID,
          provider_kind: 'mcp',
          provider_instance_id: providerId,
        },
        operation_name: operationName,
      },
      description: 'Send one test email',
      input_schema: { type: 'object' },
    }],
  });
  await client.query(
    `INSERT INTO capability_provider_snapshots
      (id, org_id, provider_kind, provider_instance_id, adapter_contract_version,
       snapshot_digest, safe_snapshot, captured_at)
     VALUES ($1, $2, 'mcp', $3, $4, $5, $6::jsonb, $7)`,
    [snapshotId, ORG_ID, providerId, snapshot.adapter_contract_version,
      snapshot.snapshot_digest, JSON.stringify(snapshot), snapshot.captured_at],
  );

  const live = new PostgresAppRunLiveAuthorization();
  const executionActor = { actor_type: 'agent_employee' as const, agent_employee_id: employeeId };
  const capture = (effectivePolicy = policy) => live.capture({
    org_id: ORG_ID,
    authenticated_subject: trusted.initiating_actor,
    execution_actor: executionActor,
    provider_instance_id: providerId,
    provider_snapshot_id: snapshotId,
    operation_name: operationName,
    policy: effectivePolicy,
  });
  const liveSubmission = async (key: string, effectivePolicy = policy) => ({
    ...submission({
      idempotency_key: key,
      execution_actor: executionActor,
      origin: { origin_kind: 'legacy_connector', connection_id: providerId },
      operation: {
        provider: { org_id: ORG_ID, provider_kind: 'mcp', provider_instance_id: providerId },
        operation_name: operationName,
      },
      provider_snapshot_digest: snapshot.snapshot_digest,
      policy: effectivePolicy,
      authorization_snapshot: await capture(effectivePolicy),
    }),
  });
  const liveTrusted = { ...trusted, execution_actor: executionActor };
  const setup = service();
  const alwaysPolicy = {
    ...policy,
    review_requirement: 'always' as const,
  };
  const staleApproval = await setup.service.submit(
    liveTrusted,
    await liveSubmission(`live-stale-approval-${suffix}`, alwaysPolicy),
  );
  const staleApprovalAction = await client.query<{ id: string; params: unknown }>(
    `SELECT id, params FROM agent_actions WHERE org_id = $1 AND app_run_id = $2`,
    [ORG_ID, staleApproval.id],
  );
  assert.equal(staleApprovalAction.rowCount, 1);
  assert.doesNotMatch(
    JSON.stringify(staleApprovalAction.rows[0]!.params),
    new RegExp(`raw-marker-${suffix}|live-stale-approval-${suffix}|recipient|body`),
  );
  const stale = await setup.service.submit(
    liveTrusted,
    await liveSubmission(`live-stale-${suffix}`),
  );

  // Restoring the same visible membership state still bumps the monotonic
  // version, so a proposal captured before revocation cannot revive.
  await client.query(
    `UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2`,
    [ORG_ID, USER_ID],
  );
  await client.query(
    `UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2`,
    [ORG_ID, USER_ID],
  );
  const staleApprovalResult = await approveAction(staleApprovalAction.rows[0]!.id, USER_ID);
  assert.equal(staleApprovalResult.status, 'error');
  const staleApprovalState = await client.query<{
    run_state: string;
    action_state: string;
    execution_release_kind: string | null;
  }>(
    `SELECT r.state AS run_state, a.approval_status AS action_state,
            r.execution_release_kind
       FROM app_runs r JOIN agent_actions a
         ON a.org_id = r.org_id AND a.app_run_id = r.id
      WHERE r.org_id = $1 AND r.id = $2`,
    [ORG_ID, staleApproval.id],
  );
  assert.deepEqual(staleApprovalState.rows[0], {
    run_state: 'expired',
    action_state: 'expired',
    execution_release_kind: null,
  });
  const executor = new CountingExecutor();
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor, live,
  );
  assert.equal(await runner.prepareAttempt(ORG_ID, stale.id), null);

  const fresh = await setup.service.submit(
    liveTrusted,
    await liveSubmission(`live-fresh-${suffix}`),
  );
  const attempts = await Promise.all(
    Array.from({ length: 12 }, () => runner.prepareAttempt(ORG_ID, fresh.id)),
  );
  assert.equal(new Set(attempts).size, 1);
  assert.ok(attempts[0]);
  const reservation = await client.query<{
    daily_action_count: number;
    budget_reserved_count: number;
    budget_limit_at_reservation: number;
  }>(
    `SELECT e.daily_action_count, r.budget_reserved_count, r.budget_limit_at_reservation
       FROM agent_employees e JOIN app_runs r
         ON r.org_id = e.org_id AND r.execution_actor_id = e.id
      WHERE r.org_id = $1 AND r.id = $2`,
    [ORG_ID, fresh.id],
  );
  assert.deepEqual(reservation.rows[0], {
    daily_action_count: 1,
    budget_reserved_count: 1,
    budget_limit_at_reservation: 5,
  });

  // Ordinary budget consumption does not change the bound authority version,
  // while the Run's own reservation remains write-once.
  await client.query(
    `UPDATE agent_employees SET daily_action_count = daily_action_count + 1 WHERE id = $1`,
    [employeeId],
  );
  assert.equal(await runner.prepareAttempt(ORG_ID, fresh.id), attempts[0]);

  await client.query(`UPDATE mcp_connections SET is_active = false WHERE id = $1`, [providerId]);
  await client.query(`UPDATE mcp_connections SET is_active = true WHERE id = $1`, [providerId]);
  const stopped = await runner.run(ORG_ID, fresh.id, attempts[0]!, 'live-worker');
  assert.equal(stopped.state, 'pending');
  assert.equal(executor.calls.length, 0);
  const versions = await client.query<{ member: number; connector: number }>(
    `SELECT m.app_run_authorization_version AS member,
            c.app_run_authorization_version AS connector
       FROM org_members m CROSS JOIN mcp_connections c
      WHERE m.org_id = $1 AND m.user_id = $2 AND c.id = $3`,
    [ORG_ID, USER_ID, providerId],
  );
  assert.equal(versions.rows[0]!.member, 3);
  assert.equal(versions.rows[0]!.connector, 3);

  const raced = await setup.service.submit(
    liveTrusted,
    await liveSubmission(`live-approval-race-${suffix}`, alwaysPolicy),
  );
  const raceAction = await client.query<{ id: string; params: unknown }>(
    `SELECT id, params FROM agent_actions WHERE org_id = $1 AND app_run_id = $2`,
    [ORG_ID, raced.id],
  );
  assert.equal(raceAction.rowCount, 1);
  assert.equal(await runner.prepareAttempt(ORG_ID, raced.id), null);
  const internalBypass = await approveAction(raceAction.rows[0]!.id, USER_ID, { internal: true });
  assert.deepEqual(internalBypass, {
    status: 'error',
    code: 'FORBIDDEN',
    message: 'only the requester or an org owner/admin may approve this action',
  });
  await Promise.all(Array.from({ length: 20 }, (_, index) => (
    index % 2 === 0
      ? approveAction(raceAction.rows[0]!.id, USER_ID)
      : rejectAction(raceAction.rows[0]!.id, USER_ID, `ignored raw reason ${index}`)
  )));
  const raceState = await client.query<{
    run_state: string;
    execution_release_kind: string | null;
    action_state: string;
    approval_events: string;
    attempts: string;
    error: string | null;
  }>(
    `SELECT r.state AS run_state, r.execution_release_kind,
            a.approval_status AS action_state, a.error,
            (SELECT count(*) FROM app_run_events e
              WHERE e.org_id = r.org_id AND e.run_id = r.id
                AND e.event_type = 'approval_resolved') AS approval_events,
            (SELECT count(*) FROM app_run_attempts ra
              WHERE ra.org_id = r.org_id AND ra.run_id = r.id) AS attempts
       FROM app_runs r JOIN agent_actions a
         ON a.org_id = r.org_id AND a.app_run_id = r.id
      WHERE r.org_id = $1 AND r.id = $2`,
    [ORG_ID, raced.id],
  );
  const resolution = raceState.rows[0]!;
  assert.equal(resolution.approval_events, '1');
  assert.equal(resolution.attempts, '0');
  assert.doesNotMatch(resolution.error ?? '', /ignored raw reason/);
  if (resolution.execution_release_kind === 'approved') {
    assert.equal(resolution.run_state, 'pending_approval');
    assert.equal(resolution.action_state, 'approved');
    assert.ok(await runner.prepareAttempt(ORG_ID, raced.id));
  } else {
    assert.equal(resolution.execution_release_kind, null);
    assert.equal(resolution.run_state, 'cancelled');
    assert.equal(resolution.action_state, 'rejected');
    assert.equal(await runner.prepareAttempt(ORG_ID, raced.id), null);
  }
});

async function prepareAttempt(runner: AppRunAttemptRunner, runId: string): Promise<string> {
  const attemptId = await runner.prepareAttempt(ORG_ID, runId);
  assert.ok(attemptId);
  return attemptId;
}

test('approval release and live execution authorization both fail closed', async () => {
  const setup = service();
  const approvalRequired = await setup.service.submit(trusted, submission({
    idempotency_key: `approval-gate-${suffix}`,
    policy: {
      risk_class: 'external_write', review_requirement: 'always',
      review_scope: 'per_invocation', retry_class: 'unsafe_or_unknown',
    },
  }));
  assert.equal(approvalRequired.state, 'pending_approval');
  assert.equal(approvalRequired.execution_released_at, null);

  const executor = new CountingExecutor();
  const allowedRunner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor, allowExecution,
  );
  assert.equal(await allowedRunner.prepareAttempt(ORG_ID, approvalRequired.id), null);
  await allowedRunner.run(ORG_ID, approvalRequired.id, randomUUID(), 'unreleased-worker');
  assert.equal(executor.calls.length, 0);
  await assert.rejects(
    client.query(
      `UPDATE app_runs SET state = 'running', started_at = now()
       WHERE org_id = $1 AND id = $2`,
      [ORG_ID, approvalRequired.id],
    ),
    /APP_RUN_EXECUTION_NOT_RELEASED/,
  );
  await assert.rejects(
    client.query(
      `INSERT INTO app_run_attempts (id, org_id, run_id, attempt_number, state)
       VALUES ($1, $2, $3, 1, 'pending')`,
      [randomUUID(), ORG_ID, approvalRequired.id],
    ),
    /APP_RUN_EXECUTION_NOT_RELEASED/,
  );

  const policyReleased = await setup.service.submit(trusted, submission({
    idempotency_key: `execution-authorizer-${suffix}`,
  }));
  await client.query(
    `UPDATE app_runs
        SET budget_reserved_at = now(), budget_reserved_count = 1, budget_limit_at_reservation = 10
      WHERE org_id = $1 AND id = $2`,
    [ORG_ID, policyReleased.id],
  );
  await assert.rejects(
    client.query(
      `UPDATE app_runs SET budget_reserved_count = 2 WHERE org_id = $1 AND id = $2`,
      [ORG_ID, policyReleased.id],
    ),
    /APP_RUN_IMMUTABLE_FIELD/,
  );
  const deniedRunner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor,
  );
  assert.equal(policyReleased.execution_release_kind, 'policy_satisfied');
  assert.equal(await deniedRunner.prepareAttempt(ORG_ID, policyReleased.id), null);

  const approved = await setup.repository.transaction(async (tx) => {
    const run = await setup.repository.lockRun(tx, ORG_ID, approvalRequired.id);
    assert.ok(run);
    return setup.repository.recordApprovedExecutionRelease(
      tx, run, trusted.initiating_actor, new Date(),
    );
  });
  assert.equal(approved.execution_release_kind, 'approved');
  await assert.rejects(
    client.query(
      `UPDATE app_runs SET execution_release_kind = 'policy_satisfied'
       WHERE org_id = $1 AND id = $2`,
      [ORG_ID, approvalRequired.id],
    ),
    /APP_RUN_IMMUTABLE_FIELD/,
  );
  const attemptId = await prepareAttempt(allowedRunner, approvalRequired.id);
  assert.equal((await allowedRunner.run(
    ORG_ID, approvalRequired.id, attemptId, 'approved-worker',
  )).state, 'succeeded');
  assert.equal(executor.calls.length, 1);
  const events = await client.query<{ count: string }>(
    `SELECT count(*) FROM app_run_events
      WHERE org_id = $1 AND run_id = $2 AND event_type = 'approval_resolved'`,
    [ORG_ID, approvalRequired.id],
  );
  assert.equal(events.rows[0]!.count, '1');
});

test('approval compatibility links are exact, bounded, and safe-key allowlisted', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({
    idempotency_key: `approval-link-${suffix}`,
  }));
  await client.query(
    `INSERT INTO agent_actions
      (id, org_id, user_id, app_run_id, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'app_run_invoke', $5::jsonb, 'quick', 'pending')`,
    [randomUUID(), ORG_ID, USER_ID, created.id, JSON.stringify({ run_id: created.id })],
  );
  for (const [action, appRunId, params] of [
    ['create_task', created.id, { run_id: created.id }],
    ['app_run_invoke', null, { run_id: created.id }],
    ['app_run_invoke', created.id, { safe_preview: { title: 'Missing identity' } }],
    ['app_run_invoke', created.id, { run_id: created.id, input: { secret: true } }],
  ] as const) {
    await assert.rejects(
      client.query(
        `INSERT INTO agent_actions
          (id, org_id, user_id, app_run_id, action, params, approval_tier, approval_status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'quick', 'pending')`,
        [randomUUID(), ORG_ID, USER_ID, appRunId, action, JSON.stringify(params)],
      ),
      /agent_actions_app_run_shape_check/,
    );
  }
});

test('concurrent runners call once, commit the call boundary, and replay retained output with authorization', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `runner-${suffix}` }));
  const executor = new CountingExecutor();
  let release!: () => void;
  executor.wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { executor.entered = resolve; });
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor, allowExecution,
  );

  const attemptId = await prepareAttempt(runner, created.id);
  const firstExecution = runner.run(ORG_ID, created.id, attemptId, 'worker-0');
  await entered;
  const competitors = Array.from({ length: 15 }, (_, index) =>
    runner.run(ORG_ID, created.id, attemptId, `worker-${index + 1}`));
  await Promise.all(competitors);
  const boundary = await client.query<{ state: string; run_state: string }>(
    `SELECT a.state, r.state AS run_state
       FROM app_run_attempts a JOIN app_runs r ON r.org_id = a.org_id AND r.id = a.run_id
      WHERE a.org_id = $1 AND a.run_id = $2`,
    [ORG_ID, created.id],
  );
  assert.deepEqual(boundary.rows[0], { state: 'provider_call_started', run_state: 'running' });
  assert.equal(executor.calls.length, 1);
  const claim = await client.query<{ id: string; claim_token: string }>(
    'SELECT id, claim_token FROM app_run_attempts WHERE org_id = $1 AND run_id = $2',
    [ORG_ID, created.id],
  );
  assert.equal(await runner.renewLease(ORG_ID, claim.rows[0]!.id, randomUUID()), false);
  assert.equal(await runner.renewLease(ORG_ID, claim.rows[0]!.id, claim.rows[0]!.claim_token), true);
  const requested = await setup.service.cancel(ORG_ID, created.id, trusted.initiating_actor);
  assert.equal(requested.state, 'running');
  assert.ok(requested.cancel_requested_at);
  release();
  await firstExecution;

  const finished = await setup.service.inspect(ORG_ID, created.id, trusted.initiating_actor);
  assert.equal(finished.state, 'succeeded');
  assert.deepEqual((await setup.service.result(ORG_ID, created.id, trusted.initiating_actor)).value, {
    schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
    provider_succeeded: true,
    output: { message_id: 'message-1' },
  });
  const attemptCounts = await client.query<{ attempts: string; outputs: string }>(
    `SELECT
       (SELECT count(*) FROM app_run_attempts WHERE org_id = $1 AND run_id = $2) AS attempts,
       (SELECT count(*) FROM app_run_secret_payloads WHERE org_id = $1 AND run_id = $2 AND payload_kind = 'output') AS outputs`,
    [ORG_ID, created.id],
  );
  assert.deepEqual(attemptCounts.rows[0], { attempts: '1', outputs: '1' });

  const denied = service(() => new Date(), { async authorize() { return false; } });
  let touchedSecret = false;
  denied.secretRepository.readOutput = async () => {
    touchedSecret = true;
    throw new Error('secret read should not happen');
  };
  await assert.rejects(
    denied.service.result(ORG_ID, created.id, trusted.initiating_actor),
    (error: any) => error?.code === 'APP_RUN_ACCESS_DENIED',
  );
  assert.equal(touchedSecret, false);
});

test('provider-reported failures retain an authorized exact response without recalling the provider', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({
    idempotency_key: `known-provider-error-${suffix}`,
  }));
  const privateMarker = `provider-private-${suffix}`;
  const executor = new CountingExecutor();
  executor.results.push({
    status: 'returned',
    provider_succeeded: false,
    output: { is_error: true, code: 'recipient_rejected', detail: privateMarker },
  });
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor, allowExecution,
  );
  const attemptId = await prepareAttempt(runner, created.id);
  const finished = await runner.run(ORG_ID, created.id, attemptId, 'known-error-worker');
  assert.equal(finished.state, 'failed');
  assert.deepEqual(finished.safe_outcome, {
    success: false,
    provider_call_attempted: true,
    result_status: 'retained',
    error_code: 'APP_RUN_PROVIDER_ERROR',
  });
  assert.deepEqual((await setup.service.result(
    ORG_ID, created.id, trusted.initiating_actor,
  )).value, {
    schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
    provider_succeeded: false,
    output: { is_error: true, code: 'recipient_rejected', detail: privateMarker },
  });
  await runner.run(ORG_ID, created.id, attemptId, 'known-error-duplicate');
  assert.equal(executor.calls.length, 1);
  const safeResidue = await client.query<{ row: string }>(
    `SELECT row_to_json(safe)::text AS row FROM (
       SELECT state, safe_preview, safe_outcome FROM app_runs WHERE id = $1
     ) safe`,
    [created.id],
  );
  assert.doesNotMatch(safeResidue.rows[0]!.row, new RegExp(privateMarker));
});

test('a provider call known not to have started fails without an indeterminate outcome', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({
    idempotency_key: `not-attempted-${suffix}`,
  }));
  const executor = new CountingExecutor();
  executor.results.push({ status: 'not_attempted' });
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor, allowExecution,
  );
  const attemptId = await prepareAttempt(runner, created.id);
  const finished = await runner.run(ORG_ID, created.id, attemptId, 'not-attempted-worker');
  assert.equal(finished.state, 'failed');
  assert.deepEqual(finished.safe_outcome, {
    success: false,
    provider_call_attempted: false,
    result_status: 'unavailable',
    error_code: 'APP_RUN_PROVIDER_UNAVAILABLE',
  });
  await runner.run(ORG_ID, created.id, attemptId, 'not-attempted-duplicate');
  assert.equal(executor.calls.length, 1);
  await assert.rejects(
    setup.service.result(ORG_ID, created.id, trusted.initiating_actor),
    (error: any) => error?.code === 'APP_RUN_RESULT_EXPIRED',
  );
});

test('attempt heartbeats keep a long provider call fenced across lease intervals', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({
    idempotency_key: `heartbeat-${suffix}`,
  }));
  const executor = new CountingExecutor();
  let release!: () => void;
  executor.wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { executor.entered = resolve; });
  let clock = new Date('2026-04-01T00:00:00.000Z');
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor,
    allowExecution, () => clock, 1_000, 50,
  );
  const originalRenew = runner.renewLease.bind(runner);
  let renewals = 0;
  const waiters: Array<{ target: number; resolve: () => void }> = [];
  runner.renewLease = async (...args: Parameters<AppRunAttemptRunner['renewLease']>) => {
    const renewed = await originalRenew(...args);
    if (renewed) {
      renewals += 1;
      for (const waiter of waiters.filter((item) => item.target <= renewals)) waiter.resolve();
    }
    return renewed;
  };
  const waitForRenewals = async (target: number) => {
    if (renewals >= target) return;
    await new Promise<void>((resolve) => { waiters.push({ target, resolve }); });
  };

  const attemptId = await prepareAttempt(runner, created.id);
  const inFlight = runner.run(ORG_ID, created.id, attemptId, 'heartbeat-worker');
  await entered;
  clock = new Date('2026-04-01T00:00:00.900Z');
  await waitForRenewals(1);
  clock = new Date('2026-04-01T00:00:01.800Z');
  await waitForRenewals(2);
  assert.equal(await runner.recoverRun(ORG_ID, created.id), 0);
  release();
  assert.equal((await inFlight).state, 'succeeded');
  assert.ok(renewals >= 2);
});

test('unsafe indeterminate effects never retry while safe and idempotent effects use new attempts', async () => {
  const unsafeSetup = service();
  const unsafe = await unsafeSetup.service.submit(trusted, submission({ idempotency_key: `unsafe-${suffix}` }));
  const unsafeExecutor = new CountingExecutor();
  unsafeExecutor.results.push({ status: 'indeterminate' });
  const unsafeRunner = new AppRunAttemptRunner(
    unsafeSetup.repository, unsafeSetup.secretRepository, unsafeSetup.secrets, unsafeExecutor, allowExecution,
  );
  const unsafeAttempt = await prepareAttempt(unsafeRunner, unsafe.id);
  assert.equal((await unsafeRunner.run(ORG_ID, unsafe.id, unsafeAttempt, 'unsafe-1')).state, 'unknown_outcome');
  await unsafeRunner.run(ORG_ID, unsafe.id, unsafeAttempt, 'unsafe-2');
  assert.equal(unsafeExecutor.calls.length, 1);

  const idempotentSetup = service();
  const idempotent = await idempotentSetup.service.submit(trusted, submission({
    idempotency_key: `idempotent-${suffix}`,
    policy: {
      risk_class: 'external_write', review_requirement: 'policy',
      review_scope: 'per_invocation', retry_class: 'idempotent_with_key',
    },
  }));
  const idempotentExecutor = new CountingExecutor();
  idempotentExecutor.results.push(
    { status: 'indeterminate' },
    { status: 'returned', provider_succeeded: true, output: { delivered: true } },
  );
  const idempotentRunner = new AppRunAttemptRunner(
    idempotentSetup.repository, idempotentSetup.secretRepository, idempotentSetup.secrets,
    idempotentExecutor, allowExecution,
  );
  const firstAttempt = await prepareAttempt(idempotentRunner, idempotent.id);
  assert.equal((await idempotentRunner.run(ORG_ID, idempotent.id, firstAttempt, 'idempotent-1')).state, 'running');
  const secondAttempt = await prepareAttempt(idempotentRunner, idempotent.id);
  assert.notEqual(secondAttempt, firstAttempt);
  assert.equal((await idempotentRunner.run(ORG_ID, idempotent.id, secondAttempt, 'idempotent-2')).state, 'succeeded');
  assert.equal(idempotentExecutor.calls.length, 2);
  assert.equal(idempotentExecutor.calls[0]!.provider_idempotency_key, idempotentExecutor.calls[1]!.provider_idempotency_key);
  const attempts = await client.query<{ attempt_number: number; retry_of_attempt_id: string | null }>(
    `SELECT attempt_number, retry_of_attempt_id FROM app_run_attempts
      WHERE org_id = $1 AND run_id = $2 ORDER BY attempt_number`,
    [ORG_ID, idempotent.id],
  );
  assert.equal(attempts.rows.length, 2);
  assert.equal(attempts.rows[0]!.retry_of_attempt_id, null);
  assert.ok(attempts.rows[1]!.retry_of_attempt_id);
});

test('a stale exact-attempt job cannot claim a later retry', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({
    idempotency_key: `stale-job-${suffix}`,
    policy: {
      risk_class: 'external_write', review_requirement: 'policy',
      review_scope: 'per_invocation', retry_class: 'idempotent_with_key',
    },
  }));
  const executor = new CountingExecutor();
  executor.results.push(
    { status: 'indeterminate' },
    { status: 'returned', provider_succeeded: true, output: { delivered: true } },
  );
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor, allowExecution,
  );
  const handler = createAppRunAttemptJobHandler(runner);
  const firstAttempt = await prepareAttempt(runner, created.id);
  await handler({
    id: 'first-attempt-job', name: 'app-run-attempt', attempts: 1,
    data: { orgId: ORG_ID, runId: created.id, attemptId: firstAttempt },
  });
  const secondAttempt = await prepareAttempt(runner, created.id);
  assert.notEqual(secondAttempt, firstAttempt);
  await handler({
    id: 'stale-attempt-job', name: 'app-run-attempt', attempts: 2,
    data: { orgId: ORG_ID, runId: created.id, attemptId: firstAttempt },
  });
  assert.equal(executor.calls.length, 1);
  await handler({
    id: 'second-attempt-job', name: 'app-run-attempt', attempts: 1,
    data: { orgId: ORG_ID, runId: created.id, attemptId: secondAttempt },
  });
  assert.equal(executor.calls.length, 2);
  assert.equal((await setup.repository.inspect(ORG_ID, created.id))?.state, 'succeeded');
});

test('retention purge is one-way, audited, and leaves only safe terminal residue', async () => {
  const past = new Date('2020-01-01T00:00:00.000Z');
  const setup = service(() => past);
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `expired-${suffix}` }));
  assert.equal(await setup.service.purgeExpiredSecrets(new Date('2021-01-01T00:00:00.000Z')), 1);
  const rows = await client.query<{ secrets: string; state: string; input_purged_at: Date | null; events: string }>(
    `SELECT
       (SELECT count(*) FROM app_run_secret_payloads WHERE org_id = $1 AND run_id = $2) AS secrets,
       r.state, r.input_purged_at,
       (SELECT count(*) FROM app_run_events WHERE org_id = $1 AND run_id = $2 AND event_type = 'secrets_purged') AS events
     FROM app_runs r WHERE r.org_id = $1 AND r.id = $2`,
    [ORG_ID, created.id],
  );
  assert.equal(rows.rows[0]!.secrets, '0');
  assert.equal(rows.rows[0]!.state, 'expired');
  assert.ok(rows.rows[0]!.input_purged_at);
  assert.equal(rows.rows[0]!.events, '1');
  assert.equal(await setup.service.purgeExpiredSecrets(new Date('2021-01-01T00:00:00.000Z')), 0);
});

test('a hard crash after the call boundary recovers unsafe work as unknown and fences the late result', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `hard-crash-${suffix}` }));
  const executor = new CountingExecutor();
  let release!: () => void;
  executor.wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { executor.entered = resolve; });
  let clock = new Date();
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor, allowExecution, () => clock, 1_000, 60_000,
  );
  const attemptId = await prepareAttempt(runner, created.id);
  const inFlight = runner.run(ORG_ID, created.id, attemptId, 'crash-worker');
  await entered;
  clock = new Date(clock.getTime() + 2_000);
  assert.equal(await runner.recoverRun(ORG_ID, created.id), 1);
  assert.equal((await setup.repository.inspect(ORG_ID, created.id))?.state, 'unknown_outcome');
  release();
  await inFlight;
  assert.equal((await setup.repository.inspect(ORG_ID, created.id))?.state, 'unknown_outcome');
  assert.equal(executor.calls.length, 1);
});

test('a durable known result survives finalization failure and repair never recalls the provider', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `repair-${suffix}` }));
  const executor = new CountingExecutor();
  const originalTransition = setup.repository.transition.bind(setup.repository);
  let failFinalization = true;
  setup.repository.transition = async (tx, input) => {
    if (failFinalization && input.state === 'succeeded') {
      failFinalization = false;
      throw new Error('injected finalization failure');
    }
    return originalTransition(tx, input);
  };
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor, allowExecution,
  );
  const attemptId = await prepareAttempt(runner, created.id);
  await assert.rejects(
    runner.run(ORG_ID, created.id, attemptId, 'repair-worker'),
    /injected finalization failure/,
  );
  assert.equal(executor.calls.length, 1);
  const marker = await client.query<{ state: string; provider_call_finished_at: Date | null }>(
    'SELECT state, provider_call_finished_at FROM app_run_attempts WHERE org_id = $1 AND run_id = $2',
    [ORG_ID, created.id],
  );
  assert.equal(marker.rows[0]!.state, 'provider_call_started');
  assert.ok(marker.rows[0]!.provider_call_finished_at);

  setup.repository.transition = originalTransition;
  const repairExecutor: AppRunProviderExecutor = {
    async execute() { throw new Error('provider must not be recalled'); },
  };
  const future = new Date(Date.now() + 2 * 60_000);
  const repairRunner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, repairExecutor, allowExecution, () => future,
  );
  assert.equal(await repairRunner.recoverRun(ORG_ID, created.id), 1);
  assert.equal((await setup.repository.inspect(ORG_ID, created.id))?.state, 'succeeded');
  assert.equal(executor.calls.length, 1);
});

test('oversized post-effect output remains known success without exact result or a second call', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `oversized-${suffix}` }));
  const executor = new CountingExecutor();
  executor.results.push({
    status: 'returned', provider_succeeded: true, output: { value: 'x'.repeat(1024 * 1024 + 1) },
  });
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor, allowExecution,
  );
  const attemptId = await prepareAttempt(runner, created.id);
  const finished = await runner.run(ORG_ID, created.id, attemptId, 'oversized-worker');
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.safe_outcome?.result_status, 'unavailable');
  await runner.run(ORG_ID, created.id, attemptId, 'oversized-worker-2');
  assert.equal(executor.calls.length, 1);
  await assert.rejects(
    setup.service.result(ORG_ID, created.id, trusted.initiating_actor),
    (error: any) => error?.code === 'APP_RUN_RESULT_EXPIRED',
  );
});

test('database fencing rejects a second active attempt and mutable ownership', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `fencing-${suffix}` }));
  const attemptId = randomUUID();
  await client.query(
    `INSERT INTO app_run_attempts
      (id, org_id, run_id, attempt_number, state)
     VALUES ($1, $2, $3, 1, 'pending')`,
    [attemptId, ORG_ID, created.id],
  );
  await assert.rejects(
    client.query(
      `UPDATE app_run_attempts SET claim_owner = 'owner-0', claim_token = $1,
         claimed_at = now(), lease_expires_at = now() + interval '1 minute'
       WHERE id = $2`,
      [randomUUID(), attemptId],
    ),
    /APP_RUN_ILLEGAL_TRANSITION/,
  );
  await client.query(
    `UPDATE app_run_attempts SET state = 'claimed', claim_owner = 'owner-1',
       claim_token = $1, claimed_at = now(), lease_expires_at = now() + interval '1 minute'
     WHERE id = $2`,
    [randomUUID(), attemptId],
  );
  await assert.rejects(
    client.query('UPDATE app_run_attempts SET claim_owner = $1 WHERE id = $2', ['owner-2', attemptId]),
    /APP_RUN_IMMUTABLE_FIELD/,
  );
  await assert.rejects(
    client.query(
      `INSERT INTO app_run_attempts
        (id, org_id, run_id, attempt_number, retry_of_attempt_id, state)
       VALUES ($1, $2, $3, 2, $4, 'pending')`,
      [randomUUID(), ORG_ID, created.id, attemptId],
    ),
    /app_run_attempts_one_active_unique/,
  );
});

test('the worker adapter accepts exact identity-only jobs and remains dependency injected', async () => {
  const calls: unknown[] = [];
  const runner = {
    async run(orgId: string, runId: string, attemptId: string, workerId: string, signal?: AbortSignal) {
      calls.push({ orgId, runId, attemptId, workerId, signal });
      return {} as never;
    },
  } as AppRunAttemptRunner;
  const handler = createAppRunAttemptJobHandler(runner);
  const signal = new AbortController().signal;
  await handler({
    id: 'job-1', name: 'app-run-attempt',
    data: { orgId: ORG_ID, runId: 'run-1', attemptId: 'attempt-1' }, attempts: 1, signal,
  });
  assert.deepEqual(calls, [{
    orgId: ORG_ID, runId: 'run-1', attemptId: 'attempt-1', workerId: 'job:job-1', signal,
  }]);
  await assert.rejects(
    handler({
      id: 'job-2', name: 'app-run-attempt',
      data: { orgId: ORG_ID, runId: 'run-1', attemptId: 'attempt-1', input: 'secret' }, attempts: 1,
    }),
  );
});
