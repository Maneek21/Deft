import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { AppRunSafeView } from '../src/lib/app-run-repository.js';
import {
  APP_OPERATIONS_BOUNDS,
  AppOperationsProjectionService,
  appOperationsService,
  type AppOperationsProjectionDependencies,
} from '../src/lib/app-operations-service.js';
import { AppRunError } from '../src/lib/app-run-errors.js';
import { ModuleError } from '../src/lib/module-errors.js';
import { humanModuleActor } from '../src/lib/module-service.js';
import { appRoutes } from '../src/routes/apps.js';

const NOW = new Date('2026-09-01T10:00:00.000Z');
const actor = humanModuleActor({
  orgId: 'org-alpha',
  userId: 'manager-alpha',
  role: 'admin',
  source: 'rest',
});

function run(id: string, orgId = actor.org_id): AppRunSafeView {
  return {
    id,
    org_id: orgId,
    state: 'succeeded',
    provider_kind: 'mcp',
    provider_instance_id: 'provider-instance-secret-marker',
    provider_snapshot_id: 'provider-snapshot-secret-marker',
    initiating_actor_id: 'initiating-actor-secret-marker',
    execution_actor_id: 'execution-actor-secret-marker',
    operation_name: `safe.operation.${id}`,
    risk_class: 'external_write',
    review_requirement: 'always',
    retry_class: 'idempotent_with_key',
    retention_class: 'standard',
    updated_at: NOW,
    safe_preview: { raw_payload: 'raw-payload-secret-marker' },
    safe_outcome: { raw_result: 'raw-result-secret-marker' },
  } as unknown as AppRunSafeView;
}

function dependencies(overrides: Partial<AppOperationsProjectionDependencies> = {}) {
  const orgCalls: string[] = [];
  const recentRows = [
    run('foreign-run', 'org-beta'),
    ...Array.from({ length: 30 }, (_, index) => run(`run-${index + 1}`)),
  ];
  const gaps = Array.from({ length: 120 }, (_, index) => ({
    run_id: `gap-run-secret-marker-${index}`,
    gap: index % 2 === 0 ? 'missing_receipt' as const : 'missing_terminal_event' as const,
    artifact: 'run' as const,
    attempt_id: `attempt-secret-marker-${index}`,
    action_id: `action-secret-marker-${index}`,
  }));
  const base: AppOperationsProjectionDependencies = {
    assertManager: async (value) => { orgCalls.push(`manager:${value.org_id}`); },
    runOperations: {
      async metrics(input) {
        orgCalls.push(`metrics:${input.org_id}`);
        return [
          { state: 'pending_approval', risk_class: 'external_write', provider_kind: 'mcp', count: 2 },
          { state: 'unknown_outcome', risk_class: 'external_write', provider_kind: 'mcp', count: 1 },
          { state: 'succeeded', risk_class: 'read', provider_kind: 'mcp', count: 7 },
        ];
      },
      async list(input) {
        orgCalls.push(`list:${input.org_id}`);
        return recentRows;
      },
      async auditGaps(input) {
        orgCalls.push(`audit:${input.org_id}`);
        return gaps;
      },
    },
    async readAggregates(orgId) {
      orgCalls.push(`aggregates:${orgId}`);
      return {
        attempt_states: [
          { state: 'pending', count: 2, retry_attempts: 0, retryable_failed: 0 },
          { state: 'failed', count: 3, retry_attempts: 2, retryable_failed: 1 },
          { state: 'succeeded', count: 6, retry_attempts: 1, retryable_failed: 0 },
        ],
        action_counts: Array.from({ length: 30 }, (_, index) => ({
          operation_name: `safe.action.${index + 1}`,
          count: 30 - index,
        })),
        retained_payload_count: 8,
        retained_payload_bytes: 2_048,
        cleanup_due_payload_count: 2,
        cleanup_due_payload_bytes: 512,
        overdue_run_cleanup_count: 1,
      };
    },
    async readQueue(orgId) {
      orgCalls.push(`queue:${orgId}`);
      return {
        status: 'degraded',
        pending: 4,
        running: 1,
        completed: 9,
        failed: 2,
        oldest_ready_lag_seconds: 12,
        expired_leases: 1,
        recent_terminal_failures: 2,
        worker: {
          running: true,
          started_at: 'worker-start-secret-marker',
          last_poll_at: 'worker-poll-secret-marker',
          heartbeat_age_seconds: 1,
          heartbeat_stale: false,
          in_flight: 99,
        },
      };
    },
    async readKeyReferences(orgId) {
      orgCalls.push(`keys:${orgId}`);
      return [
        { purpose: 'fingerprint', key_id: 'fingerprint-key-secret-marker-a' },
        { purpose: 'fingerprint', key_id: 'fingerprint-key-secret-marker-b' },
        { purpose: 'receipt_signing', key_id: 'receipt-key-secret-marker' },
      ];
    },
    configuredKeyIds(purpose) {
      return purpose === 'fingerprint'
        ? ['fingerprint-key-secret-marker-a']
        : purpose === 'receipt_signing'
          ? ['receipt-key-secret-marker']
          : ['encryption-key-secret-marker'];
    },
    async readConnectedHealth(value, limit) {
      orgCalls.push(`health:${value.org_id}:${limit}`);
      return {
        total: 31,
        checked: limit,
        truncated: true,
        healthy: 24,
        unhealthy: 1,
        issue_counts: [{ code: 'APP_CONNECTOR_DRIFT', count: 1 }],
        provider_instance_id: 'health-provider-secret-marker',
        active_grant_snapshot_id: 'grant-snapshot-secret-marker',
      } as never;
    },
    now: () => NOW,
  };
  return { dependencies: { ...base, ...overrides }, orgCalls };
}

test('operations projection is bounded, tenant-scoped, and allowlist-redacted', async () => {
  const setup = dependencies();
  const projection = await new AppOperationsProjectionService(setup.dependencies).read(actor);

  assert.equal(projection.schema, 'deft.app_operations.v1');
  assert.equal(projection.runs.total, 10);
  assert.equal(projection.runs.pending_approvals, 2);
  assert.equal(projection.runs.recent.length, APP_OPERATIONS_BOUNDS.recent_runs);
  assert.equal(projection.runs.recent.some((item) => item.run_id === 'foreign-run'), false);
  assert.equal(projection.actions.items.length, APP_OPERATIONS_BOUNDS.action_counts);
  assert.equal(projection.actions.truncated, true);
  assert.equal(projection.integrity.sampled_gap_count, APP_OPERATIONS_BOUNDS.audit_gaps);
  assert.equal(projection.integrity.truncated, true);
  assert.equal(projection.connected_apps.checked, APP_OPERATIONS_BOUNDS.connected_apps);
  assert.equal(projection.queue.worker_available, true);
  assert.deepEqual(projection.degraded.reasons, [
    'queue',
    'integrity',
    'payload_cleanup',
    'connected_apps',
    'key_availability',
    'unknown_outcomes',
  ]);
  assert.deepEqual(
    setup.orgCalls,
    [
      'manager:org-alpha',
      'metrics:org-alpha',
      'list:org-alpha',
      'audit:org-alpha',
      'aggregates:org-alpha',
      'queue:org-alpha',
      'keys:org-alpha',
      `health:org-alpha:${APP_OPERATIONS_BOUNDS.connected_apps}`,
    ],
  );

  const serialized = JSON.stringify(projection);
  for (const marker of [
    'org-beta',
    'provider-instance-secret-marker',
    'provider-snapshot-secret-marker',
    'initiating-actor-secret-marker',
    'execution-actor-secret-marker',
    'raw-payload-secret-marker',
    'raw-result-secret-marker',
    'gap-run-secret-marker',
    'attempt-secret-marker',
    'action-secret-marker',
    'worker-start-secret-marker',
    'worker-poll-secret-marker',
    'fingerprint-key-secret-marker',
    'receipt-key-secret-marker',
    'encryption-key-secret-marker',
    'health-provider-secret-marker',
    'grant-snapshot-secret-marker',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(marker));
  }
  for (const forbiddenKey of [
    'ciphertext_b64',
    'signature_hmac',
    'actor_id',
    'provider_instance_id',
    'provider_snapshot_id',
    'active_grant_snapshot_id',
    'key_id',
    'raw_payload',
    'raw_result',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(projection, forbiddenKey), false);
    assert.doesNotMatch(serialized, new RegExp(`"${forbiddenKey}"`));
  }
});

test('operations projection stops before reads when current membership was demoted', async () => {
  let reads = 0;
  const setup = dependencies({
    assertManager: async () => {
      throw new ModuleError('demoted', 'MODULE_ACCESS_DENIED', 403);
    },
    runOperations: {
      async metrics() { reads += 1; return []; },
      async list() { reads += 1; return []; },
      async auditGaps() { reads += 1; return []; },
    },
  });
  await assert.rejects(
    () => new AppOperationsProjectionService(setup.dependencies).read(actor),
    (error: unknown) => error instanceof ModuleError && error.code === 'MODULE_ACCESS_DENIED',
  );
  assert.equal(reads, 0);
});

function routeApp(user: Record<string, unknown>) {
  const app = new Hono();
  app.use('/api/apps/*', async (context, next) => {
    context.set('user', user as never);
    await next();
  });
  app.route('/api/apps', appRoutes);
  return app;
}

test('GET /api/apps/operations is static, manager-only, and maps live demotion to 403', async (t) => {
  const original = appOperationsService.read;
  t.after(() => { appOperationsService.read = original; });
  let calls = 0;
  appOperationsService.read = async (value) => {
    calls += 1;
    assert.equal(value.org_id, 'org-alpha');
    return { schema: 'deft.app_operations.v1', generated_at: NOW.toISOString() } as never;
  };

  const ownerResponse = await routeApp({
    id: 'manager-alpha',
    org_id: 'org-alpha',
    email: 'manager@test.local',
    role: 'owner',
  }).request('/api/apps/operations');
  assert.equal(ownerResponse.status, 200);
  assert.equal((await ownerResponse.json() as { operations: { schema: string } }).operations.schema,
    'deft.app_operations.v1');
  assert.equal(calls, 1);

  const memberResponse = await routeApp({
    id: 'member-alpha',
    org_id: 'org-alpha',
    email: 'member@test.local',
    role: 'member',
  }).request('/api/apps/operations');
  assert.equal(memberResponse.status, 403);
  assert.equal(calls, 1);

  appOperationsService.read = async () => {
    throw new ModuleError('demoted', 'MODULE_ACCESS_DENIED', 403);
  };
  const demotedResponse = await routeApp({
    id: 'manager-alpha',
    org_id: 'org-alpha',
    email: 'manager@test.local',
    role: 'admin',
  }).request('/api/apps/operations');
  assert.equal(demotedResponse.status, 403);
  assert.equal((await demotedResponse.json() as { code: string }).code, 'APP_ACCESS_DENIED');

  appOperationsService.read = async () => {
    throw new AppRunError('APP_RUNS_DISABLED');
  };
  const disabledResponse = await routeApp({
    id: 'manager-alpha',
    org_id: 'org-alpha',
    email: 'manager@test.local',
    role: 'owner',
  }).request('/api/apps/operations');
  assert.equal(disabledResponse.status, 503);
  assert.deepEqual(await disabledResponse.json(), {
    error: 'App Run execution is disabled',
    code: 'APP_RUNS_DISABLED',
  });
});
