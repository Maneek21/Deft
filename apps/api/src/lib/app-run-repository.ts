import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  appActionBindings,
  appRunAttempts,
  appRunEvents,
  appRuns,
  capabilityProviderSnapshots,
} from '@deft/db/schema';
import type {
  AppRunActor,
  AppRunErrorCode,
  AppRunSafeOutcome,
  AppRunState,
  AppRunSubmission,
} from '@deft/shared';
import { db } from './db.js';

export type AppRunTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const safeRunSelection = {
  id: appRuns.id,
  org_id: appRuns.org_id,
  contract_version: appRuns.contract_version,
  origin_kind: appRuns.origin_kind,
  initiating_actor_type: appRuns.initiating_actor_type,
  initiating_actor_id: appRuns.initiating_actor_id,
  execution_actor_type: appRuns.execution_actor_type,
  execution_actor_id: appRuns.execution_actor_id,
  provider_kind: appRuns.provider_kind,
  provider_instance_id: appRuns.provider_instance_id,
  operation_name: appRuns.operation_name,
  state: appRuns.state,
  risk_class: appRuns.risk_class,
  review_requirement: appRuns.review_requirement,
  review_scope: appRuns.review_scope,
  retry_class: appRuns.retry_class,
  retention_class: appRuns.retention_class,
  safe_preview: appRuns.safe_preview,
  safe_outcome: appRuns.safe_outcome,
  root_run_id: appRuns.root_run_id,
  parent_run_id: appRuns.parent_run_id,
  depth: appRuns.depth,
  input_expires_at: appRuns.input_expires_at,
  result_expires_at: appRuns.result_expires_at,
  idempotency_expires_at: appRuns.idempotency_expires_at,
  attempt_limit: appRuns.attempt_limit,
  execution_release_kind: appRuns.execution_release_kind,
  execution_released_at: appRuns.execution_released_at,
  input_purged_at: appRuns.input_purged_at,
  result_purged_at: appRuns.result_purged_at,
  started_at: appRuns.started_at,
  terminal_at: appRuns.terminal_at,
  unknown_outcome_at: appRuns.unknown_outcome_at,
  reconciled_at: appRuns.reconciled_at,
  cancelled_at: appRuns.cancelled_at,
  cancel_requested_at: appRuns.cancel_requested_at,
  created_at: appRuns.created_at,
  updated_at: appRuns.updated_at,
};

export type AppRunSafeView = Pick<typeof appRuns.$inferSelect, keyof typeof safeRunSelection>;

export function appRunActorId(actor: AppRunActor): string {
  switch (actor.actor_type) {
    case 'human': return actor.user_id;
    case 'agent_employee': return actor.agent_employee_id;
    case 'system': return actor.system_id;
    case 'automation': return actor.automation_id;
  }
}

function actorColumns(actor: AppRunActor) {
  return { type: actor.actor_type, id: appRunActorId(actor) };
}

export type FingerprintCandidate = Readonly<{ key_version: string; fingerprint: string }>;

export type AppRunProviderDispatchPin = Readonly<{
  connector_authorization_version: number;
  provider_snapshot_digest: string;
  operation_schema_digest: string;
}>;

export type AppRunChildLineage = Readonly<{
  parent: AppRunSafeView;
  ancestors: readonly AppRunSafeView[];
  parent_authorization_snapshot: Record<string, unknown>;
  root_budget_reserved_at: Date | null;
  root_budget_reserved_count: number | null;
  root_budget_limit_at_reservation: number | null;
}>;

export type AppRunLineageInsert = Readonly<{
  root_run_id: string;
  parent_run_id: string;
  depth: number;
  budget_reserved_at: Date | null;
  budget_reserved_count: number | null;
  budget_limit_at_reservation: number | null;
}>;

export type AppRunAutomationLineageInsert = Readonly<{
  definition_id: string;
  fire_id: string;
}>;

export class PostgresAppRunRepository {
  async transaction<T>(work: (tx: AppRunTransaction) => Promise<T>): Promise<T> {
    return db.transaction(work);
  }

  async acquireSubmissionLock(tx: AppRunTransaction, derivedLock: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${derivedLock}, 0))`);
  }

  async findProviderSnapshot(tx: AppRunTransaction, submission: AppRunSubmission) {
    const [snapshot] = await tx.select().from(capabilityProviderSnapshots).where(and(
      eq(capabilityProviderSnapshots.org_id, submission.org_id),
      eq(capabilityProviderSnapshots.provider_kind, submission.operation.provider.provider_kind),
      eq(capabilityProviderSnapshots.provider_instance_id, submission.operation.provider.provider_instance_id),
      eq(capabilityProviderSnapshots.snapshot_digest, submission.provider_snapshot_digest),
    )).limit(1);
    return snapshot ?? null;
  }

  async findReplay(
    tx: AppRunTransaction,
    submission: AppRunSubmission,
    candidates: readonly FingerprintCandidate[],
    now: Date,
    parentRunId: string | null = null,
  ): Promise<(AppRunSafeView & {
    input_fingerprint_key_version: string;
    input_fingerprint: string;
    origin_app_installation_id: string | null;
    origin_app_version_id: string | null;
    origin_app_binding_key: string | null;
    origin_app_grant_snapshot_id: string | null;
    origin_app_automation_definition_id: string | null;
    origin_app_automation_fire_id: string | null;
    authorization_snapshot: Record<string, unknown>;
  }) | null> {
    const actor = actorColumns(submission.initiating_actor);
    const candidateFilters = candidates.map((candidate) => and(
      eq(appRuns.idempotency_key_version, candidate.key_version),
      eq(appRuns.idempotency_fingerprint, candidate.fingerprint),
    ));
    const [row] = await tx.select({
      ...safeRunSelection,
      input_fingerprint_key_version: appRuns.input_fingerprint_key_version,
      input_fingerprint: appRuns.input_fingerprint,
      origin_app_installation_id: appRuns.origin_app_installation_id,
      origin_app_version_id: appRuns.origin_app_version_id,
      origin_app_binding_key: appRuns.origin_app_binding_key,
      origin_app_grant_snapshot_id: appRuns.origin_app_grant_snapshot_id,
      origin_app_automation_definition_id: appRuns.origin_app_automation_definition_id,
      origin_app_automation_fire_id: appRuns.origin_app_automation_fire_id,
      authorization_snapshot: appRuns.authorization_snapshot,
    }).from(appRuns).where(and(
      eq(appRuns.org_id, submission.org_id),
      eq(appRuns.initiating_actor_type, actor.type),
      eq(appRuns.initiating_actor_id, actor.id),
      eq(appRuns.provider_kind, submission.operation.provider.provider_kind),
      eq(appRuns.provider_instance_id, submission.operation.provider.provider_instance_id),
      eq(appRuns.operation_name, submission.operation.operation_name),
      gt(appRuns.idempotency_expires_at, now),
      parentRunId === null
        ? isNull(appRuns.parent_run_id)
        : eq(appRuns.parent_run_id, parentRunId),
      or(...candidateFilters),
    )).limit(1);
    return row ?? null;
  }

  /** Load only immutable reviewed dispatch evidence. The connection itself is
   * resolved later with this exact authorization version so target/auth races
   * cannot inherit the Run. */
  async loadAppProviderDispatchPin(
    tx: AppRunTransaction,
    orgId: string,
    runId: string,
  ): Promise<AppRunProviderDispatchPin | null> {
    const [pin] = await tx.select({
      connector_authorization_version: appActionBindings.connector_authorization_version,
      provider_snapshot_digest: capabilityProviderSnapshots.snapshot_digest,
      operation_schema_digest: appActionBindings.operation_schema_digest,
    }).from(appRuns).innerJoin(appActionBindings, and(
      eq(appActionBindings.org_id, appRuns.org_id),
      eq(appActionBindings.app_installation_id, appRuns.origin_app_installation_id),
      eq(appActionBindings.app_version_id, appRuns.origin_app_version_id),
      eq(appActionBindings.grant_snapshot_id, appRuns.origin_app_grant_snapshot_id),
      eq(appActionBindings.action_key, appRuns.origin_app_binding_key),
      eq(appActionBindings.provider_kind, appRuns.provider_kind),
      eq(appActionBindings.mcp_connection_id, appRuns.provider_instance_id),
      eq(appActionBindings.operation_name, appRuns.operation_name),
      eq(appActionBindings.provider_snapshot_id, appRuns.provider_snapshot_id),
    )).innerJoin(capabilityProviderSnapshots, and(
      eq(capabilityProviderSnapshots.org_id, appRuns.org_id),
      eq(capabilityProviderSnapshots.id, appRuns.provider_snapshot_id),
      eq(capabilityProviderSnapshots.provider_kind, appRuns.provider_kind),
      eq(capabilityProviderSnapshots.provider_instance_id, appRuns.provider_instance_id),
    )).where(and(
      eq(appRuns.org_id, orgId),
      eq(appRuns.id, runId),
      eq(appRuns.origin_kind, 'app'),
    )).limit(1);
    return pin ? Object.freeze(pin) : null;
  }

  async loadChildLineage(
    tx: AppRunTransaction,
    orgId: string,
    parentRunId: string,
  ): Promise<AppRunChildLineage | null> {
    const ancestors: AppRunSafeView[] = [];
    let cursor: string | null = parentRunId;
    while (cursor !== null && ancestors.length <= 8) {
      const run = await this.lockRun(tx, orgId, cursor);
      if (!run) return null;
      ancestors.push(run);
      cursor = run.parent_run_id;
    }
    if (cursor !== null || ancestors.length === 0) return null;

    const parent = ancestors[0]!;
    const root = ancestors.at(-1)!;
    if (
      root.id !== parent.root_run_id
      || root.id !== root.root_run_id
      || root.depth !== 0
    ) return null;

    const [internal] = await tx.select({
      authorization_snapshot: appRuns.authorization_snapshot,
    }).from(appRuns).where(and(
      eq(appRuns.org_id, orgId),
      eq(appRuns.id, parent.id),
    )).limit(1);
    const [rootBudget] = await tx.select({
      budget_reserved_at: appRuns.budget_reserved_at,
      budget_reserved_count: appRuns.budget_reserved_count,
      budget_limit_at_reservation: appRuns.budget_limit_at_reservation,
    }).from(appRuns).where(and(
      eq(appRuns.org_id, orgId),
      eq(appRuns.id, root.id),
    )).limit(1);
    if (!internal || !rootBudget) return null;
    return Object.freeze({
      parent,
      ancestors: Object.freeze(ancestors),
      parent_authorization_snapshot: internal.authorization_snapshot,
      root_budget_reserved_at: rootBudget.budget_reserved_at,
      root_budget_reserved_count: rootBudget.budget_reserved_count,
      root_budget_limit_at_reservation: rootBudget.budget_limit_at_reservation,
    });
  }

  async insertRun(
    tx: AppRunTransaction,
    input: Readonly<{
      id: string;
      submission: AppRunSubmission;
      provider_snapshot_id: string;
      idempotency: FingerprintCandidate;
      input_fingerprint: FingerprintCandidate;
      input_expires_at: Date;
      result_expires_at: Date;
      idempotency_expires_at: Date;
      attempt_limit: number;
      lineage?: AppRunLineageInsert;
      automation_lineage?: AppRunAutomationLineageInsert;
      now: Date;
    }>,
  ): Promise<AppRunSafeView> {
    const initiating = actorColumns(input.submission.initiating_actor);
    const execution = actorColumns(input.submission.execution_actor);
    const [run] = await tx.insert(appRuns).values({
      id: input.id,
      org_id: input.submission.org_id,
      contract_version: input.submission.schema_version,
      origin_kind: input.submission.origin.origin_kind,
      initiating_actor_type: initiating.type,
      initiating_actor_id: initiating.id,
      execution_actor_type: execution.type,
      execution_actor_id: execution.id,
      provider_kind: input.submission.operation.provider.provider_kind,
      provider_instance_id: input.submission.operation.provider.provider_instance_id,
      operation_name: input.submission.operation.operation_name,
      provider_snapshot_id: input.provider_snapshot_id,
      origin_app_installation_id: input.submission.origin.origin_kind === 'app'
        ? input.submission.origin.installation_id
        : null,
      origin_app_version_id: input.submission.origin.origin_kind === 'app'
        ? input.submission.origin.app_version_id
        : null,
      origin_app_binding_key: input.submission.origin.origin_kind === 'app'
        ? input.submission.origin.binding_key
        : null,
      origin_app_grant_snapshot_id: input.submission.origin.origin_kind === 'app'
        ? input.submission.origin.grant_snapshot_id
        : null,
      origin_app_automation_definition_id: input.automation_lineage?.definition_id ?? null,
      origin_app_automation_fire_id: input.automation_lineage?.fire_id ?? null,
      state: input.submission.policy.review_scope === 'approved_automation_definition'
        ? 'pending'
        : input.submission.policy.review_requirement === 'always'
          ? 'pending_approval'
          : 'pending',
      risk_class: input.submission.policy.risk_class,
      review_requirement: input.submission.policy.review_requirement,
      review_scope: input.submission.policy.review_scope,
      retry_class: input.submission.policy.retry_class,
      retention_class: input.submission.retention_class,
      idempotency_key_version: input.idempotency.key_version,
      idempotency_fingerprint: input.idempotency.fingerprint,
      input_fingerprint_key_version: input.input_fingerprint.key_version,
      input_fingerprint: input.input_fingerprint.fingerprint,
      authorization_snapshot: input.submission.authorization_snapshot,
      safe_preview: input.submission.safe_preview,
      root_run_id: input.lineage?.root_run_id ?? input.id,
      parent_run_id: input.lineage?.parent_run_id ?? null,
      depth: input.lineage?.depth ?? 0,
      input_expires_at: input.input_expires_at,
      result_expires_at: input.result_expires_at,
      idempotency_expires_at: input.idempotency_expires_at,
      attempt_limit: input.attempt_limit,
      budget_reserved_at: input.lineage?.budget_reserved_at ?? null,
      budget_reserved_count: input.lineage?.budget_reserved_count ?? null,
      budget_limit_at_reservation: input.lineage?.budget_limit_at_reservation ?? null,
      execution_release_kind: input.submission.policy.review_scope === 'approved_automation_definition'
        ? 'approved_automation_definition'
        : input.submission.policy.review_requirement === 'policy'
          ? 'policy_satisfied'
          : null,
      execution_released_at: input.submission.policy.review_scope === 'approved_automation_definition'
        || input.submission.policy.review_requirement === 'policy'
        ? input.now
        : null,
      created_at: input.now,
      updated_at: input.now,
    }).returning(safeRunSelection);
    if (!run) throw new Error('APP_RUN_INPUT_INVALID');
    return run;
  }

  async appendEvent(
    tx: AppRunTransaction,
    input: Readonly<{
      id: string;
      org_id: string;
      run_id: string;
      event_type: string;
      actor?: AppRunActor;
      payload?: Record<string, unknown>;
      now: Date;
    }>,
  ): Promise<void> {
    const [sequenceRow] = await tx.select({
      next: sql<number>`COALESCE(MAX(${appRunEvents.sequence}), 0)::int + 1`,
    }).from(appRunEvents).where(and(
      eq(appRunEvents.org_id, input.org_id),
      eq(appRunEvents.run_id, input.run_id),
    ));
    const actor = input.actor ? actorColumns(input.actor) : null;
    await tx.insert(appRunEvents).values({
      id: input.id,
      org_id: input.org_id,
      run_id: input.run_id,
      sequence: sequenceRow?.next ?? 1,
      event_type: input.event_type,
      actor_type: actor?.type ?? null,
      actor_id: actor?.id ?? null,
      payload: input.payload ?? {},
      created_at: input.now,
    });
  }

  async inspect(orgId: string, runId: string): Promise<AppRunSafeView | null> {
    const [run] = await db.select(safeRunSelection).from(appRuns).where(and(
      eq(appRuns.org_id, orgId),
      eq(appRuns.id, runId),
    )).limit(1);
    return run ?? null;
  }

  async lockRun(tx: AppRunTransaction, orgId: string, runId: string): Promise<AppRunSafeView | null> {
    await tx.execute(sql`SELECT id FROM app_runs WHERE org_id = ${orgId} AND id = ${runId} FOR UPDATE`);
    const [run] = await tx.select(safeRunSelection).from(appRuns).where(and(
      eq(appRuns.org_id, orgId),
      eq(appRuns.id, runId),
    )).limit(1);
    return run ?? null;
  }

  async transition(
    tx: AppRunTransaction,
    input: Readonly<{
      run: AppRunSafeView;
      state: AppRunState;
      actor?: AppRunActor;
      safe_outcome?: AppRunSafeOutcome;
      error_code?: AppRunErrorCode;
      now: Date;
      event_type?: string;
    }>,
  ): Promise<AppRunSafeView> {
    if (input.run.state === input.state) return input.run;
    const terminal = ['succeeded', 'failed', 'cancelled', 'expired'].includes(input.state);
    const [updated] = await tx.update(appRuns).set({
      state: input.state,
      safe_outcome: input.safe_outcome ?? input.run.safe_outcome,
      started_at: input.state === 'running' ? (input.run.started_at ?? input.now) : input.run.started_at,
      terminal_at: terminal ? (input.run.terminal_at ?? input.now) : input.run.terminal_at,
      unknown_outcome_at: input.state === 'unknown_outcome'
        ? (input.run.unknown_outcome_at ?? input.now)
        : input.run.unknown_outcome_at,
      reconciled_at: input.run.state === 'unknown_outcome' ? input.now : input.run.reconciled_at,
      cancelled_at: input.state === 'cancelled' ? (input.run.cancelled_at ?? input.now) : input.run.cancelled_at,
      updated_at: input.now,
    }).where(and(eq(appRuns.org_id, input.run.org_id), eq(appRuns.id, input.run.id)))
      .returning(safeRunSelection);
    if (!updated) throw new Error('APP_RUN_ILLEGAL_TRANSITION');
    await this.appendEvent(tx, {
      id: crypto.randomUUID(),
      org_id: input.run.org_id,
      run_id: input.run.id,
      event_type: input.event_type ?? 'run_transitioned',
      actor: input.actor,
      payload: { from_state: input.run.state, to_state: input.state, ...(input.error_code ? { error_code: input.error_code } : {}) },
      now: input.now,
    });
    return updated;
  }

  async requestCancellation(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    actor: AppRunActor,
    now: Date,
  ): Promise<AppRunSafeView> {
    if (run.cancel_requested_at) return run;
    const [updated] = await tx.update(appRuns).set({ cancel_requested_at: now, updated_at: now })
      .where(and(eq(appRuns.org_id, run.org_id), eq(appRuns.id, run.id)))
      .returning(safeRunSelection);
    if (!updated) throw new Error('APP_RUN_ILLEGAL_TRANSITION');
    await this.appendEvent(tx, {
      id: crypto.randomUUID(), org_id: run.org_id, run_id: run.id,
      event_type: 'cancellation_requested', actor, payload: {}, now,
    });
    return updated;
  }

  async recordApprovedExecutionRelease(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    actor: AppRunActor,
    now: Date,
  ): Promise<AppRunSafeView> {
    if (run.execution_release_kind) {
      if (run.execution_release_kind === 'approved') return run;
      throw new Error('APP_RUN_ILLEGAL_TRANSITION');
    }
    const [updated] = await tx.update(appRuns).set({
      execution_release_kind: 'approved',
      execution_released_at: now,
      updated_at: now,
    }).where(and(
      eq(appRuns.org_id, run.org_id),
      eq(appRuns.id, run.id),
      eq(appRuns.state, 'pending_approval'),
    )).returning(safeRunSelection);
    if (!updated) throw new Error('APP_RUN_ILLEGAL_TRANSITION');
    await this.appendEvent(tx, {
      id: crypto.randomUUID(),
      org_id: run.org_id,
      run_id: run.id,
      event_type: 'approval_resolved',
      actor,
      payload: { resolution: 'approved', execution_release_kind: 'approved' },
      now,
    });
    return updated;
  }

  async activeKeyReferences(
    now: Date,
    orgId?: string,
  ): Promise<readonly { purpose: 'fingerprint'; key_id: string }[]> {
    const rows = await db.select({
      idempotency: appRuns.idempotency_key_version,
      input: appRuns.input_fingerprint_key_version,
    }).from(appRuns).where(and(
      gt(appRuns.idempotency_expires_at, now),
      ...(orgId ? [eq(appRuns.org_id, orgId)] : []),
    ));
    const ids = new Set(rows.flatMap((row) => [row.idempotency, row.input]));
    return [...ids].map((key_id) => ({ purpose: 'fingerprint' as const, key_id }));
  }

  async pendingAttemptIds(orgId: string, runId: string): Promise<readonly string[]> {
    const rows = await db.select({ id: appRunAttempts.id }).from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, orgId),
      eq(appRunAttempts.run_id, runId),
      inArray(appRunAttempts.state, ['pending', 'claimed', 'provider_call_started']),
    )).orderBy(asc(appRunAttempts.attempt_number));
    return rows.map((row) => row.id);
  }

  async latestRetainedAttemptId(orgId: string, runId: string): Promise<string | null> {
    const [row] = await db.select({ id: appRunAttempts.id }).from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, orgId),
      eq(appRunAttempts.run_id, runId),
      sql`${appRunAttempts.provider_call_finished_at} IS NOT NULL`,
      sql`${appRunAttempts.safe_outcome}->>'result_status' = 'retained'`,
    )).orderBy(sql`${appRunAttempts.attempt_number} DESC`).limit(1);
    return row?.id ?? null;
  }
}
