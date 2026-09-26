import { parseNativeCalendarInput, parseNativeCalendarResult, NATIVE_ACTION_HOST_POLICY } from '@deft/app-kit';
import { isAppNativeCalendarEnabled } from './env.js';
import { nativeFinalAuthorityIsCurrent } from './app-native-final-authority.js';
import type { ReviewedNativeCapture, ReviewedPublicNativeCapture } from './app-native-run-authorization.js';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  APP_RUN_DEFAULT_ATTEMPT_LIMIT,
  APP_RUN_CONTRACT_VERSIONS,
  APP_RUN_LIMITS,
  AppRunAuthorizationSnapshotSchema,
  AppRunSafePreviewSchema,
  AppRunSafeOutcomeSchema,
  AppRunRetainedProviderResultSchema,
  assertAppRunOutputWithinBudget,
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
import { APP_AUTOMATION_POLICY_V1, RuntimeObjectSchema, parseRuntimeObjectInput } from '@deft/app-kit';
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
  type AppRunReadAuthorityRef,
} from './app-run-authorization.js';
import { AppRunError, asAppRunError } from './app-run-errors.js';
import { isAppError } from './app-errors.js';
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
  PostgresAppRunLiveAuthorization,
} from './app-run-live-authorization.js';
import { bindAppAutomationFireRunWithExecutor } from './app-automation-repository.js';
import { appRuntimeChannelEnabled } from './app-runtime-channel.js';
import type { ReviewedRuntimeInvoke, ReviewedRuntimeCaller } from './app-runtime-action-service.js';
import type { AppRunTransaction } from './app-run-repository.js';

export type ReviewedRuntimeCapture = Readonly<{
  authorization_snapshot: AppRunAuthorizationSnapshot;
  binding: Readonly<{
    id: string;
    org_id: string;
    app_installation_id: string;
    app_version_id: string;
    grant_snapshot_id: string;
    action_key: string;
    provider_kind: 'app_runtime';
    provider_instance_id: string;
    provider_snapshot_id: string;
    operation_name: string;
    risk_class: AppRunRiskClass;
    review_requirement: 'policy' | 'always';
    retry_class: AppRunRetryClass;
    retention_class: AppRunRetentionClass;
  }>;
  action: Readonly<{
    action_key: string;
    contract_digest: string;
    input_schema: unknown;
    host_policy: Readonly<{ review_scope: 'per_invocation' }>;
  }>;
  provider_snapshot_digest: string;
  review_contract_digest: string;
  installation_lifecycle_epoch: number;
  installation_grant_epoch: number;
}>;
export type ReviewedPublicRuntimeCapture = Awaited<ReturnType<
  PostgresAppRunLiveAuthorization['captureReviewedPublicRuntimeInTransaction']>>;

export type AppRunTrustedContext = Readonly<{
  org_id: string;
  initiating_actor: AppRunActor;
  execution_actor: AppRunActor;
  /** Host-only secret fence; never persisted or included in authority vectors. */
  automation_claim_token?: string;
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
  captureReviewedNativeInTransaction?(tx: AppRunTransaction, input: Readonly<{
    org_id: string; user_id: string; native_binding_id: string;
  }>): Promise<ReviewedNativeCapture>;
  captureReviewedPublicNativeInTransaction?(tx: AppRunTransaction, input: Readonly<{
    org_id: string; endpoint_id: string; ingress_id: string; capture_input?: boolean;
  }>): Promise<ReviewedPublicNativeCapture>;
  captureReviewedRuntimeForPreparation?(input: Readonly<{
    org_id: string; user_id: string; runtime_binding_id: string;
  }>): Promise<ReviewedRuntimeCapture>;
  captureReviewedRuntimeInTransaction?(tx: AppRunTransaction, input: Readonly<{
    org_id: string; user_id: string; runtime_binding_id: string;
  }>): Promise<ReviewedRuntimeCapture>;
  captureReviewedPublicRuntimeInTransaction?(tx: AppRunTransaction, input: Readonly<{
    org_id: string; endpoint_id: string; ingress_id: string;
  }>): Promise<ReviewedPublicRuntimeCapture>;
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

function runtimeCaptureIdentity(capture: ReviewedRuntimeCapture): string {
  const binding = capture.binding;
  return canonicalCapabilityJson({
    binding: {
      id: binding.id, org_id: binding.org_id,
      app_installation_id: binding.app_installation_id,
      app_version_id: binding.app_version_id,
      grant_snapshot_id: binding.grant_snapshot_id,
      action_key: binding.action_key,
      provider_kind: binding.provider_kind,
      provider_instance_id: binding.provider_instance_id,
      provider_snapshot_id: binding.provider_snapshot_id,
      operation_name: binding.operation_name,
      risk_class: binding.risk_class,
      review_requirement: binding.review_requirement,
      retry_class: binding.retry_class,
      retention_class: binding.retention_class,
    },
    action: capture.action,
    provider_snapshot_digest: capture.provider_snapshot_digest,
    review_contract_digest: capture.review_contract_digest,
    installation_lifecycle_epoch: capture.installation_lifecycle_epoch,
    installation_grant_epoch: capture.installation_grant_epoch,
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
    origin_runtime_binding_id?: string | null;
    origin_native_binding_id?: string | null;
    origin_public_endpoint_id?: string | null;
    origin_public_ingress_id?: string | null;
    origin_app_grant_snapshot_id: string | null;
    origin_app_automation_definition_id?: string | null;
    origin_app_automation_fire_id?: string | null;
    authorization_snapshot: Record<string, unknown>;
  }>,
  submission: AppRunSubmission,
  trustedAppVector?: AppRunPreparedAppVerification['authority_vector'],
): boolean {
  if (submission.origin.origin_kind !== 'app') return true;
  const runtimeBindingId = 'runtime_binding_id' in submission.origin
    ? submission.origin.runtime_binding_id
    : null;
  const actionBindingKey = 'binding_key' in submission.origin
    ? submission.origin.binding_key
    : null;
  const publicEndpointId = 'public_endpoint_id' in submission.origin
    ? submission.origin.public_endpoint_id : null;
  const publicIngressId = 'public_ingress_id' in submission.origin
    ? submission.origin.public_ingress_id : null;
  if (
    replay.origin_app_installation_id !== submission.origin.installation_id
    || replay.origin_app_version_id !== submission.origin.app_version_id
    || replay.origin_app_binding_key !== actionBindingKey
    || (replay.origin_runtime_binding_id ?? null) !== runtimeBindingId
    || (replay.origin_native_binding_id ?? null) !== ('native_binding_id' in submission.origin ? submission.origin.native_binding_id : null)
    || (replay.origin_public_endpoint_id ?? null) !== publicEndpointId
    || (replay.origin_public_ingress_id ?? null) !== publicIngressId
    || replay.origin_app_grant_snapshot_id !== submission.origin.grant_snapshot_id
  ) return false;
  if (trustedAppVector?.schema_version === 'deft.app_action_authority.v2') {
    if (
      replay.origin_app_automation_definition_id !== trustedAppVector.automation.definition.id
      || replay.origin_app_automation_fire_id !== trustedAppVector.automation.fire.id
    ) return false;
  } else if (
    replay.origin_app_automation_definition_id != null
    || replay.origin_app_automation_fire_id != null
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
    private readonly appAutomationsEnabled: () => boolean = () => false,
  ) {}

  /** The public worker calls this only after its ingress/Run transaction
   * commits; duplicate queue delivery may repair a missed projection. */
  async projectPendingApproval(orgId: string, runId: string): Promise<void> {
    try {
      await this.attention.projectApprovalRequested(orgId, runId);
    } catch (error) {
      console.warn('[app-runs] approval Attention projection failed:',
        error instanceof Error ? error.message : 'unknown error');
    }
  }

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
    const isAutomation = vector.schema_version === 'deft.app_action_authority.v2';
    if ((isAutomation && (!this.appAutomationsEnabled() || !context.automation_claim_token))
      || (!isAutomation && context.automation_claim_token !== undefined)) {
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }
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
      policy: isAutomation ? {
        risk_class: APP_AUTOMATION_POLICY_V1.base_host_policy.risk_class,
        review_requirement: APP_AUTOMATION_POLICY_V1.base_host_policy.review_requirement,
        review_scope: APP_AUTOMATION_POLICY_V1.review_scope,
        retry_class: APP_AUTOMATION_POLICY_V1.base_host_policy.retry_class,
      } : {
        risk_class: 'external_write',
        review_requirement: 'always',
        review_scope: 'per_invocation',
        retry_class: 'idempotent_with_key',
      },
      retention_class: isAutomation
        ? APP_AUTOMATION_POLICY_V1.base_host_policy.retention_class
        : 'standard',
      idempotency_key: isAutomation
        ? `app-automation:${vector.automation.fire.identity}`
        : `app-action:${prepared.replay_identity}`,
      input: prepared.provider_input,
      authorization_snapshot: authorizationSnapshot,
      safe_preview: app.safe_preview,
    }, null, vector, context.automation_claim_token);
  }

  /** Host-only human intake for one reviewed Runtime binding. The request
   * supplies no provider, policy, origin ancestry, approval or actor facts. */
  /** Owner-directed invocation. The binding and every authority pin are host-derived. */
  async submitReviewedNative(caller: ReviewedRuntimeCaller, request: Readonly<{
    native_binding_id: string; expected_consent_digest: string; idempotency_key: string; input: unknown;
  }>, guard?: (tx: AppRunTransaction) => Promise<void>): Promise<AppRunSafeView> {
    if (!this.appOriginEnabled() || !isAppNativeCalendarEnabled()
      || !this.appLiveAuthorization?.captureReviewedNativeInTransaction) throw new AppRunError('APP_RUN_ACCESS_DENIED');
    const submitted = await this.repository.transaction(async tx => {
      const capture = await this.appLiveAuthorization!.captureReviewedNativeInTransaction!(tx, {
        org_id: caller.org_id, user_id: caller.user_id, native_binding_id: request.native_binding_id });
      if (capture.binding.consent_digest !== request.expected_consent_digest) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      let input;
      try { input = parseNativeCalendarInput(capture.action.operation, request.input); }
      catch { throw new AppRunError('APP_RUN_INPUT_INVALID'); }
      const actor: AppRunActor = { actor_type: 'human', user_id: caller.user_id };
      const submission = this.#nativeSubmission(capture, actor, input, request.idempotency_key);
      const run = await this.#submit({ org_id: caller.org_id, initiating_actor: actor, execution_actor: actor },
        submission, null, undefined, undefined, undefined, undefined, tx, undefined, capture);
      if (!await nativeFinalAuthorityIsCurrent(tx, capture.participants, { guard, clock: this.now,
        expires_at: [run.input_expires_at, run.result_expires_at] }))
        throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      return run;
    });
    if (submitted.state === 'pending_approval') await this.attention.projectApprovalRequested(submitted.org_id, submitted.id);
    return submitted;
  }

  /** Scoped locator only; public input is captured once from the claimed revision. */
  async submitReviewedPublicNativeInTransaction(tx: AppRunTransaction, identity: Readonly<{
    org_id: string; endpoint_id: string; ingress_id: string;
  }>): Promise<AppRunSafeView> {
    if (!this.appOriginEnabled() || !isAppNativeCalendarEnabled()
      || !this.appLiveAuthorization?.captureReviewedPublicNativeInTransaction) throw new AppRunError('APP_RUN_ACCESS_DENIED');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`app-public-ingress:${identity.org_id}:${identity.ingress_id}`}, 0))`);
    try {
      // The outer public worker catches expected stale authority to commit an
      // unsupported ingress. Roll back every partial Run/capsule/approval first.
      return await tx.transaction(async nativeTx => {
        const capture = await this.appLiveAuthorization!.captureReviewedPublicNativeInTransaction!(nativeTx, { ...identity, capture_input: true });
        if (!capture.public_input) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        const actor: AppRunActor = { actor_type: 'app_public', endpoint_id: capture.endpoint.id, ingress_id: capture.ingress.id };
        const executor: AppRunActor = { actor_type: 'human', user_id: capture.binding.owner_user_id };
        const submission = this.#nativeSubmission(capture, actor, capture.public_input, `app-public-ingress:${capture.ingress.id}`);
        const run = await this.#submit({ org_id: identity.org_id, initiating_actor: actor, execution_actor: executor }, submission,
          null, undefined, undefined, undefined, undefined, nativeTx, undefined, capture);
        if (!await nativeFinalAuthorityIsCurrent(nativeTx, capture.participants, { clock: this.now,
          expires_at: [run.input_expires_at, run.result_expires_at] })) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        return run;
      });
    } catch (error) {
      // The durable public worker recognizes the established Run authority
      // errors as terminal unsupported work. Do not turn a stale native App
      // pin into an indefinitely retried accepted ingress.
      if (isAppError(error) && error.code === 'APP_STALE') throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      if (isAppError(error) && error.code === 'APP_ACCESS_DENIED') throw new AppRunError('APP_RUN_ACCESS_DENIED');
      throw error;
    }
  }

  #nativeSubmission(capture: ReviewedNativeCapture | ReviewedPublicNativeCapture, actor: AppRunActor,
    input: unknown, idempotency_key: string) {
    const { binding } = capture;
    const publicOrigin = 'endpoint' in capture ? { public_endpoint_id: capture.endpoint.id, public_ingress_id: capture.ingress.id } : {};
    return {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run, org_id: binding.org_id, initiating_actor: actor,
      execution_actor: { actor_type: 'human' as const, user_id: binding.owner_user_id },
      origin: { origin_kind: 'app' as const, installation_id: binding.app_installation_id, app_version_id: binding.app_version_id,
        grant_snapshot_id: binding.grant_snapshot_id, native_binding_id: binding.id, ...publicOrigin },
      operation: { provider: { org_id: binding.org_id, provider_kind: 'native' as const, provider_instance_id: binding.provider_instance_id },
        operation_name: binding.operation_name }, provider_snapshot_digest: capture.provider_snapshot_digest,
      policy: { risk_class: NATIVE_ACTION_HOST_POLICY.risk_class, review_requirement: NATIVE_ACTION_HOST_POLICY.review_requirement,
        review_scope: NATIVE_ACTION_HOST_POLICY.review_scope, retry_class: NATIVE_ACTION_HOST_POLICY.retry_class },
      retention_class: NATIVE_ACTION_HOST_POLICY.retention_class, idempotency_key, input,
      authorization_snapshot: capture.authorization_snapshot,
      safe_preview: AppRunSafePreviewSchema.parse({ schema_version: APP_RUN_CONTRACT_VERSIONS.run,
        title: capture.action.label, summary: 'One native Calendar action requiring owner approval.', resource_refs: [],
        fields: { provider_kind: 'native', operation_name: binding.operation_name,
          action_key: binding.action_key, native_binding_id: binding.id } }),
    };
  }

  /** The owner sees the retained exact input, never newly projected record fields. */
  async #nativeRunAuthority(tx: AppRunTransaction, caller: ReviewedRuntimeCaller, runId: string) {
    const pin = await this.repository.findRuntimeReviewPin(tx, caller.org_id, runId);
    if (!this.appOriginEnabled() || !isAppNativeCalendarEnabled()
      || !this.appLiveAuthorization?.captureReviewedNativeInTransaction || !pin?.origin_native_binding_id
      || pin.provider_kind !== 'native' || pin.origin_kind !== 'app' || pin.execution_actor_type !== 'human'
      || pin.execution_actor_id !== caller.user_id) throw new AppRunError('APP_RUN_ACCESS_DENIED');
    const current = pin.origin_public_endpoint_id && pin.origin_public_ingress_id
      ? await this.appLiveAuthorization.captureReviewedPublicNativeInTransaction!(tx, { org_id: caller.org_id,
        endpoint_id: pin.origin_public_endpoint_id, ingress_id: pin.origin_public_ingress_id })
      : await this.appLiveAuthorization.captureReviewedNativeInTransaction(tx, { org_id: caller.org_id,
        user_id: caller.user_id, native_binding_id: pin.origin_native_binding_id });
    let snapshotMatches = false;
    try { snapshotMatches = canonicalAuthorization(current.authorization_snapshot)
      === canonicalAuthorization(AppRunAuthorizationSnapshotSchema.parse(pin.authorization_snapshot)); } catch { /* fail closed */ }
    if (current.binding.id !== pin.origin_native_binding_id || current.binding.owner_user_id !== caller.user_id
      || current.binding.app_installation_id !== pin.origin_app_installation_id || current.binding.app_version_id !== pin.origin_app_version_id
      || current.binding.grant_snapshot_id !== pin.origin_app_grant_snapshot_id || current.binding.provider_snapshot_id !== pin.provider_snapshot_id
      || current.binding.operation_name !== pin.operation_name || current.binding.provider_instance_id !== pin.provider_instance_id
      || !snapshotMatches) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    return current;
  }

  async reviewNativeInput(caller: ReviewedRuntimeCaller, runId: string, guard?: (tx: AppRunTransaction) => Promise<void>) {
    if (!this.appOriginEnabled() || !isAppNativeCalendarEnabled()
      || !this.appLiveAuthorization?.captureReviewedNativeInTransaction) throw new AppRunError('APP_RUN_ACCESS_DENIED');
    return this.repository.transaction(async tx => {
      const run = await this.repository.lockRun(tx, caller.org_id, runId);
      const pin = await this.repository.findRuntimeReviewPin(tx, caller.org_id, runId);
      if (!run || !pin || run.provider_kind !== 'native' || run.origin_kind !== 'app'
        || run.execution_actor_type !== 'human' || run.execution_actor_id !== caller.user_id
        || run.state !== 'pending_approval' || run.input_expires_at <= this.now() || !pin.origin_native_binding_id)
        throw new AppRunError('APP_RUN_ACCESS_DENIED');
      const current = await this.#nativeRunAuthority(tx, caller, runId);
      if (!await this.repository.hasPendingRuntimeApproval(tx, caller.org_id, runId, caller.user_id)) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const input = parseNativeCalendarInput(current.action.operation, await this.secretRepository.readInput(caller.org_id, runId, tx));
      if (!await nativeFinalAuthorityIsCurrent(tx, current.participants, { guard, clock: this.now,
        expires_at: [run.input_expires_at] })) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      return { schema_version: 'deft.app_native_run_review.v1' as const, run_id: runId,
        operation_name: current.action.operation, owner_user_id: caller.user_id, action_label: current.action.label,
        native_binding_id: current.binding.id, consent_digest: current.binding.consent_digest,
        host_policy: NATIVE_ACTION_HOST_POLICY, input };
    });
  }

  /** Native delivery keeps current authority locked through the bounded output
   * read and final exact web SID fence. Other providers retain their old path. */
  async resultReviewedNative(caller: ReviewedRuntimeCaller, runId: string, guard?: (tx: AppRunTransaction) => Promise<void>) {
    return this.repository.transaction(async tx => {
      const run = await this.repository.lockRun(tx, caller.org_id, runId);
      if (!run || run.provider_kind !== 'native' || run.execution_actor_type !== 'human'
        || run.execution_actor_id !== caller.user_id) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      const current = await this.#nativeRunAuthority(tx, caller, runId);
      if (run.result_purged_at || run.result_expires_at <= this.now()) throw new AppRunError('APP_RUN_RESULT_EXPIRED');
      const attemptId = await this.repository.latestRetainedAttemptId(caller.org_id, runId, tx);
      if (!attemptId) throw new AppRunError('APP_RUN_RESULT_EXPIRED');
      const value = await this.secretRepository.readOutput(caller.org_id, runId, attemptId, tx);
      if (value === null) throw new AppRunError('APP_RUN_RESULT_EXPIRED');
      const envelope = AppRunRetainedProviderResultSchema.parse(value);
      assertAppRunOutputWithinBudget(envelope);
      parseNativeCalendarResult(current.action.operation, envelope.output);
      if (!await nativeFinalAuthorityIsCurrent(tx, current.participants, { guard, clock: this.now,
        expires_at: [run.result_expires_at] })) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      return Object.freeze({ run, value });
    });
  }

  async submitReviewedRuntime(
    caller: ReviewedRuntimeCaller,
    request: ReviewedRuntimeInvoke,
    hostAdmission?: (tx: AppRunTransaction) => Promise<void>,
  ): Promise<AppRunSafeView> {
    if (!this.appOriginEnabled() || !appRuntimeChannelEnabled()
      || !this.appLiveAuthorization?.captureReviewedRuntimeForPreparation
      || !this.appLiveAuthorization.captureReviewedRuntimeInTransaction) {
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }
    let capture: ReviewedRuntimeCapture;
    try {
      capture = await this.appLiveAuthorization.captureReviewedRuntimeForPreparation({
        org_id: caller.org_id, user_id: caller.user_id,
        runtime_binding_id: request.runtime_binding_id,
      });
    } catch {
      throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }
    const binding = capture.binding;
    if (binding.id !== request.runtime_binding_id || binding.org_id !== caller.org_id
      || binding.provider_kind !== 'app_runtime'
      || binding.action_key !== capture.action.action_key
      || binding.operation_name !== capture.action.action_key
      || binding.risk_class !== 'external_write'
      || binding.review_requirement !== 'always'
      || binding.retry_class !== 'unsafe_or_unknown'
      || binding.retention_class !== 'standard') {
      throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }
    let input: Record<string, string | number | boolean>;
    try {
      input = parseRuntimeObjectInput(RuntimeObjectSchema.parse(capture.action.input_schema), request.input);
    } catch {
      throw new AppRunError('APP_RUN_INPUT_INVALID');
    }
    const actor: AppRunActor = { actor_type: 'human', user_id: caller.user_id };
    const submission = {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      org_id: caller.org_id,
      initiating_actor: actor,
      execution_actor: actor,
      origin: {
        origin_kind: 'app' as const,
        installation_id: binding.app_installation_id,
        app_version_id: binding.app_version_id,
        grant_snapshot_id: binding.grant_snapshot_id,
        runtime_binding_id: binding.id,
      },
      operation: {
        provider: {
          org_id: caller.org_id,
          provider_kind: 'app_runtime' as const,
          provider_instance_id: binding.provider_instance_id,
        },
        operation_name: binding.operation_name,
      },
      provider_snapshot_digest: capture.provider_snapshot_digest,
      policy: {
        risk_class: binding.risk_class,
        review_requirement: binding.review_requirement,
        review_scope: 'per_invocation' as const,
        retry_class: binding.retry_class,
      },
      retention_class: binding.retention_class,
      idempotency_key: request.idempotency_key,
      input,
      authorization_snapshot: capture.authorization_snapshot,
      safe_preview: AppRunSafePreviewSchema.parse({
        schema_version: APP_RUN_CONTRACT_VERSIONS.run,
        title: binding.action_key,
        summary: 'One reviewed Runtime action requiring human approval.',
        resource_refs: [],
        fields: { app_installation_id: binding.app_installation_id,
          action_key: binding.action_key, runtime_binding_id: binding.id,
          provider_kind: 'app_runtime' },
      }),
    };
    return this.#submit({ org_id: caller.org_id, initiating_actor: actor,
      execution_actor: actor }, submission, null, undefined, undefined, capture,
      undefined, undefined, hostAdmission);
  }

  /** Only the validated public-ingress worker calls this inside the ingress
   * transaction. No caller-supplied actor, action, policy, or input is used. */
  async submitReviewedPublicRuntimeInTransaction(tx: AppRunTransaction, identity: Readonly<{
    org_id: string; endpoint_id: string; ingress_id: string;
  }>): Promise<AppRunSafeView> {
    if (!this.appOriginEnabled() || !appRuntimeChannelEnabled()
      || !this.appLiveAuthorization?.captureReviewedPublicRuntimeInTransaction) {
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }
    // Serialize duplicate queue deliveries before any share lock is taken on
    // the ingress. Otherwise two readers can deadlock when the winner upgrades
    // its ingress lock after the Run insert while the loser waits on #submit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`app-public-ingress:${identity.org_id}:${identity.ingress_id}`}, 0))`);
    let capture: ReviewedPublicRuntimeCapture;
    try {
      capture = await this.appLiveAuthorization.captureReviewedPublicRuntimeInTransaction(tx, identity);
    } catch {
      throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }
    const { binding, endpoint, ingress, claim } = capture;
    if (binding.risk_class !== 'external_write' || binding.review_requirement !== 'always'
      || binding.retry_class !== 'unsafe_or_unknown' || binding.retention_class !== 'standard'
      || capture.action.host_policy.review_scope !== 'per_invocation'
      || endpoint.approver_user_id === null || endpoint.id !== identity.endpoint_id
      || ingress.id !== identity.ingress_id || claim.ingress_id !== ingress.id) {
      throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }
    const initiator: AppRunActor = { actor_type: 'app_public', endpoint_id: endpoint.id,
      ingress_id: ingress.id };
    const executor: AppRunActor = { actor_type: 'human', user_id: endpoint.approver_user_id };
    const submission = {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      org_id: identity.org_id,
      initiating_actor: initiator,
      execution_actor: executor,
      origin: { origin_kind: 'app' as const,
        installation_id: binding.app_installation_id,
        app_version_id: binding.app_version_id,
        grant_snapshot_id: binding.grant_snapshot_id,
        runtime_binding_id: binding.id,
        public_endpoint_id: endpoint.id,
        public_ingress_id: ingress.id },
      operation: { provider: { org_id: identity.org_id,
        provider_kind: 'app_runtime' as const,
        provider_instance_id: binding.provider_instance_id },
      operation_name: binding.operation_name },
      provider_snapshot_digest: capture.provider_snapshot_digest,
      policy: { risk_class: binding.risk_class, review_requirement: binding.review_requirement,
        review_scope: 'per_invocation' as const, retry_class: binding.retry_class },
      retention_class: binding.retention_class,
      idempotency_key: `app-public-ingress:${ingress.id}`,
      input: capture.public_input,
      authorization_snapshot: capture.authorization_snapshot,
      safe_preview: AppRunSafePreviewSchema.parse({
        schema_version: APP_RUN_CONTRACT_VERSIONS.run,
        title: capture.action.action_key,
        summary: 'Public claim awaiting one human approval.',
        resource_refs: [{ resource_kind: claim.resource_type, resource_id: claim.resource_id }],
        fields: { provider_kind: 'app_runtime', app_installation_id: binding.app_installation_id,
          runtime_binding_id: binding.id, public_endpoint_id: endpoint.id,
          public_claim_id: claim.id },
      }),
    };
    return this.#submit({ org_id: identity.org_id, initiating_actor: initiator,
      execution_actor: executor }, submission, null, undefined, undefined, undefined,
      capture, tx);
  }

  /** Transient approval review: disclose exact retained input only to the
   * initiating human while the reviewed binding and pending approval remain
   * live. Nothing plaintext is copied into a card, event, or receipt. */
  async reviewRuntimeInput(caller: ReviewedRuntimeCaller, runId: string) {
    if (!this.appOriginEnabled() || !appRuntimeChannelEnabled()
      || !this.appLiveAuthorization?.captureReviewedRuntimeInTransaction) {
      throw new AppRunError('APP_RUNS_DISABLED');
    }
    return this.repository.transaction(async (tx) => {
      const locator = await this.repository.findRuntimeReviewPin(tx, caller.org_id, runId);
      if (locator?.initiating_actor_type === 'app_public') {
        return this.#reviewPublicRuntimeInput(tx, caller, runId, locator);
      }
      if (!locator || locator.initiating_actor_type !== 'human'
        || locator.initiating_actor_id !== caller.user_id
        || locator.org_id !== caller.org_id
        || locator.origin_kind !== 'app' || locator.provider_kind !== 'app_runtime'
        || !locator.origin_runtime_binding_id) {
        throw new AppRunError('APP_RUN_ACCESS_DENIED');
      }
      // Match approval's Run-before-Runtime-authority order. A completed Run
      // stops here so a channel call cannot hold authority while waiting on
      // this review's Run lock. Manager revocation never takes the Run lock.
      const locked = await this.repository.lockRun(tx, caller.org_id, runId);
      const pin = await this.repository.findRuntimeReviewPin(tx, caller.org_id, runId);
      if (!locked || !pin || pin.state !== 'pending_approval'
        || pin.initiating_actor_type !== 'human'
        || pin.initiating_actor_id !== caller.user_id
        || pin.origin_runtime_binding_id !== locator.origin_runtime_binding_id
        || pin.input_expires_at <= this.now()) {
        throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      }
      let current: ReviewedRuntimeCapture;
      try {
        current = await this.appLiveAuthorization!.captureReviewedRuntimeInTransaction!(tx, {
          org_id: caller.org_id, user_id: caller.user_id,
          runtime_binding_id: locator.origin_runtime_binding_id,
        });
      } catch {
        throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      }
      let authorityMatches = false;
      try {
        authorityMatches = pin !== null && canonicalAuthorization(
          AppRunAuthorizationSnapshotSchema.parse(pin.authorization_snapshot),
        ) === canonicalAuthorization(current.authorization_snapshot);
      } catch { /* Corrupt or obsolete authority never discloses input. */ }
      if (!locked || !pin || pin.state !== 'pending_approval'
        || pin.input_expires_at <= this.now()
        || pin.origin_kind !== 'app' || pin.provider_kind !== 'app_runtime'
        || pin.initiating_actor_type !== 'human' || pin.initiating_actor_id !== caller.user_id
        || pin.execution_actor_type !== 'human' || pin.execution_actor_id !== caller.user_id
        || pin.origin_runtime_binding_id !== locator.origin_runtime_binding_id
        || pin.origin_app_installation_id !== current.binding.app_installation_id
        || pin.origin_app_version_id !== current.binding.app_version_id
        || pin.origin_app_grant_snapshot_id !== current.binding.grant_snapshot_id
        || pin.origin_app_binding_key !== null
        || pin.origin_app_automation_definition_id !== null
        || pin.origin_app_automation_fire_id !== null
        || pin.provider_instance_id !== current.binding.provider_instance_id
        || pin.provider_snapshot_id !== current.binding.provider_snapshot_id
        || pin.operation_name !== current.binding.operation_name
        || pin.risk_class !== current.binding.risk_class
        || pin.review_requirement !== current.binding.review_requirement
        || pin.review_scope !== current.action.host_policy.review_scope
        || pin.retry_class !== current.binding.retry_class
        || pin.retention_class !== current.binding.retention_class
        || !authorityMatches
        || !await this.repository.hasPendingRuntimeApproval(tx, caller.org_id, runId, caller.user_id)) {
        throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      }
      let input: Record<string, string | number | boolean>;
      try {
        const retained = await this.secretRepository.readInput(caller.org_id, runId, tx);
        input = parseRuntimeObjectInput(RuntimeObjectSchema.parse(current.action.input_schema), retained);
      } catch {
        throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      }
      return Object.freeze({ run_id: runId,
        action_key: current.action.action_key,
        app_installation_id: current.binding.app_installation_id,
        app_version_id: current.binding.app_version_id,
        grant_snapshot_id: current.binding.grant_snapshot_id,
        runtime_binding_id: current.binding.id,
        contract_digest: current.action.contract_digest,
        policy: Object.freeze({ risk_class: current.binding.risk_class,
          review_requirement: current.binding.review_requirement,
          review_scope: current.action.host_policy.review_scope,
          retry_class: current.binding.retry_class }),
        input });
    });
  }

  async #reviewPublicRuntimeInput(tx: AppRunTransaction, caller: ReviewedRuntimeCaller,
    runId: string, locator: NonNullable<Awaited<ReturnType<PostgresAppRunRepository['findRuntimeReviewPin']>>>) {
    if (!this.appLiveAuthorization?.captureReviewedPublicRuntimeInTransaction
      || locator.execution_actor_type !== 'human'
      || locator.execution_actor_id !== caller.user_id
      || locator.origin_kind !== 'app' || locator.provider_kind !== 'app_runtime'
      || !locator.origin_public_endpoint_id || !locator.origin_public_ingress_id
      || locator.initiating_actor_id !== locator.origin_public_ingress_id) {
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }
    const locked = await this.repository.lockRun(tx, caller.org_id, runId);
    const pin = await this.repository.findRuntimeReviewPin(tx, caller.org_id, runId);
    if (!locked || !pin || pin.state !== 'pending_approval'
      || pin.input_expires_at <= this.now()
      || pin.origin_public_endpoint_id !== locator.origin_public_endpoint_id
      || pin.origin_public_ingress_id !== locator.origin_public_ingress_id
      || pin.execution_actor_type !== 'human' || pin.execution_actor_id !== caller.user_id) {
      throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }
    let current: ReviewedPublicRuntimeCapture;
    try {
      current = await this.appLiveAuthorization.captureReviewedPublicRuntimeInTransaction(tx, {
        org_id: caller.org_id, endpoint_id: locator.origin_public_endpoint_id,
        ingress_id: locator.origin_public_ingress_id,
      });
    } catch {
      throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }
    let authorityMatches = false;
    try {
      authorityMatches = canonicalAuthorization(AppRunAuthorizationSnapshotSchema.parse(pin.authorization_snapshot))
        === canonicalAuthorization(current.authorization_snapshot);
    } catch { /* Invalid retained authority cannot disclose input. */ }
    if (pin.input_expires_at <= this.now() || pin.state !== 'pending_approval'
      || pin.initiating_actor_type !== 'app_public'
      || pin.initiating_actor_id !== current.ingress.id
      || pin.execution_actor_id !== current.endpoint.approver_user_id
      || pin.origin_runtime_binding_id !== current.binding.id
      || pin.origin_app_installation_id !== current.binding.app_installation_id
      || pin.origin_app_version_id !== current.binding.app_version_id
      || pin.origin_app_grant_snapshot_id !== current.binding.grant_snapshot_id
      || pin.provider_instance_id !== current.binding.provider_instance_id
      || pin.provider_snapshot_id !== current.binding.provider_snapshot_id
      || pin.operation_name !== current.binding.operation_name
      || pin.risk_class !== current.binding.risk_class
      || pin.review_requirement !== current.binding.review_requirement
      || pin.review_scope !== current.action.host_policy.review_scope
      || pin.retry_class !== current.binding.retry_class
      || pin.retention_class !== current.binding.retention_class
      || !authorityMatches
      || !await this.repository.hasPendingRuntimeApproval(tx, caller.org_id, runId, caller.user_id)) {
      throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }
    let reviewedInput: Record<string, string | number | boolean>;
    try {
      const retained = await this.secretRepository.readInput(caller.org_id, runId, tx);
      reviewedInput = parseRuntimeObjectInput(RuntimeObjectSchema.parse(current.action.input_schema), retained);
      if (canonicalCapabilityJson(reviewedInput) !== canonicalCapabilityJson(current.public_input)) {
        throw new Error('Public input differs from canonical claim');
      }
    } catch {
      throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }
    return Object.freeze({ run_id: runId, action_key: current.action.action_key,
      app_installation_id: current.binding.app_installation_id,
      app_version_id: current.binding.app_version_id,
      grant_snapshot_id: current.binding.grant_snapshot_id,
      runtime_binding_id: current.binding.id,
      contract_digest: current.action.contract_digest,
      policy: Object.freeze({ risk_class: current.binding.risk_class,
        review_requirement: current.binding.review_requirement,
        review_scope: current.action.host_policy.review_scope,
        retry_class: current.binding.retry_class }),
      input: reviewedInput });
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
    automationClaimToken?: string,
    trustedRuntimeCapture?: ReviewedRuntimeCapture,
    trustedPublicCapture?: ReviewedPublicRuntimeCapture,
    existingTx?: AppRunTransaction,
    hostAdmission?: (tx: AppRunTransaction) => Promise<void>,
    trustedNativeCapture?: ReviewedNativeCapture | ReviewedPublicNativeCapture,
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
      || (submission.origin.origin_kind === 'app' && !trustedAppVector && !trustedRuntimeCapture && !trustedPublicCapture && !trustedNativeCapture)
      || (submission.origin.origin_kind !== 'app'
        && (trustedAppVector !== undefined || trustedRuntimeCapture !== undefined || trustedPublicCapture !== undefined || trustedNativeCapture !== undefined))
      || [trustedAppVector, trustedRuntimeCapture, trustedPublicCapture, trustedNativeCapture].filter(Boolean).length > 1
      || (submission.origin.origin_kind === 'app' && 'runtime_binding_id' in submission.origin
        && !trustedRuntimeCapture && !trustedPublicCapture)
      || (submission.origin.origin_kind === 'app' && 'binding_key' in submission.origin
        && !trustedAppVector)
      || (submission.origin.origin_kind === 'app' && 'public_endpoint_id' in submission.origin
        && !trustedPublicCapture && !(trustedNativeCapture && 'endpoint' in trustedNativeCapture))
      || (submission.origin.origin_kind === 'app' && 'native_binding_id' in submission.origin && !trustedNativeCapture)
      || (trustedNativeCapture !== undefined && (submission.origin.origin_kind !== 'app' || !('native_binding_id' in submission.origin)))
      || (trustedPublicCapture !== undefined && (submission.origin.origin_kind !== 'app'
        || !('public_endpoint_id' in submission.origin)
        || submission.initiating_actor.actor_type !== 'app_public'
        || submission.execution_actor.actor_type !== 'human'))
      || (!trustedAppVector && !trustedRuntimeCapture && !trustedPublicCapture && !trustedNativeCapture && submission.authorization_snapshot.authority_refs.some(
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

    const submitInTransaction = async (tx: AppRunTransaction) => {
      await this.repository.acquireSubmissionLock(tx, lock);
      if (hostAdmission) await hostAdmission(tx);
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
      if (trustedRuntimeCapture) {
        if (!this.appLiveAuthorization?.captureReviewedRuntimeInTransaction
          || submission.origin.origin_kind !== 'app'
          || !('runtime_binding_id' in submission.origin)
          || submission.initiating_actor.actor_type !== 'human'
          || submission.execution_actor.actor_type !== 'human') {
          throw new AppRunError('APP_RUN_ACCESS_DENIED');
        }
        let live: ReviewedRuntimeCapture;
        try {
          live = await this.appLiveAuthorization.captureReviewedRuntimeInTransaction(tx, {
            org_id: submission.org_id,
            user_id: submission.initiating_actor.user_id,
            runtime_binding_id: submission.origin.runtime_binding_id,
          });
        } catch {
          throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        }
        const binding = live.binding;
        let inputMatches = false;
        try {
          inputMatches = canonicalCapabilityJson(parseRuntimeObjectInput(
            RuntimeObjectSchema.parse(live.action.input_schema), submission.input,
          )) === canonicalCapabilityJson(submission.input);
        } catch { /* A reviewed contract changed or the input is no longer valid. */ }
        if (runtimeCaptureIdentity(live) !== runtimeCaptureIdentity(trustedRuntimeCapture)
          || canonicalAuthorization(live.authorization_snapshot)
            !== canonicalAuthorization(submission.authorization_snapshot)
          || binding.id !== submission.origin.runtime_binding_id
          || binding.org_id !== submission.org_id
          || binding.app_installation_id !== submission.origin.installation_id
          || binding.app_version_id !== submission.origin.app_version_id
          || binding.grant_snapshot_id !== submission.origin.grant_snapshot_id
          || binding.provider_kind !== submission.operation.provider.provider_kind
          || binding.provider_instance_id !== submission.operation.provider.provider_instance_id
          || binding.operation_name !== submission.operation.operation_name
          || live.provider_snapshot_digest !== submission.provider_snapshot_digest
          || binding.risk_class !== submission.policy.risk_class
          || binding.review_requirement !== submission.policy.review_requirement
          || live.action.host_policy.review_scope !== submission.policy.review_scope
          || binding.retry_class !== submission.policy.retry_class
          || binding.retention_class !== submission.retention_class
          || !inputMatches) {
          throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        }
      }
      if (trustedPublicCapture) {
        if (!this.appLiveAuthorization?.captureReviewedPublicRuntimeInTransaction
          || submission.origin.origin_kind !== 'app'
          || !('public_endpoint_id' in submission.origin)
          || !('public_ingress_id' in submission.origin)
          || !('runtime_binding_id' in submission.origin)
          || submission.initiating_actor.actor_type !== 'app_public'
          || submission.execution_actor.actor_type !== 'human') {
          throw new AppRunError('APP_RUN_ACCESS_DENIED');
        }
        let live: ReviewedPublicRuntimeCapture;
        try {
          live = await this.appLiveAuthorization.captureReviewedPublicRuntimeInTransaction(tx, {
            org_id: submission.org_id,
            endpoint_id: submission.origin.public_endpoint_id,
            ingress_id: submission.origin.public_ingress_id,
          });
        } catch {
          throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        }
        const binding = live.binding;
        const matchingInput = canonicalCapabilityJson(live.public_input)
          === canonicalCapabilityJson(submission.input);
        if (canonicalAuthorization(live.authorization_snapshot)
          !== canonicalAuthorization(submission.authorization_snapshot)
          || runtimeCaptureIdentity(live) !== runtimeCaptureIdentity(trustedPublicCapture)
          || live.endpoint.approver_user_id !== submission.execution_actor.user_id
          || live.endpoint.id !== submission.initiating_actor.endpoint_id
          || live.ingress.id !== submission.initiating_actor.ingress_id
          || binding.id !== submission.origin.runtime_binding_id
          || binding.app_installation_id !== submission.origin.installation_id
          || binding.app_version_id !== submission.origin.app_version_id
          || binding.grant_snapshot_id !== submission.origin.grant_snapshot_id
          || binding.provider_instance_id !== submission.operation.provider.provider_instance_id
          || binding.operation_name !== submission.operation.operation_name
          || live.provider_snapshot_digest !== submission.provider_snapshot_digest
          || !matchingInput) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      }
      if (trustedNativeCapture) {
        if (submission.origin.origin_kind !== 'app' || !('native_binding_id' in submission.origin)
          || submission.execution_actor.actor_type !== 'human') throw new AppRunError('APP_RUN_ACCESS_DENIED');
        const live = 'endpoint' in trustedNativeCapture
          ? await this.appLiveAuthorization!.captureReviewedPublicNativeInTransaction!(tx, {
            org_id: submission.org_id, endpoint_id: trustedNativeCapture.endpoint.id,
            ingress_id: trustedNativeCapture.ingress.id })
          : await this.appLiveAuthorization!.captureReviewedNativeInTransaction!(tx, {
            org_id: submission.org_id, user_id: submission.execution_actor.user_id,
            native_binding_id: submission.origin.native_binding_id });
        const binding = live.binding;
        let validInput = false;
        try { validInput = canonicalCapabilityJson(parseNativeCalendarInput(live.action.operation, submission.input))
          === canonicalCapabilityJson(submission.input); } catch { /* Deny changed contract or malformed input. */ }
        if (!isAppNativeCalendarEnabled() || canonicalAuthorization(live.authorization_snapshot) !== canonicalAuthorization(submission.authorization_snapshot)
          || binding.id !== submission.origin.native_binding_id || binding.owner_user_id !== submission.execution_actor.user_id
          || binding.app_installation_id !== submission.origin.installation_id || binding.app_version_id !== submission.origin.app_version_id
          || binding.grant_snapshot_id !== submission.origin.grant_snapshot_id || binding.provider_instance_id !== submission.operation.provider.provider_instance_id
          || binding.operation_name !== submission.operation.operation_name || live.provider_snapshot_digest !== submission.provider_snapshot_digest
          || canonicalCapabilityJson(submission.policy) !== canonicalCapabilityJson({ risk_class: 'internal_write', review_requirement: 'always',
            review_scope: 'per_invocation', retry_class: 'idempotent_with_key' }) || submission.retention_class !== 'standard'
          || !validInput) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
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
          || !appRunReplayAuthorityMatches(replay, submission, trustedAppVector)
        ) {
          throw new AppRunError('APP_RUN_IDEMPOTENCY_CONFLICT');
        }
        const {
          input_fingerprint: _fingerprint,
          input_fingerprint_key_version: _version,
          origin_app_installation_id: _installation,
          origin_app_version_id: _appVersion,
          origin_app_binding_key: _binding,
          origin_runtime_binding_id: _runtimeBinding,
          origin_native_binding_id: _nativeBinding,
          origin_public_endpoint_id: _publicEndpoint,
          origin_public_ingress_id: _publicIngress,
          origin_app_grant_snapshot_id: _grant,
          origin_app_automation_definition_id: _automationDefinition,
          origin_app_automation_fire_id: _automationFire,
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
        attempt_limit: trustedNativeCapture ? 1 : lineage
          ? Math.min(APP_RUN_DEFAULT_ATTEMPT_LIMIT, lineage.parent.attempt_limit)
          : APP_RUN_DEFAULT_ATTEMPT_LIMIT,
        lineage: lineageInsert,
        automation_lineage: trustedAppVector?.schema_version === 'deft.app_action_authority.v2'
          ? {
              definition_id: trustedAppVector.automation.definition.id,
              fire_id: trustedAppVector.automation.fire.id,
            }
          : undefined,
        now,
      });
      if (trustedAppVector?.schema_version === 'deft.app_action_authority.v2') {
        const bound = await bindAppAutomationFireRunWithExecutor(tx, {
          organization_id: submission.org_id,
          definition_id: trustedAppVector.automation.definition.id,
          fire_id: trustedAppVector.automation.fire.id,
          expected_epoch: trustedAppVector.automation.definition.epoch,
          expected_claim_token: automationClaimToken!,
          app_run_id: run.id,
          terminal_at: now,
        });
        if (!bound) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      }
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
    };
    const submitted = existingTx ? await submitInTransaction(existingTx)
      : await this.repository.transaction(submitInTransaction);
    if (!existingTx && submitted.state === 'pending_approval') {
      try {
        await this.attention.projectApprovalRequested(submitted.org_id, submitted.id);
      } catch (error) {
        console.warn('[app-runs] approval Attention projection failed:',
          error instanceof Error ? error.message : 'unknown error');
      }
    }
    return submitted;
  }

  async inspect(
    orgId: string,
    runId: string,
    actor: AppRunActor,
    requiredAuthorityRef: AppRunReadAuthorityRef | null,
  ): Promise<AppRunSafeView> {
    const run = await this.requiredRun(orgId, runId);
    await this.assertAuthorized('inspect', orgId, actor, run, requiredAuthorityRef);
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

  async result(
    orgId: string,
    runId: string,
    actor: AppRunActor,
    requiredAuthorityRef: AppRunReadAuthorityRef | null,
  ): Promise<Readonly<{
    run: AppRunSafeView;
    value: unknown;
  }>> {
    const run = await this.requiredRun(orgId, runId);
    await this.assertAuthorized('result', orgId, actor, run, requiredAuthorityRef);
    if (run.provider_kind === 'native') {
      // Generic action/agent callers can map to a human identity but have no
      // exact live web SID. Native output uses the explicit guarded entry.
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }
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
    requiredAuthorityRef: AppRunReadAuthorityRef | null = null,
  ): Promise<void> {
    if (!await this.authorizer.authorize({
      action,
      org_id: orgId,
      actor,
      run,
      required_authority_ref: requiredAuthorityRef,
    })) {
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }
  }
}
