import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {
  APP_RUN_CONTRACT_VERSIONS,
  createCapabilityProviderDiscoverySnapshot,
} from '@deft/shared';

type ChildPhase = 'seed' | 'engine-off-approval' | 'approve' | 'defer' | 'drain';

type TransitionContext = Readonly<{
  orgId: string;
  userId: string;
  employeeId: string;
  providerId: string;
  snapshotId: string;
  snapshotDigest: string;
  operationName: string;
  suffix: string;
  runId?: string;
  actionId?: string;
}>;

const RESULT_PREFIX = 'DEFT_APP_RUN_TRANSITION_RESULT=';
const childPhase = process.env.DEFT_APP_RUN_TRANSITION_CHILD_PHASE as ChildPhase | undefined;
const databaseUrl = process.env.DEFT_TEST_DATABASE_URL
  ?? (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);

if (!databaseUrl) {
  throw new Error('App Run rollout transition tests require DEFT_TEST_DATABASE_URL');
}
if (
  process.env.CI !== 'true'
  && !/(?:phase3|test|ci|acceptance)/i.test(new URL(databaseUrl).pathname)
) {
  throw new Error('App Run rollout transition tests require an explicitly disposable database');
}

function fixedKey(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64');
}

const keyrings = JSON.stringify({
  schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
  run_encryption: { current: 'enc-v1', keys: { 'enc-v1': fixedKey(1) } },
  receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': fixedKey(2) } },
  fingerprint: { current: 'fp-v1', keys: { 'fp-v1': fixedKey(3) } },
});

function transitionContext(): TransitionContext {
  const raw = process.env.DEFT_APP_RUN_TRANSITION_CONTEXT;
  if (!raw) throw new Error('Missing App Run rollout transition context');
  return JSON.parse(raw) as TransitionContext;
}

async function readState(
  client: pg.Client,
  context: TransitionContext,
): Promise<Record<string, unknown>> {
  const result = await client.query<{
    run_state: string;
    release_kind: string | null;
    budget_reserved_count: number | null;
    action_state: string;
    employee_budget: number;
    attempts: string;
    jobs: string;
    native_receipts: string;
    legacy_receipts: string;
  }>(
    `SELECT r.state AS run_state,
            r.execution_release_kind AS release_kind,
            r.budget_reserved_count,
            a.approval_status AS action_state,
            e.daily_action_count AS employee_budget,
            (SELECT count(*) FROM app_run_attempts x
              WHERE x.org_id = r.org_id AND x.run_id = r.id) AS attempts,
            (SELECT count(*) FROM job_queue q
              WHERE q.org_id = r.org_id AND q.name = 'app-run-attempt'
                AND q.data->>'runId' = r.id) AS jobs,
            (SELECT count(*) FROM app_run_receipts n
              WHERE n.org_id = r.org_id AND n.run_id = r.id) AS native_receipts,
            (SELECT count(*) FROM action_receipts l
              WHERE l.org_id = r.org_id AND l.action_id = a.id) AS legacy_receipts
       FROM app_runs r
       JOIN agent_actions a ON a.org_id = r.org_id AND a.app_run_id = r.id
       JOIN agent_employees e ON e.org_id = r.org_id AND e.id = $3
      WHERE r.org_id = $1 AND r.id = $2 AND a.id = $4`,
    [context.orgId, context.runId, context.employeeId, context.actionId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!;
}

async function claimExactAppRunJob(
  client: pg.Client,
  context: TransitionContext,
): Promise<{
  id: string;
  name: string;
  data: Record<string, unknown>;
  attempts: number;
  cronKey: null;
  lockedBy: string;
  lockToken: string;
  lockExpiresAt: Date;
}> {
  const lockToken = randomUUID();
  const lockedBy = `transition:${process.pid}`;
  const result = await client.query<{
    id: string;
    name: string;
    data: Record<string, unknown>;
    attempts: number;
    lock_expires_at: Date;
  }>(
    `UPDATE job_queue
        SET status = 'running', attempts = attempts + 1,
            started_at = now(), completed_at = NULL, error = NULL,
            locked_by = $3, lock_token = $4,
            lock_expires_at = now() + interval '5 minutes'
      WHERE id = (
        SELECT id FROM job_queue
         WHERE org_id = $1 AND name = 'app-run-attempt'
           AND data->>'runId' = $2 AND status = 'pending'
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING id, name, data, attempts, lock_expires_at`,
    [context.orgId, context.runId, lockedBy, lockToken],
  );
  assert.equal(result.rowCount, 1);
  const row = result.rows[0]!;
  return {
    id: row.id,
    name: row.name,
    data: row.data,
    attempts: row.attempts,
    cronKey: null,
    lockedBy,
    lockToken,
    lockExpiresAt: row.lock_expires_at,
  };
}

async function runChildPhase(phase: ChildPhase): Promise<void> {
  const context = transitionContext();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let runtimeLoaded = false;
  try {
    if (phase === 'seed') {
      const { getAppRunRuntime } = await import('../src/lib/app-run-runtime.js');
      const runtime = await getAppRunRuntime();
      runtimeLoaded = true;
      const initiatingActor = { actor_type: 'human' as const, user_id: context.userId };
      const executionActor = {
        actor_type: 'agent_employee' as const,
        agent_employee_id: context.employeeId,
      };
      const policy = {
        risk_class: 'external_write' as const,
        review_requirement: 'always' as const,
        review_scope: 'per_invocation' as const,
        retry_class: 'unsafe_or_unknown' as const,
      };
      const authorizationSnapshot = await runtime.liveAuthorization.capture({
        org_id: context.orgId,
        authenticated_subject: initiatingActor,
        execution_actor: executionActor,
        provider_instance_id: context.providerId,
        provider_snapshot_id: context.snapshotId,
        operation_name: context.operationName,
        policy,
      });
      const run = await runtime.service.submit({
        org_id: context.orgId,
        initiating_actor: initiatingActor,
        execution_actor: executionActor,
      }, {
        schema_version: APP_RUN_CONTRACT_VERSIONS.run,
        org_id: context.orgId,
        initiating_actor: initiatingActor,
        execution_actor: executionActor,
        origin: { origin_kind: 'legacy_connector', connection_id: context.providerId },
        operation: {
          provider: {
            org_id: context.orgId,
            provider_kind: 'mcp',
            provider_instance_id: context.providerId,
          },
          operation_name: context.operationName,
        },
        provider_snapshot_digest: context.snapshotDigest,
        policy,
        retention_class: 'standard',
        idempotency_key: `rollout-transition:${context.suffix}`,
        input: { transition_marker: context.suffix },
        authorization_snapshot: authorizationSnapshot,
        safe_preview: {
          schema_version: APP_RUN_CONTRACT_VERSIONS.run,
          title: 'Certify rollout drain transition',
          resource_refs: [],
        },
      });
      const action = await client.query<{ id: string }>(
        `SELECT id FROM agent_actions
          WHERE org_id = $1 AND app_run_id = $2 AND action = 'app_run_invoke'`,
        [context.orgId, run.id],
      );
      assert.equal(action.rowCount, 1);
      console.log(`${RESULT_PREFIX}${JSON.stringify({
        runId: run.id,
        actionId: action.rows[0]!.id,
        runState: run.state,
      })}`);
      return;
    }

    if (!context.runId || !context.actionId) {
      throw new Error('Run and action identities are required after the seed phase');
    }

    if (phase === 'engine-off-approval') {
      const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
      let errorCode: string | null = null;
      try {
        await approveAction(context.actionId, context.userId);
      } catch (error) {
        errorCode = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : null;
      }
      console.log(`${RESULT_PREFIX}${JSON.stringify({
        errorCode,
        state: await readState(client, context),
      })}`);
      return;
    }

    if (phase === 'approve') {
      const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
      runtimeLoaded = true;
      const result = await approveAction(context.actionId, context.userId);
      console.log(`${RESULT_PREFIX}${JSON.stringify({
        approvalStatus: result.status,
        state: await readState(client, context),
      })}`);
      return;
    }

    const { QUEUE_NAMES } = await import('../src/lib/queues.js');
    const { _processDequeuedJobForTest } = await import('../src/workers/index.js');
    const claimed = await claimExactAppRunJob(client, context);

    if (phase === 'defer') {
      await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS, claimed);
      const queue = await client.query<{ status: string; attempts: number; error: string | null }>(
        'SELECT status, attempts, error FROM job_queue WHERE id = $1',
        [claimed.id],
      );
      console.log(`${RESULT_PREFIX}${JSON.stringify({
        queue: queue.rows[0],
        state: await readState(client, context),
      })}`);
      return;
    }

    const { mcpClientManager } = await import('@deft/mcp');
    const originalExecuteTool = mcpClientManager.executeTool;
    let providerCalls = 0;
    mcpClientManager.executeTool = async () => {
      providerCalls += 1;
      const rawResult = {
        content: [{ type: 'text', text: 'rollout transition complete' }],
        structuredContent: { transition_marker: context.suffix },
      };
      return {
        success: true,
        content: rawResult.content,
        structuredContent: rawResult.structuredContent,
        rawResult,
        durationMs: 1,
      };
    };
    try {
      runtimeLoaded = true;
      await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS, claimed);
      const { _getAgentJobHandlerForTest } = await import('../src/workers/index.js');
      const registered = await _getAgentJobHandlerForTest('app-run-attempt');
      assert.ok(registered);
      await registered({
        id: claimed.id,
        name: claimed.name,
        data: claimed.data,
        attempts: claimed.attempts + 1,
      });
    } finally {
      mcpClientManager.executeTool = originalExecuteTool;
    }
    const queue = await client.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM job_queue WHERE id = $1',
      [claimed.id],
    );
    console.log(`${RESULT_PREFIX}${JSON.stringify({
      providerCalls,
      queue: queue.rows[0],
      state: await readState(client, context),
    })}`);
  } finally {
    await client.end();
    if (runtimeLoaded) {
      const { shutdownAppRunRuntime } = await import('../src/lib/app-run-runtime.js');
      await shutdownAppRunRuntime();
    }
    const { closeDb } = await import('../src/lib/db.js');
    await closeDb();
  }
}

function spawnPhase(
  phase: ChildPhase,
  context: TransitionContext,
  engineEnabled: boolean,
  intakeEnabled: boolean,
): Record<string, any> {
  const scriptPath = fileURLToPath(import.meta.url);
  const apiRoot = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath], {
    cwd: apiRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DEFT_TEST_DATABASE_URL: databaseUrl,
      DEFT_APP_RUNS_ENABLED: engineEnabled ? 'true' : 'false',
      DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED: intakeEnabled ? 'true' : 'false',
      DEFT_APP_RUN_KEYRINGS: engineEnabled ? keyrings : '',
      DEFT_APP_RUN_TRANSITION_CHILD_PHASE: phase,
      DEFT_APP_RUN_TRANSITION_CONTEXT: JSON.stringify(context),
    },
  });
  assert.equal(
    result.status,
    0,
    `Phase ${phase} failed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  const line = result.stdout
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(RESULT_PREFIX));
  assert.ok(line, `Phase ${phase} returned no result marker.\n${result.stdout}`);
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, any>;
}

async function cleanupFixture(client: pg.Client, context: TransitionContext): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('deft.app_run_maintenance', 'on', true)");
    await client.query('DELETE FROM action_receipts WHERE org_id = $1', [context.orgId]);
    await client.query('DELETE FROM agent_actions WHERE org_id = $1', [context.orgId]);
    await client.query('DELETE FROM job_queue WHERE org_id = $1', [context.orgId]);
    await client.query('DELETE FROM notifications WHERE org_id = $1', [context.orgId]);
    await client.query('DELETE FROM attention_items WHERE org_id = $1', [context.orgId]);
    await client.query('DELETE FROM app_runs WHERE org_id = $1', [context.orgId]);
    await client.query('DELETE FROM capability_provider_snapshots WHERE org_id = $1', [context.orgId]);
    await client.query('DELETE FROM agent_employees WHERE org_id = $1', [context.orgId]);
    await client.query('DELETE FROM mcp_connections WHERE org_id = $1', [context.orgId]);
    await client.query('DELETE FROM org_members WHERE org_id = $1', [context.orgId]);
    await client.query('DELETE FROM orgs WHERE id = $1', [context.orgId]);
    await client.query('DELETE FROM users WHERE id = $1', [context.userId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

if (childPhase) {
  await runChildPhase(childPhase);
} else {
  test('accepted approval survives intake shutoff, engine pause, and drain-only restart exactly once', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const context: TransitionContext = {
      orgId: `app-run-transition-org-${suffix}`,
      userId: `app-run-transition-user-${suffix}`,
      employeeId: `app-run-transition-employee-${suffix}`,
      providerId: `app-run-transition-provider-${suffix}`,
      snapshotId: `app-run-transition-snapshot-${suffix}`,
      snapshotDigest: '',
      operationName: 'send_transition_marker',
      suffix,
    };
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(
        'INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)',
        [context.orgId, 'App Run Transition Test', context.orgId],
      );
      await client.query(
        `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
         VALUES ($1, $2, 'App Run Transition User', 'human', false, true)`,
        [context.userId, `${context.userId}@test.local`],
      );
      await client.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active)
         VALUES ($1, $2, $3, 'owner', true)`,
        [`app-run-transition-member-${suffix}`, context.orgId, context.userId],
      );
      await client.query(
        `INSERT INTO mcp_connections
          (id, org_id, name, slug, server_url, transport, auth_type, is_active,
           default_trust_tier, enabled_tools, created_by)
         VALUES ($1, $2, 'Transition provider', $1,
           'https://api.example.test/mcp', 'streamable-http', 'none', true,
           'full', $3, $4)`,
        [context.providerId, context.orgId, [context.operationName], context.userId],
      );
      await client.query(
        `INSERT INTO agent_employees
          (id, org_id, user_id, name, slug, role, system_prompt,
           mcp_connection_ids, trust_level, max_daily_actions,
           daily_action_count, unhealthy, is_active, is_deleted, created_by)
         VALUES ($1, $2, $3, 'Transition employee', $1, 'custom', 'Test', $4,
           'autonomous', 5, 0, false, true, false, $3)`,
        [context.employeeId, context.orgId, context.userId, [context.providerId]],
      );
      const snapshot = await createCapabilityProviderDiscoverySnapshot({
        adapter_contract_version: 'deft.capability.mcp-adapter.v1',
        provider: {
          org_id: context.orgId,
          provider_kind: 'mcp',
          provider_instance_id: context.providerId,
        },
        captured_at: new Date().toISOString(),
        operations: [{
          identity: {
            provider: {
              org_id: context.orgId,
              provider_kind: 'mcp',
              provider_instance_id: context.providerId,
            },
            operation_name: context.operationName,
          },
          description: 'Persist one deterministic rollout marker',
          input_schema: { type: 'object' },
        }],
      });
      const fixture = { ...context, snapshotDigest: snapshot.snapshot_digest };
      await client.query(
        `INSERT INTO capability_provider_snapshots
          (id, org_id, provider_kind, provider_instance_id,
           adapter_contract_version, snapshot_digest, safe_snapshot, captured_at)
         VALUES ($1, $2, 'mcp', $3, $4, $5, $6::jsonb, $7)`,
        [fixture.snapshotId, fixture.orgId, fixture.providerId,
          snapshot.adapter_contract_version, snapshot.snapshot_digest,
          JSON.stringify(snapshot), snapshot.captured_at],
      );

      const seeded = spawnPhase('seed', fixture, true, true);
      const active = {
        ...fixture,
        runId: String(seeded.runId),
        actionId: String(seeded.actionId),
      };
      assert.equal(seeded.runState, 'pending_approval');

      const blocked = spawnPhase('engine-off-approval', active, false, false);
      assert.equal(blocked.errorCode, 'APP_RUNS_DISABLED');
      assert.deepEqual(blocked.state, {
        run_state: 'pending_approval',
        release_kind: null,
        budget_reserved_count: null,
        action_state: 'pending',
        employee_budget: 0,
        attempts: '0',
        jobs: '0',
        native_receipts: '0',
        legacy_receipts: '0',
      });

      const approved = spawnPhase('approve', active, true, false);
      assert.equal(approved.approvalStatus, 'approved');
      assert.deepEqual(approved.state, {
        run_state: 'pending_approval',
        release_kind: 'approved',
        budget_reserved_count: 1,
        action_state: 'approved',
        employee_budget: 1,
        attempts: '1',
        jobs: '1',
        native_receipts: '1',
        legacy_receipts: '0',
      });

      const deferred = spawnPhase('defer', active, false, false);
      assert.equal(deferred.queue.status, 'pending');
      assert.equal(deferred.queue.attempts, 0);
      assert.match(deferred.queue.error, /App Runs are disabled/);
      assert.equal(deferred.state.employee_budget, 1);
      assert.equal(deferred.state.run_state, 'pending_approval');

      const drained = spawnPhase('drain', active, true, false);
      assert.equal(drained.providerCalls, 1);
      assert.deepEqual(drained.queue, { status: 'completed', attempts: 1 });
      assert.deepEqual(drained.state, {
        run_state: 'succeeded',
        release_kind: 'approved',
        budget_reserved_count: 1,
        action_state: 'approved',
        employee_budget: 1,
        attempts: '1',
        jobs: '1',
        native_receipts: '2',
        legacy_receipts: '0',
      });
    } finally {
      await cleanupFixture(client, context);
      await client.end();
    }
  });
}
