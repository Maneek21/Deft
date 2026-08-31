import { createHash } from 'node:crypto';
import {
  APP_RUN_DEFAULT_ATTEMPT_LIMIT,
  APP_RUN_LIMITS,
  AppRunAuthorizationSnapshotSchema,
  AppRunSafeOutcomeSchema,
  canonicalCapabilityJson,
  idempotencyDeadline,
  parseAppRunSubmission,
  retentionDeadline,
  type AppRunActor,
  type AppRunAuthorizationSnapshot,
  type AppRunErrorCode,
  type AppRunRetentionClass,
  type AppRunRetryClass,
  type AppRunRiskClass,
  type AppRunSubmission,
} from '@deft/shared';
import {
  assertAppRunReferencedKeysAvailable,
  type AppRunKeyProvider,
} from './app-run-keyrings.js';
import type { AppRunSecretService } from './app-run-secrets.js';
import {
  noOpAppRunAttemptScheduler,
  type AppRunAttemptScheduler,
} from './app-run-scheduler.js';
import {
  denyAllAppRunAuthorizer,
  type AppRunAccessAction,
  type AppRunAuthorizer,
} from './app-run-authorization.js';
import { AppRunError, asAppRunError } from './app-run-errors.js';
import {
  PostgresAppRunRepository,
  appRunActorId,
  type AppRunChildLineage,
  type AppRunLineageInsert,
  type AppRunSafeView,
} from './app-run-repository.js';
import { AppRunSecretRepository } from './app-run-secret-repository.js';
import {
  postgresAppRunApprovalAdapter,
  type AppRunApprovalAdapter,
} from './app-run-approval-adapter.js';
import {
  noOpAppRunReceiptWriter,
  type AppRunReceiptWriter,
} from './app-run-receipts.js';
import {
  noOpAppRunAttentionProjector,
  type AppRunAttentionProjector,
} from './app-run-attention.js';
import type {
  AppRunPreparedInputCandidate,
  AppRunPreparedInputPayload,
} from './app-run-prepared-input.js';
import { APP_RUN_APP_AUTHORITY_KINDS } from './app-run-prepared-input.js';
import type {
  AppRunPreparedAppVerification,
} from './app-run-live-authorization.js';

export type AppRunTrustedContext = Readonly<{
  org_id: string;
  initiating_actor: AppRunActor;
  execution_actor: AppRunActor;
}>;

export interface AppRunPreparedInputOpener {
  open(orgId: string, candidate: AppRunPreparedInputCandidate): AppRunPreparedInputPayload;
}

export interface AppRunPreparedAppAuthorizer {
  capturePreparedAppInTransaction(
    tx: Parameters<Parameters<PostgresAppRunRepository['transaction']>[0]>[0],
    input: AppRunPreparedAppVerification,
  ): Promise<AppRunAuthorizationSnapshot>;
  authorizeDelivery(input: Readonly<{
    org_id: string;
    run: AppRunSafeView;
  }>): Promise<boolean>;
}

function sameActor(left: AppRunActor, right: AppRunActor): boolean {
  return left.actor_type === right.actor_type && appRunActorId(left) === appRunActorId(right);
}

function canonicalAuthorization(value: AppRunAuthorizationSnapshot): string {
  return canonicalCapabilityJson({
    ...value,
    authority_refs: [...value.authority_refs].sort((left, right) => {
      const leftKey = `${left.authority_kind}\0${left.authority_id}`;
      const rightKey = `${right.authority_kind}\0${right.authority_id}`;
      return leftKey.localeCompare(rightKey);
    }),
  });
}

const APP_AUTHORITY_KINDS = new Set<string>(APP_RUN_APP_AUTHORITY_KINDS);

function derivedSubmissionLock(submission: AppRunSubmission, parentRunId: string | null): string {
  const actor = appRunActorId(submission.initiating_actor);
  const digest = createHash('sha256');
  digest.update('deft.app_run.submit_lock.v1\0');
  for (const value of [
    submission.org_id,
    submission.initiating_actor.actor_type,
    actor,
    submission.operation.provider.provider_kind,
    submission.operation.provider.provider_instance_id,
    submission.operation.operation_name,
    submission.idempotency_key,
    parentRunId ?? 'root',
  ]) {
    digest.update(value);
    digest.update('\0');
  }
  return digest.digest('hex');
}

const AMBIENT_AUTHORITY_KINDS = new Set([
  'membership',
  'token_scope',
  'employee_health',
  'employee_budget',
]);

function riskRank(value: AppRunRiskClass): number {
  return ['read', 'internal_write', 'external_write', 'destructive', 'privileged'].indexOf(value);
}

function retryPermissionRank(value: AppRunRetryClass): number {
  return ['unsafe_or_unknown', 'idempotent_with_key', 'safe'].indexOf(value);
}

function retentionRank(value: AppRunRetentionClass): number {
  return ['ephemeral', 'standard', 'extended'].indexOf(value);
}

function childLineageInsert(
  lineage: AppRunChildLineage,
  submission: AppRunSubmission,
): AppRunLineageInsert {
  const parent = lineage.parent;
  if (
    (parent.state !== 'running' && parent.state !== 'waiting_external')
    || parent.depth >= APP_RUN_LIMITS.max_child_depth
  ) throw new AppRunError('APP_RUN_ANCESTRY_LIMIT');
  if (
    parent.initiating_actor_type !== submission.initiating_actor.actor_type
    || parent.initiating_actor_id !== appRunActorId(submission.initiating_actor)
    || parent.execution_actor_type !== submission.execution_actor.actor_type
    || parent.execution_actor_id !== appRunActorId(submission.execution_actor)
    || parent.origin_kind !== submission.origin.origin_kind
  ) throw new AppRunError('APP_RUN_ACCESS_DENIED');

  if (lineage.ancestors.some((ancestor) =>
    ancestor.provider_kind === submission.operation.provider.provider_kind
    && ancestor.provider_instance_id === submission.operation.provider.provider_instance_id
    && ancestor.operation_name === submission.operation.operation_name)) {
    throw new AppRunError('APP_RUN_CAPABILITY_CYCLE');
  }

  const parentAuthorization = AppRunAuthorizationSnapshotSchema.parse(
    lineage.parent_authorization_snapshot,
  );
  const parentRefs = new Set(parentAuthorization.authority_refs.map((ref) =>
    `${ref.authority_kind}\0${ref.authority_id}\0${ref.version}`));
  const ambientExpanded = submission.authorization_snapshot.authority_refs.some((ref) =>
    AMBIENT_AUTHORITY_KINDS.has(ref.authority_kind)
    && !parentRefs.has(`${ref.authority_kind}\0${ref.authority_id}\0${ref.version}`));
  if (ambientExpanded) throw new AppRunError('APP_RUN_ACCESS_DENIED');

  if (
    riskRank(submission.policy.risk_class) > riskRank(parent.risk_class)
    || (parent.review_requirement === 'always' && submission.policy.review_requirement !== 'always')
    || submission.policy.review_scope !== parent.review_scope
    || retryPermissionRank(submission.policy.retry_class) > retryPermissionRank(parent.retry_class)
    || retentionRank(submission.retention_class) > retentionRank(parent.retention_class)
  ) throw new AppRunError('APP_RUN_ACCESS_DENIED');

  if (
    submission.execution_actor.actor_type === 'agent_employee'
    && (
      lineage.root_budget_reserved_at === null
      || lineage.root_budget_reserved_count !== 1
      || lineage.root_budget_limit_at_reservation === null
    )
  ) throw new AppRunError('APP_RUN_ACCESS_DENIED');

  return Object.freeze({
    root_run_id: parent.root_run_id,
    parent_run_id: parent.id,
    depth: parent.depth + 1,
    budget_reserved_at: lineage.root_budget_reserved_at,
    budget_reserved_count: lineage.root_budget_reserved_count,
    budget_limit_at_reservation: lineage.root_budget_limit_at_reservation,
  });
}

function replayExecutionMatches(run: AppRunSafeView, submission: AppRunSubmission): boolean {
  return run.execution_actor_type === submission.execution_actor.actor_type
    && run.execution_actor_id === appRunActorId(submission.execution_actor)
    && run.origin_kind === submission.origin.origin_kind;
}

export function appRunReplayAuthorityMatches(
  replay: Readonly<{
    origin_app_installation_id: string | null;
    origin_app_version_id: string | null;
    origin_app_binding_key: string | null;
    origin_app_grant_snapshot_id: string | null;
    authorization_snapshot: Record<string, unknown>;
  }>,
  submission: AppRunSubmission,
): boolean {
  if (submission.origin.origin_kind !== 'app') return true;
  if (
    replay.origin_app_installation_id !== submission.origin.installation_id
    || replay.origin_app_version_id !== submission.origin.app_version_id
    || replay.origin_app_binding_key !== submission.origin.binding_key
    || replay.origin_app_grant_snapshot_id !== submission.origin.grant_snapshot_id
  ) return false;
  try {
    return canonicalAuthorization(AppRunAuthorizationSnapshotSchema.parse(
      replay.authorization_snapshot,
    )) === canonicalAuthorization(submission.authorization_snapshot);
  } catch {
    return false;
  }
}

export class AppRunService {
  constructor(
    private readonly repository: PostgresAppRunRepository,
    private readonly secretRepository: AppRunSecretRepository,
    private readonly secrets: AppRunSecretService,
    private readonly keys: AppRunKeyProvider,
    private readonly authorizer: AppRunAuthorizer = denyAllAppRunAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly approvalAdapter: AppRunApprovalAdapter = postgresAppRunApprovalAdapter,
    private readonly receiptWriter: AppRunReceiptWriter = noOpAppRunReceiptWriter,
    private readonly attention: AppRunAttentionProjector = noOpAppRunAttentionProjector,
    private readonly attemptScheduler: AppRunAttemptScheduler = noOpAppRunAttemptScheduler,
    private readonly preparedInput?: AppRunPreparedInputOpener,
    private readonly appLiveAuthorization?: AppRunPreparedAppAuthorizer,
    private readonly appOriginEnabled: () => boolean = () => false,
  ) {}

  async submit(context: AppRunTrustedContext, rawSubmission: unknown): Promise<AppRunSafeView> {
    return this.#submit(context, rawSubmission, null);
  }

  /** The only App-origin intake. All origin, provider, policy, actor, preview,
   * authority, and input facts come from one authenticated prepared candidate;
   * ordinary submit() continues to reject App origin unconditionally. */
  async submitPreparedApp(
    context: AppRunTrustedContext,
    candidate: AppRunPreparedInputCandidate,
  ): Promise<AppRunSafeView> {
    if (!this.appOriginEnabled() || !this.preparedInput || !this.appLiveAuthorization) {
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }
    let prepared: AppRunPreparedInputPayload;
    try {
      prepared = this.preparedInput.open(context.org_id, candidate);
    } catch {
      throw new AppRunError('APP_RUN_INPUT_INVALID');
    }
    const app = prepared.app_run;
    if (
      !app
      || !sameActor(context.initiating_actor, app.initiating_actor)
      || !sameActor(context.execution_actor, app.execution_actor)
    ) throw new AppRunError('APP_RUN_ACCESS_DENIED');
    const vector = app.authority_vector;
    const authorizationSnapshot = AppRunAuthorizationSnapshotSchema.parse({
      ...vector.run_authorization,
      authority_refs: [
        ...vector.run_authorization.authority_refs,
        ...app.authority_refs,
      ],
    });
    return this.#submit(context, {
      schema_version: vector.run_authorization.schema_version,
      org_id: context.org_id,
      initiating_actor: app.initiating_actor,
      execution_actor: app.execution_actor,
      origin: {
        origin_kind: 'app',
        installation_id: vector.installation.id,
        app_version_id: vector.app_version.id,
        binding_key: vector.binding.action_key,
        grant_snapshot_id: vector.grant.id,
      },
      operation: {
        provider: {
          org_id: context.org_id,
          provider_kind: 'mcp',
          provider_instance_id: vector.provider.connection_id,
        },
        operation_name: vector.provider.operation_name,
      },
      provider_snapshot_digest: vector.provider.snapshot_digest,
      policy: {
        risk_class: 'external_write',
        review_requirement: 'always',
        review_scope: 'per_invocation',
        retry_class: 'idempotent_with_key',
      },
      retention_class: 'standard',
      idempotency_key: `app-action:${prepared.replay_identity}`,
      input: prepared.provider_input,
      authorization_snapshot: authorizationSnapshot,
      safe_preview: app.safe_preview,
    }, null, vector);
  }

  async submitChild(
    context: AppRunTrustedContext,
    parentRunId: string,
    rawSubmission: unknown,
  ): Promise<AppRunSafeView> {
    if (!parentRunId || parentRunId !== parentRunId.trim()) {
      throw new AppRunError('APP_RUN_INPUT_INVALID');
    }
    return this.#submit(context, rawSubmission, parentRunId);
  }

  async #submit(
    context: AppRunTrustedContext,
    rawSubmission: unknown,
    parentRunId: string | null,
    trustedAppVector?: AppRunPreparedAppVerification['authority_vector'],
  ): Promise<AppRunSafeView> {
    let submission: AppRunSubmission;
    try {
      submission = parseAppRunSubmission(rawSubmission);
    } catch (error) {
      throw asAppRunError(error);
    }
    if (
      context.org_id !== submission.org_id
      || !sameActor(context.initiating_actor, submission.initiating_actor)
      || !sameActor(context.execution_actor, submission.execution_actor)
      || !sameActor(context.initiating_actor, submission.authorization_snapshot.authenticated_subject)
      || (submission.origin.origin_kind === 'app' && !trustedAppVector)
      || (submission.origin.origin_kind !== 'app' && trustedAppVector !== undefined)
      || (!trustedAppVector && submission.authorization_snapshot.authority_refs.some(
        (ref) => APP_AUTHORITY_KINDS.has(ref.authority_kind),
      ))
      || (submission.origin.origin_kind === 'legacy_connector'
        && submission.origin.connection_id !== submission.operation.provider.provider_instance_id)
    ) {
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }

    const now = this.now();
    await this.assertReferencedKeysAvailable(now);
    const idempotency = this.secrets.fingerprintText('idempotency', submission.idempotency_key);
    const replayCandidates = this.secrets.fingerprintTextCandidates('idempotency', submission.idempotency_key);
    const inputFingerprint = this.secrets.fingerprintJson('input', submission.input);
    const inputCandidates = this.secrets.fingerprintJsonCandidates('input', submission.input);
    const lock = derivedSubmissionLock(submission, parentRunId);
    const runId = crypto.randomUUID();
    const inputExpiresAt = retentionDeadline(submission.retention_class, now);
    const resultExpiresAt = retentionDeadline(submission.retention_class, now);
    const idempotencyExpiresAt = idempotencyDeadline(submission.retention_class, now);

    const submitted = await this.repository.transaction(async (tx) => {
      await this.repository.acquireSubmissionLock(tx, lock);
      if (trustedAppVector) {
        if (!this.appLiveAuthorization) throw new AppRunError('APP_RUN_ACCESS_DENIED');
        let live: AppRunAuthorizationSnapshot;
        try {
          live = await this.appLiveAuthorization.capturePreparedAppInTransaction(tx, {
            submission,
            authority_vector: trustedAppVector,
          });
        } catch {
          throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        }
        if (
          canonicalAuthorization(live) !== canonicalAuthorization(submission.authorization_snapshot)
        ) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      }
      const replay = await this.repository.findReplay(
        tx,
        submission,
        replayCandidates,
        now,
        parentRunId,
      );
      if (replay) {
        const sameInput = inputCandidates.some((candidate) =>
          candidate.key_version === replay.input_fingerprint_key_version
          && candidate.fingerprint === replay.input_fingerprint);
        if (
          !sameInput
          || !replayExecutionMatches(replay, submission)
          || !appRunReplayAuthorityMatches(replay, submission)
        ) {
          throw new AppRunError('APP_RUN_IDEMPOTENCY_CONFLICT');
        }
        const {
          input_fingerprint: _fingerprint,
          input_fingerprint_key_version: _version,
          origin_app_installation_id: _installation,
          origin_app_version_id: _appVersion,
          origin_app_binding_key: _binding,
          origin_app_grant_snapshot_id: _grant,
          authorization_snapshot: _authorization,
          ...safe
        } = replay;
        return safe;
      }
      const lineage = parentRunId === null
        ? undefined
        : await this.repository.loadChildLineage(tx, submission.org_id, parentRunId);
      if (parentRunId !== null && !lineage) {
        throw new AppRunError('APP_RUN_ACCESS_DENIED');
      }
      const lineageInsert = lineage ? childLineageInsert(lineage, submission) : undefined;
      const snapshot = await this.repository.findProviderSnapshot(tx, submission);
      if (!snapshot) throw new AppRunError('APP_RUN_PROVIDER_UNAVAILABLE');
      const boundedInputExpiry = lineage
        ? new Date(Math.min(inputExpiresAt.getTime(), lineage.parent.input_expires_at.getTime()))
        : inputExpiresAt;
      const boundedResultExpiry = lineage
        ? new Date(Math.min(resultExpiresAt.getTime(), lineage.parent.result_expires_at.getTime()))
        : resultExpiresAt;
      const boundedIdempotencyExpiry = lineage
        ? new Date(Math.min(idempotencyExpiresAt.getTime(), lineage.parent.idempotency_expires_at.getTime()))
        : idempotencyExpiresAt;
      if (boundedInputExpiry <= now || boundedResultExpiry <= now || boundedIdempotencyExpiry <= now) {
        throw new AppRunError('APP_RUN_EXPIRED');
      }
      const run = await this.repository.insertRun(tx, {
        id: runId,
        submission,
        provider_snapshot_id: snapshot.id,
        idempotency,
        input_fingerprint: inputFingerprint,
        input_expires_at: boundedInputExpiry,
        result_expires_at: boundedResultExpiry,
        idempotency_expires_at: boundedIdempotencyExpiry,
        attempt_limit: lineage
          ? Math.min(APP_RUN_DEFAULT_ATTEMPT_LIMIT, lineage.parent.attempt_limit)
          : APP_RUN_DEFAULT_ATTEMPT_LIMIT,
        lineage: lineageInsert,
        now,
      });
      await this.secretRepository.insertInput(tx, {
        org_id: submission.org_id,
        run_id: runId,
        value: submission.input,
        expires_at: boundedInputExpiry,
      });
      await this.repository.appendEvent(tx, {
        id: crypto.randomUUID(), org_id: submission.org_id, run_id: runId,
        event_type: 'run_created', actor: submission.initiating_actor,
        payload: { state: run.state }, now,
      });
      if (run.state === 'pending_approval') {
        const actionId = await this.approvalAdapter.create({
          tx,
          run,
          submission,
          now,
        });
        await this.repository.appendEvent(tx, {
          id: crypto.randomUUID(),
          org_id: submission.org_id,
          run_id: runId,
          event_type: 'approval_requested',
          actor: submission.initiating_actor,
          payload: { action_id: actionId },
          now,
        });
      }
      if (run.execution_released_at) {
        await this.attemptScheduler.scheduleInTransaction(tx, run, now);
      }
      return run;
    });
    if (submitted.state === 'pending_approval') {
      try {
        await this.attention.projectApprovalRequested(submitted.org_id, submitted.id);
      } catch (error) {
        console.warn('[app-runs] approval Attention projection failed:',
          error instanceof Error ? error.message : 'unknown error');
      }
    }
    return submitted;
  }

  async inspect(orgId: string, runId: string, actor: AppRunActor): Promise<AppRunSafeView> {
    const run = await this.requiredRun(orgId, runId);
    await this.assertAuthorized('inspect', orgId, actor, run);
    return run;
  }

  async cancel(orgId: string, runId: string, actor: AppRunActor): Promise<AppRunSafeView> {
    const visible = await this.requiredRun(orgId, runId);
    await this.assertAuthorized('cancel', orgId, actor, visible);
    return this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, orgId, runId);
      if (!run) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      if (run.state === 'pending' || run.state === 'pending_approval') {
        return this.repository.transition(tx, {
          run, state: 'cancelled', actor, now: this.now(), error_code: 'APP_RUN_CANCELLED',
          safe_outcome: AppRunSafeOutcomeSchema.parse({
            success: false, provider_call_attempted: false,
            result_status: 'unavailable', error_code: 'APP_RUN_CANCELLED',
          }),
        });
      }
      if (run.state === 'running' || run.state === 'waiting_external') {
        return this.repository.requestCancellation(tx, run, actor, this.now());
      }
      return run;
    });
  }

  async expire(orgId: string, runId: string): Promise<AppRunSafeView> {
    return this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, orgId, runId);
      if (!run) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      if (run.state !== 'pending' && run.state !== 'pending_approval') return run;
      return this.repository.transition(tx, {
        run, state: 'expired', now: this.now(), error_code: 'APP_RUN_EXPIRED',
        safe_outcome: AppRunSafeOutcomeSchema.parse({
          success: false, provider_call_attempted: false,
          result_status: 'unavailable', error_code: 'APP_RUN_EXPIRED',
        }),
      });
    });
  }

  async reconcileUnknown(
    orgId: string,
    runId: string,
    actor: AppRunActor,
    resolution: 'succeeded' | 'failed',
  ): Promise<AppRunSafeView> {
    const visible = await this.requiredRun(orgId, runId);
    await this.assertAuthorized('reconcile', orgId, actor, visible);
    const reconciled = await this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, orgId, runId);
      if (!run || run.state !== 'unknown_outcome') {
        throw new AppRunError('APP_RUN_ILLEGAL_TRANSITION');
      }
      const errorCode: AppRunErrorCode | undefined = resolution === 'failed'
        ? 'APP_RUN_PROVIDER_ERROR'
        : undefined;
      const resolved = await this.repository.transition(tx, {
        run, state: resolution, actor, now: this.now(), error_code: errorCode,
        event_type: 'reconciliation_recorded',
        safe_outcome: AppRunSafeOutcomeSchema.parse({
          success: resolution === 'succeeded',
          provider_call_attempted: true,
          result_status: 'unavailable',
          ...(errorCode ? { error_code: errorCode } : {}),
        }),
      });
      await this.receiptWriter.write(tx, {
        receipt_key: `reconciliation:${run.id}:${resolved.reconciled_at?.toISOString() ?? 'recorded'}`,
        receipt_kind: 'reconciliation',
        run: resolved,
        actor,
        facts: { resolution },
        occurred_at: resolved.reconciled_at ?? this.now(),
      });
      return resolved;
    });
    try {
      await this.attention.projectRunState(reconciled, 'reconciled');
    } catch (error) {
      console.warn('[app-runs] reconciliation Attention projection failed:',
        error instanceof Error ? error.message : 'unknown error');
    }
    return reconciled;
  }

  async result(orgId: string, runId: string, actor: AppRunActor): Promise<Readonly<{
    run: AppRunSafeView;
    value: unknown;
  }>> {
    const run = await this.requiredRun(orgId, runId);
    await this.assertAuthorized('result', orgId, actor, run);
    if (
      run.origin_kind === 'app'
      && (!this.appLiveAuthorization || !await this.appLiveAuthorization.authorizeDelivery({
        org_id: orgId,
        run,
      }))
    ) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    if (run.result_purged_at || run.result_expires_at <= this.now()) {
      throw new AppRunError('APP_RUN_RESULT_EXPIRED');
    }
    const attemptId = await this.repository.latestRetainedAttemptId(orgId, runId);
    if (!attemptId) throw new AppRunError('APP_RUN_RESULT_EXPIRED');
    const value = await this.secretRepository.readOutput(orgId, runId, attemptId);
    if (value === null) throw new AppRunError('APP_RUN_RESULT_EXPIRED');
    return Object.freeze({ run, value });
  }

  async purgeExpiredSecrets(now = this.now(), limit = 100): Promise<number> {
    return this.secretRepository.purgeExpiredBatch(now, limit);
  }

  async assertReferencedKeysAvailable(now = this.now()): Promise<void> {
    const references = [
      ...await this.repository.activeKeyReferences(now),
      ...await this.secretRepository.retainedKeyReferences(now),
      ...await this.secretRepository.receiptSigningKeyReferences(),
    ];
    assertAppRunReferencedKeysAvailable(this.keys, references);
  }

  async requiredRun(orgId: string, runId: string): Promise<AppRunSafeView> {
    const run = await this.repository.inspect(orgId, runId);
    if (!run) throw new AppRunError('APP_RUN_ACCESS_DENIED');
    return run;
  }

  async assertAuthorized(
    action: AppRunAccessAction,
    orgId: string,
    actor: AppRunActor,
    run: AppRunSafeView,
  ): Promise<void> {
    if (!await this.authorizer.authorize({ action, org_id: orgId, actor, run })) {
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }
  }
}
