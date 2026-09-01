import {
  appRunAttempts,
  appRuns,
  appRunSecretPayloads,
} from '@deft/db/schema';
import {
  APP_RUN_DEFAULT_ATTEMPT_LIMIT,
  APP_RUN_IDEMPOTENCY_RETENTION_MS,
  APP_RUN_LIMITS,
  APP_RUN_SECRET_RETENTION_MS,
  type AppRunActor,
  type AppRunAttemptState,
  type AppRunState,
} from '@deft/shared';
import type { ModuleActor } from '@deft/shared/modules';
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from './db.js';
import { APP_RUN_KEY_PURPOSES, type AppRunKeyPurpose } from './app-run-keyrings.js';
import type {
  AppRunOperationalMetric,
  AppRunOperationsService,
  AppRunRepairGap,
} from './app-run-operations.js';
import type { AppRunSafeView } from './app-run-repository.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { APP_RUN_ATTEMPT_JOB } from './app-run-scheduler.js';
import { inspectConnectedAppHealth } from './app-review-service.js';
import { listAppInstallations } from './app-service.js';
import { ModuleError } from './module-errors.js';
import { assertCurrentModuleManagerWithExecutor } from './module-service.js';
import { getOrgQueueHealthSnapshot, type QueueHealthSnapshot } from './queue-health.js';
import { getWorkerStatus } from '../workers/index.js';

export const APP_OPERATIONS_BOUNDS = Object.freeze({
  recent_runs: 25,
  action_counts: 25,
  audit_gaps: 100,
  connected_apps: 25,
  health_issue_codes: 25,
});

const ATTEMPT_STATES: readonly AppRunAttemptState[] = [
  'pending',
  'claimed',
  'provider_call_started',
  'succeeded',
  'failed',
  'cancelled',
  'unknown_outcome',
];

type AppRunOperationsReadPort = Pick<AppRunOperationsService, 'metrics' | 'list' | 'auditGaps'>;

export type AppOperationsAggregateSnapshot = Readonly<{
  attempt_states: readonly Readonly<{
    state: AppRunAttemptState;
    count: number;
    retry_attempts: number;
    retryable_failed: number;
  }>[];
  action_counts: readonly Readonly<{ operation_name: string; count: number }>[];
  retained_payload_count: number;
  retained_payload_bytes: number;
  cleanup_due_payload_count: number;
  cleanup_due_payload_bytes: number;
  overdue_run_cleanup_count: number;
}>;

type KeyReference = Readonly<{ purpose: AppRunKeyPurpose; key_id: string }>;

export type ConnectedAppHealthSummary = Readonly<{
  total: number;
  checked: number;
  truncated: boolean;
  healthy: number;
  unhealthy: number;
  issue_counts: readonly Readonly<{ code: string; count: number }>[];
}>;

export type AppOperationsProjectionDependencies = Readonly<{
  assertManager(actor: ModuleActor): Promise<void>;
  runOperations: AppRunOperationsReadPort;
  readAggregates(orgId: string, now: Date): Promise<AppOperationsAggregateSnapshot>;
  readQueue(orgId: string, now: Date): Promise<QueueHealthSnapshot>;
  readKeyReferences(orgId: string, now: Date): Promise<readonly KeyReference[]>;
  configuredKeyIds(purpose: AppRunKeyPurpose): readonly string[];
  readConnectedHealth(actor: ModuleActor, limit: number): Promise<ConnectedAppHealthSummary>;
  now(): Date;
}>;

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(parsed))) : 0;
}

function safeIdentifier(value: string, fallback: string): string {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value) ? value : fallback;
}

function humanRunActor(actor: ModuleActor): AppRunActor {
  if (actor.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
    throw new ModuleError(
      'Only active workspace owners and admins can inspect App operations',
      'MODULE_ACCESS_DENIED',
      403,
    );
  }
  return { actor_type: 'human', user_id: actor.actor_id };
}

function aggregateMetrics(metrics: readonly AppRunOperationalMetric[]) {
  const byState = new Map<AppRunState, number>();
  const byProvider = new Map<string, number>();
  let total = 0;
  for (const metric of metrics) {
    const metricCount = count(metric.count);
    total += metricCount;
    byState.set(metric.state, count(byState.get(metric.state)) + metricCount);
    byProvider.set(metric.provider_kind, count(byProvider.get(metric.provider_kind)) + metricCount);
  }
  return {
    total: count(total),
    by_state: [...byState].sort(([left], [right]) => left.localeCompare(right))
      .map(([state, stateCount]) => ({ state, count: stateCount })),
    by_provider: [...byProvider].sort(([left], [right]) => left.localeCompare(right))
      .map(([provider_kind, providerCount]) => ({ provider_kind, count: providerCount })),
  };
}

function aggregateGaps(gaps: readonly AppRunRepairGap[]) {
  const byGap = new Map<AppRunRepairGap['gap'], number>();
  for (const item of gaps.slice(0, APP_OPERATIONS_BOUNDS.audit_gaps)) {
    byGap.set(item.gap, count(byGap.get(item.gap)) + 1);
  }
  return [...byGap].sort(([left], [right]) => left.localeCompare(right))
    .map(([gap, gapCount]) => ({ gap, count: gapCount }));
}

function projectRecentRuns(orgId: string, runs: readonly AppRunSafeView[]) {
  return runs.filter((run) => run.org_id === orgId)
    .slice(0, APP_OPERATIONS_BOUNDS.recent_runs)
    .map((run) => ({
      run_id: safeIdentifier(run.id, 'unrecognized_run'),
      state: run.state,
      provider_kind: run.provider_kind,
      operation_name: safeIdentifier(run.operation_name, 'unrecognized_operation'),
      risk_class: run.risk_class,
      review_requirement: run.review_requirement,
      retry_class: run.retry_class,
      retention_class: run.retention_class,
      updated_at: run.updated_at.toISOString(),
    }));
}

export class AppOperationsProjectionService {
  constructor(private readonly dependencies: AppOperationsProjectionDependencies) {}

  async read(actor: ModuleActor) {
    const runActor = humanRunActor(actor);
    await this.dependencies.assertManager(actor);
    const now = this.dependencies.now();
    const common = { org_id: actor.org_id, actor: runActor };
    const [metrics, recentRows, gaps, aggregates, queue, keyReferences, connectedApps] = await Promise.all([
      this.dependencies.runOperations.metrics(common),
      this.dependencies.runOperations.list({
        ...common,
        limit: APP_OPERATIONS_BOUNDS.recent_runs,
      }),
      this.dependencies.runOperations.auditGaps({
        ...common,
        limit: APP_OPERATIONS_BOUNDS.audit_gaps,
      }),
      this.dependencies.readAggregates(actor.org_id, now),
      this.dependencies.readQueue(actor.org_id, now),
      this.dependencies.readKeyReferences(actor.org_id, now),
      this.dependencies.readConnectedHealth(actor, APP_OPERATIONS_BOUNDS.connected_apps),
    ]);

    const runMetrics = aggregateMetrics(metrics);
    const recent = projectRecentRuns(actor.org_id, recentRows);
    const byGap = aggregateGaps(gaps);
    const actionRows = aggregates.action_counts.slice(0, APP_OPERATIONS_BOUNDS.action_counts);
    const keys = APP_RUN_KEY_PURPOSES.map((purpose) => {
      const referenced = new Set(
        keyReferences.filter((item) => item.purpose === purpose).map((item) => item.key_id),
      );
      const configured = new Set(this.dependencies.configuredKeyIds(purpose));
      const missing = [...referenced].filter((keyId) => !configured.has(keyId)).length;
      return {
        purpose,
        referenced_count: referenced.size,
        configured_count: configured.size,
        missing_referenced_count: missing,
        all_referenced_available: missing === 0,
      };
    });
    const attemptCounts = new Map<AppRunAttemptState, number>();
    for (const row of aggregates.attempt_states) {
      if (!ATTEMPT_STATES.includes(row.state)) continue;
      attemptCounts.set(row.state, count(attemptCounts.get(row.state)) + count(row.count));
    }
    const attemptsByState = ATTEMPT_STATES
      .filter((state) => attemptCounts.has(state))
      .map((state) => ({ state, count: count(attemptCounts.get(state)) }));
    const retryAttempts = aggregates.attempt_states.reduce(
      (total, row) => total + count(row.retry_attempts),
      0,
    );
    const retryableFailed = aggregates.attempt_states.reduce(
      (total, row) => total + count(row.retryable_failed),
      0,
    );
    const activeAttempts = aggregates.attempt_states
      .filter((row) => ['pending', 'claimed', 'provider_call_started'].includes(row.state))
      .reduce((total, row) => total + count(row.count), 0);
    const reasons = [
      ...(queue.status === 'degraded' ? ['queue'] : []),
      ...(byGap.length > 0 ? ['integrity'] : []),
      ...(count(aggregates.cleanup_due_payload_count) > 0
        || count(aggregates.overdue_run_cleanup_count) > 0 ? ['payload_cleanup'] : []),
      ...(connectedApps.unhealthy > 0 ? ['connected_apps'] : []),
      ...(keys.some((item) => !item.all_referenced_available) ? ['key_availability'] : []),
      ...(runMetrics.by_state.some((item) => item.state === 'unknown_outcome' && item.count > 0)
        ? ['unknown_outcomes'] : []),
    ];

    return {
      schema: 'deft.app_operations.v1' as const,
      generated_at: now.toISOString(),
      runs: {
        total: runMetrics.total,
        pending_approvals: runMetrics.by_state.find((item) => item.state === 'pending_approval')?.count ?? 0,
        by_state: runMetrics.by_state,
        recent,
        recent_limit: APP_OPERATIONS_BOUNDS.recent_runs,
        truncated: recentRows.length >= APP_OPERATIONS_BOUNDS.recent_runs,
      },
      queue: {
        status: queue.status,
        pending: count(queue.pending),
        running: count(queue.running),
        backlog: count(queue.pending),
        completed: count(queue.completed),
        failed: count(queue.failed),
        oldest_ready_lag_seconds: count(queue.oldest_ready_lag_seconds),
        expired_leases: count(queue.expired_leases),
        recent_terminal_failures: count(queue.recent_terminal_failures),
        worker_available: queue.worker.running && !queue.worker.heartbeat_stale,
      },
      attempts: {
        total: attemptsByState.reduce((total, row) => total + row.count, 0),
        retry_attempts: count(retryAttempts),
        active: count(activeAttempts),
        retryable_failed: count(retryableFailed),
        by_state: attemptsByState,
      },
      payloads: {
        retained_count: count(aggregates.retained_payload_count),
        retained_bytes: count(aggregates.retained_payload_bytes),
        cleanup_due_count: count(aggregates.cleanup_due_payload_count),
        cleanup_due_bytes: count(aggregates.cleanup_due_payload_bytes),
        overdue_run_cleanup_count: count(aggregates.overdue_run_cleanup_count),
      },
      integrity: {
        sampled_gap_count: gaps.slice(0, APP_OPERATIONS_BOUNDS.audit_gaps).length,
        sample_limit: APP_OPERATIONS_BOUNDS.audit_gaps,
        truncated: gaps.length >= APP_OPERATIONS_BOUNDS.audit_gaps,
        by_gap: byGap,
      },
      providers: runMetrics.by_provider,
      actions: {
        items: actionRows.map((row) => ({
          operation_name: safeIdentifier(row.operation_name, 'unrecognized_operation'),
          count: count(row.count),
        })),
        limit: APP_OPERATIONS_BOUNDS.action_counts,
        truncated: aggregates.action_counts.length > APP_OPERATIONS_BOUNDS.action_counts,
      },
      connected_apps: {
        total: count(connectedApps.total),
        checked: count(connectedApps.checked),
        limit: APP_OPERATIONS_BOUNDS.connected_apps,
        truncated: connectedApps.truncated,
        healthy: count(connectedApps.healthy),
        unhealthy: count(connectedApps.unhealthy),
        issue_counts: connectedApps.issue_counts
          .slice(0, APP_OPERATIONS_BOUNDS.health_issue_codes)
          .map((item) => ({
            code: safeIdentifier(item.code, 'APP_HEALTH_ISSUE'),
            count: count(item.count),
          })),
      },
      policy: {
        default_attempt_limit: APP_RUN_DEFAULT_ATTEMPT_LIMIT,
        payload_limits_bytes: {
          input: APP_RUN_LIMITS.input_bytes,
          output: APP_RUN_LIMITS.output_bytes,
          authorization_snapshot: APP_RUN_LIMITS.authorization_snapshot_bytes,
          safe_preview: APP_RUN_LIMITS.safe_preview_bytes,
          safe_event_payload: APP_RUN_LIMITS.safe_event_payload_bytes,
          safe_receipt_envelope: APP_RUN_LIMITS.safe_receipt_envelope_bytes,
        },
        payload_retention_ms: APP_RUN_SECRET_RETENTION_MS,
        idempotency_retention_ms: APP_RUN_IDEMPOTENCY_RETENTION_MS,
      },
      keys,
      degraded: {
        status: reasons.length === 0 ? 'ok' as const : 'degraded' as const,
        reasons,
      },
    };
  }
}

class PostgresAppOperationsAggregateReader {
  async read(orgId: string, now: Date): Promise<AppOperationsAggregateSnapshot> {
    const actionCount = sql<number>`count(*)::int`;
    const [attemptStates, actionCounts, [payloads], [overdueCleanup]] = await Promise.all([
      db.select({
        state: appRunAttempts.state,
        count: sql<number>`count(*)::int`,
        retry_attempts: sql<number>`count(*) FILTER (WHERE ${appRunAttempts.attempt_number} > 1)::int`,
        retryable_failed: sql<number>`count(*) FILTER (WHERE
          ${appRunAttempts.state} = 'failed'
          AND ${appRunAttempts.attempt_number} < ${appRuns.attempt_limit}
          AND ${appRuns.retry_class} <> 'unsafe_or_unknown'
        )::int`,
      }).from(appRunAttempts).innerJoin(appRuns, and(
        eq(appRuns.org_id, appRunAttempts.org_id),
        eq(appRuns.id, appRunAttempts.run_id),
      )).where(and(
        eq(appRunAttempts.org_id, orgId),
        eq(appRuns.org_id, orgId),
      )).groupBy(appRunAttempts.state).orderBy(asc(appRunAttempts.state)),
      db.select({
        operation_name: appRuns.operation_name,
        count: actionCount,
      }).from(appRuns).where(eq(appRuns.org_id, orgId))
        .groupBy(appRuns.operation_name)
        .orderBy(desc(actionCount), asc(appRuns.operation_name))
        .limit(APP_OPERATIONS_BOUNDS.action_counts + 1),
      db.select({
        retained_count: sql<number>`count(*) FILTER (WHERE ${appRunSecretPayloads.expires_at} > ${now})::int`,
        retained_bytes: sql<number>`coalesce(sum(${appRunSecretPayloads.payload_bytes}) FILTER (
          WHERE ${appRunSecretPayloads.expires_at} > ${now}
        ), 0)::bigint`,
        cleanup_due_count: sql<number>`count(*) FILTER (WHERE ${appRunSecretPayloads.expires_at} <= ${now})::int`,
        cleanup_due_bytes: sql<number>`coalesce(sum(${appRunSecretPayloads.payload_bytes}) FILTER (
          WHERE ${appRunSecretPayloads.expires_at} <= ${now}
        ), 0)::bigint`,
      }).from(appRunSecretPayloads).where(eq(appRunSecretPayloads.org_id, orgId)),
      db.select({
        count: sql<number>`count(*)::int`,
      }).from(appRuns).where(and(
        eq(appRuns.org_id, orgId),
        or(
          and(lte(appRuns.input_expires_at, now), isNull(appRuns.input_purged_at)),
          and(lte(appRuns.result_expires_at, now), isNull(appRuns.result_purged_at)),
        ),
      )),
    ]);

    return {
      attempt_states: attemptStates,
      action_counts: actionCounts,
      retained_payload_count: count(payloads?.retained_count),
      retained_payload_bytes: count(payloads?.retained_bytes),
      cleanup_due_payload_count: count(payloads?.cleanup_due_count),
      cleanup_due_payload_bytes: count(payloads?.cleanup_due_bytes),
      overdue_run_cleanup_count: count(overdueCleanup?.count),
    };
  }
}

async function readConnectedHealth(
  actor: ModuleActor,
  limit: number,
): Promise<ConnectedAppHealthSummary> {
  const connected = (await listAppInstallations(actor))
    .filter((app) => app.manifest.compatibility.app_protocol === '1');
  const selected = connected.slice(0, limit);
  const health = await Promise.all(selected.map((app) => inspectConnectedAppHealth(
    actor,
    app.id,
    { refresh_provider_schemas: false },
  )));
  const issueCounts = new Map<string, number>();
  for (const item of health.flatMap((entry) => entry.issues)) {
    const code = safeIdentifier(item.code, 'APP_HEALTH_ISSUE');
    issueCounts.set(code, count(issueCounts.get(code)) + 1);
  }
  return {
    total: connected.length,
    checked: health.length,
    truncated: connected.length > selected.length,
    healthy: health.filter((item) => item.status === 'healthy').length,
    unhealthy: health.filter((item) => item.status === 'unhealthy').length,
    issue_counts: [...issueCounts].sort(([left], [right]) => left.localeCompare(right))
      .slice(0, APP_OPERATIONS_BOUNDS.health_issue_codes)
      .map(([code, issueCount]) => ({ code, count: issueCount })),
  };
}

const postgresAggregates = new PostgresAppOperationsAggregateReader();

export const appOperationsService = {
  async read(actor: ModuleActor) {
    await assertCurrentModuleManagerWithExecutor(db, actor);
    const runtime = await getAppRunRuntime();
    const projection = new AppOperationsProjectionService({
      assertManager: async () => {},
      runOperations: runtime.operations,
      readAggregates: (orgId, now) => postgresAggregates.read(orgId, now),
      readQueue: (orgId, now) => getOrgQueueHealthSnapshot(
        orgId,
        APP_RUN_ATTEMPT_JOB,
        getWorkerStatus(),
        now,
      ),
      readKeyReferences: async (orgId, now) => [
        ...await runtime.repository.activeKeyReferences(now, orgId),
        ...await runtime.secretRepository.retainedKeyReferences(now, orgId),
        ...await runtime.secretRepository.receiptSigningKeyReferences(orgId),
      ],
      configuredKeyIds: (purpose) => runtime.keys.keyIds(purpose),
      readConnectedHealth,
      now: () => new Date(),
    });
    return projection.read(actor);
  },
};
