import { APP_RESOURCE_SYNC_CHANNEL_VERSION_V3, SyncRequestV2Schema } from '@deft/app-kit';
import { loadLiveAttachmentSyncAuthority, loadLiveAttachmentSyncBindingAuthority,
  type LiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import { buildAttachmentSyncAuthorizationSnapshot } from './app-attachment-sync-run.js';
import { parseAttachmentSyncResult, type AttachmentSyncResultRequest } from './app-attachment-sync-contract.js';
import { attachmentFinalAuthorityIsCurrent } from './app-attachment-authority.js';
import { isAppAttachmentBrokerEnabled } from './env.js';
import { nativeExecutionTransaction } from './app-native-execution-db.js';
import { executeNativeCalendarInTransaction } from './app-native-calendar-executor.js';
import { captureReviewedNativeInTransaction, captureReviewedPublicNativeInTransaction } from './app-native-run-authorization.js';
import { isAppNativeCalendarEnabled } from './env.js';
import { nativeFinalAuthorityIsCurrent } from './app-native-final-authority.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { appRunAttempts, appRuns, appRuntimeSessions, appSyncCheckpoints, appSyncIntents } from '@deft/db/schema';
import { parseRuntimeObjectInput } from '@deft/app-kit';
import { parseSyncRequest } from '@deft/app-kit/experimental/resource-sync';
import {
  APP_RUN_CONTRACT_VERSIONS,
  AppRunRetainedProviderResultSchema,
  AppRunSafeOutcomeSchema,
  assertAppRunOutputWithinBudget,
  canonicalCapabilityJson,
  classifyAppRunCrashRecovery,
  type AppRunSafeOutcome,
} from '@deft/shared';
import { db } from './db.js';
import { isAppResourceSyncChannelEnabled } from './env.js';
import {
  denyAllAppRunExecutionAuthorizer,
  type AppRunExecutionAuthorizer,
} from './app-run-authorization.js';
import { AppRunError } from './app-run-errors.js';
import type { AppRunProviderExecutor, AppRunProviderExecutionResult } from './app-run-provider-executor.js';
import {
  PostgresAppRunRepository,
  type AppRunProviderDispatchPin,
  type AppRunSafeView,
  type AppRunTransaction,
  safeRunSelection,
} from './app-run-repository.js';
import {
  noOpAppRunReceiptWriter,
  type AppRunReceiptWriter,
} from './app-run-receipts.js';
import {
  noOpAppRunAttentionProjector,
  type AppRunAttentionProjector,
} from './app-run-attention.js';
import { AppRunSecretRepository } from './app-run-secret-repository.js';
import type { AppRunSecretService } from './app-run-secrets.js';
import { loadLiveRuntimeAuthority, runtimeRunMatchesAuthority } from './app-runtime-authority.js';
import {
  loadLiveResourceSyncAuthority, loadLiveResourceSyncBindingAuthority,
  type LiveResourceSyncAuthority, type LiveResourceSyncBindingAuthority,
} from './app-resource-sync-authority.js';
import { buildResourceSyncAuthorizationSnapshot } from './app-resource-sync-authorization.js';
import { AppResourceSyncStore } from './app-resource-sync-store.js';
import { parseAppResourceSyncResult, APP_RESOURCE_SYNC_AUDIENCE,
  APP_RESOURCE_SYNC_CHANNEL_VERSION } from './app-resource-sync-contract.js';
import type { ResourceSyncResultRequest } from '@deft/app-kit/experimental/resource-sync';
import {
  APP_RUNTIME_CHANNEL_VERSION, type AppRuntimeClaimEnvelope,
  type AppRuntimeResultRequest, type AppRuntimeStartEnvelope,
} from './app-runtime-contract.js';
import {
  noOpAppRunAttemptQueue,
  type AppRunAttemptQueue,
  type AppRunAttemptScheduler,
} from './app-run-scheduler.js';

type ClaimedAttempt = Readonly<{
  run: AppRunSafeView;
  attempt: typeof appRunAttempts.$inferSelect;
}>;

export type AppRunRecoveryOptions = Readonly<{
  transaction?: <T>(work: (tx: AppRunTransaction) => Promise<T>) => Promise<T>;
  /** A durable projection replaces the normal post-commit Attention call. */
  onRecovered?: (tx: AppRunTransaction, run: AppRunSafeView) => Promise<void>;
}>;

export type AppRunImmediateExecution = Readonly<{
  run: AppRunSafeView;
  provider_result?: AppRunProviderExecutionResult;
}>;

export function appRunProviderIdempotencyKey(runId: string): string {
  const digest = createHash('sha256')
    .update('deft.app_run.provider_idempotency.v1\0')
    .update(runId)
    .digest('base64url');
  // The frozen provider interface requires an alphanumeric first character.
  // Preserve every already-valid v1 key byte-for-byte and distinguish the
  // corrected form by length only when base64url begins with "-" or "_".
  return /^[A-Za-z0-9]/.test(digest) ? digest : `d${digest}`;
}

function boundedLeaseMs(value: number): number {
  return Math.max(1_000, Math.min(value, 15 * 60_000));
}

export class AppRunAttemptRunner implements AppRunAttemptScheduler {
  constructor(
    private readonly repository: PostgresAppRunRepository,
    private readonly secretRepository: AppRunSecretRepository,
    private readonly secrets: AppRunSecretService,
    private readonly executor: AppRunProviderExecutor,
    private readonly executionAuthorizer: AppRunExecutionAuthorizer = denyAllAppRunExecutionAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = 60_000,
    private readonly heartbeatIntervalMs = Math.max(250, Math.floor(boundedLeaseMs(leaseMs) / 3)),
    private readonly receiptWriter: AppRunReceiptWriter = noOpAppRunReceiptWriter,
    private readonly attention: AppRunAttentionProjector = noOpAppRunAttentionProjector,
    private readonly attemptQueue: AppRunAttemptQueue = noOpAppRunAttemptQueue,
    private readonly resourceSyncStore: AppResourceSyncStore | null = null,
    private readonly syncMode: 'resource_v2' | 'attachment_v3' = 'resource_v2',
  ) {}

  get #syncVersion() { return this.syncMode === 'attachment_v3' ? APP_RESOURCE_SYNC_CHANNEL_VERSION_V3 : APP_RESOURCE_SYNC_CHANNEL_VERSION; }
  #syncEnabled() { return this.syncMode === 'attachment_v3' ? isAppAttachmentBrokerEnabled() : isAppResourceSyncChannelEnabled(); }
  #loadSyncAuthority(tx: AppRunTransaction,input:Parameters<typeof loadLiveResourceSyncAuthority>[1]) {
    return this.syncMode === 'attachment_v3' ? loadLiveAttachmentSyncAuthority(tx,input) : loadLiveResourceSyncAuthority(tx,input);
  }
  #loadSyncBinding(tx: AppRunTransaction,input:Parameters<typeof loadLiveResourceSyncBindingAuthority>[1]) {
    return this.syncMode === 'attachment_v3' ? loadLiveAttachmentSyncBindingAuthority(tx,input) : loadLiveResourceSyncBindingAuthority(tx,input);
  }
  async #syncFinal(tx: AppRunTransaction,authority: Awaited<ReturnType<typeof loadLiveResourceSyncAuthority>> | Awaited<ReturnType<typeof loadLiveAttachmentSyncAuthority>> | LiveAttachmentSyncBindingAuthority | LiveResourceSyncBindingAuthority,
    deadlines: readonly Date[]) {
    if (this.syncMode !== 'attachment_v3') return;
    if (!authority || !authority.binding.consent_expires_at || !await attachmentFinalAuthorityIsCurrent(tx,
      [authority.binding.owner_user_id,authority.registration.operator_user_id],{clock:this.now,
        expires_at:[...('session' in authority ? [authority.session.expires_at] : []),authority.binding.consent_expires_at,...deadlines]})) throw new Error('APP_ATTACHMENT_AUTHORITY_STALE');
  }

  /** A v2 Run is host-created for one reviewed private binding. The live
   * authority reader owns the mutable membership/App/consent locks; this
   * comparison binds that authority to the immutable Run and intent. */
  async #resourceSyncRunMatchesAuthority(
    tx: AppRunTransaction, run: AppRunSafeView,
    authority: LiveResourceSyncBindingAuthority | LiveAttachmentSyncBindingAuthority,
  ): Promise<typeof appSyncIntents.$inferSelect | null> {
    const [stored] = await tx.select().from(appRuns).where(and(
      eq(appRuns.org_id, run.org_id), eq(appRuns.id, run.id),
    )).limit(1);
    const { binding, registration, installation, version, grant, provider_snapshot } = authority;
    if (!stored || stored.origin_kind !== 'app' || stored.provider_kind !== 'app_runtime'
      || stored.origin_resource_binding_id !== binding.id
      || stored.origin_runtime_binding_id !== null
      || stored.initiating_actor_type !== 'system' || stored.execution_actor_type !== 'system'
      || stored.initiating_actor_id !== binding.id || stored.execution_actor_id !== binding.id
      || stored.origin_app_installation_id !== installation.id
      || stored.origin_app_version_id !== version.id
      || stored.origin_app_grant_snapshot_id !== grant.id
      || stored.provider_instance_id !== registration.id
      || stored.provider_snapshot_id !== provider_snapshot.id
      || stored.operation_name !== binding.operation_name
      || stored.risk_class !== binding.risk_class
      || stored.review_requirement !== binding.review_requirement
      || stored.review_scope !== binding.review_scope
      || stored.retry_class !== binding.retry_class
      || stored.retention_class !== binding.retention_class
      || stored.review_scope !== 'reviewed_resource_sync'
      || stored.retry_class !== 'unsafe_or_unknown') return null;
    try {
      if (canonicalCapabilityJson(stored.authorization_snapshot)
        !== canonicalCapabilityJson(this.syncMode === 'attachment_v3'
          ? buildAttachmentSyncAuthorizationSnapshot(authority as LiveAttachmentSyncBindingAuthority) : buildResourceSyncAuthorizationSnapshot(authority))) return null;
    } catch { return null; }
    const [intent] = await tx.select().from(appSyncIntents).where(and(
      eq(appSyncIntents.org_id, run.org_id), eq(appSyncIntents.run_id, run.id),
    )).limit(1);
    if (!intent || intent.resource_binding_id !== binding.id
      || intent.app_installation_id !== installation.id
      || intent.app_version_id !== version.id
      || intent.grant_snapshot_id !== grant.id
      || intent.provider_snapshot_id !== provider_snapshot.id
      || intent.owner_user_id !== binding.owner_user_id
      || intent.descriptor_digest !== authority.descriptor_digest) return null;
    return intent;
  }

  async run(
    orgId: string,
    runId: string,
    attemptId: string,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<AppRunSafeView> {
    return (await this.#runInternal(orgId, runId, attemptId, workerId, signal)).run;
  }

  /** Synchronous compatibility entrance. The exact provider result is
   * transient and never enters generic Run APIs, logs, jobs, or projections. */
  async runImmediate(
    orgId: string,
    runId: string,
    attemptId: string,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<AppRunImmediateExecution> {
    return this.#runInternal(orgId, runId, attemptId, workerId, signal);
  }

  async #runInternal(
    orgId: string,
    runId: string,
    attemptId: string,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<AppRunImmediateExecution> {
    const current = await this.repository.inspect(orgId, runId);
    if (current?.provider_kind === 'app_runtime') return { run: current };
    await this.recoverRun(orgId, runId, attemptId);
    const claimed = await this.#claim(orgId, runId, attemptId, workerId);
    if (!claimed) {
      const run = await this.repository.inspect(orgId, runId);
      if (!run) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      return { run };
    }

    if (claimed.run.provider_kind === 'native') {
      await this.#executeNativeAtomic(claimed, signal);
      const settled = await this.repository.inspect(orgId, runId);
      if (!settled) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      await this.#projectState(settled);
      return { run: settled };
    }
    const input = await this.secretRepository.readInput(orgId, runId);
    if (input === null) {
      await this.#settleBeforeCallFailure(claimed, 'APP_RUN_EXPIRED');
      const settled = await this.repository.inspect(orgId, runId).then((run) => run!);
      await this.#projectState(settled);
      return { run: settled };
    }
    const boundary = await this.#markProviderCallStarted(claimed);
    if (!boundary) {
      const run = await this.repository.inspect(orgId, runId);
      if (!run) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      return { run };
    }

    const stableProviderKey = claimed.run.retry_class === 'idempotent_with_key'
      ? appRunProviderIdempotencyKey(runId)
      : undefined;
    const stopHeartbeat = this.#startLeaseHeartbeat(claimed);
    let result: AppRunProviderExecutionResult;
    try {
      result = await this.executor.execute({
        org_id: orgId,
        provider_kind: claimed.run.provider_kind === 'app_runtime' ? 'app_runtime' : 'mcp',
        provider_instance_id: claimed.run.provider_instance_id,
        operation_name: claimed.run.operation_name,
        origin_kind: claimed.run.origin_kind,
        input,
        provider_idempotency_key: stableProviderKey,
        ...(boundary.dispatch_pin ? { dispatch_pin: boundary.dispatch_pin } : {}),
        signal,
      });
    } catch {
      result = { status: 'indeterminate' };
    } finally {
      await stopHeartbeat();
    }

    if (result.status === 'indeterminate') {
      await this.#settleIndeterminate(
        orgId,
        runId,
        claimed.attempt.id,
        claimed.attempt.claim_token!,
      );
      const settled = await this.repository.inspect(orgId, runId).then((run) => run!);
      await this.#projectState(settled);
      return { run: settled, provider_result: result };
    }

    const known = await this.#knownOutcome(claimed.run, result);
    await this.#persistKnownResult(
      orgId,
      runId,
      claimed.attempt.id,
      claimed.attempt.claim_token!,
      result,
      known,
    );
    await this.#finalizeKnownResult(orgId, runId, claimed.attempt.id, claimed.attempt.claim_token!);
    const settled = await this.repository.inspect(orgId, runId).then((run) => run!);
    await this.#projectState(settled);
    return { run: settled, provider_result: result };
  }

  async prepareAttempt(orgId: string, runId: string): Promise<string | null> {
    const now = this.now();
    return this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, orgId, runId);
      if (!run) return null;
      return run.review_scope === 'reviewed_resource_sync'
        ? this.scheduleResourceSyncInTransaction(tx, run, now)
        : this.scheduleInTransaction(tx, run, now);
    });
  }

  /** External pull claim uses the existing attempt ledger and its claim event.
   * The session token is checked again inside the claim transaction. */
  async claimRuntimeAttempt(input: Readonly<{
    org_id: string; run_id: string; attempt_id: string;
    session_id: string; token_hash: string;
  }>): Promise<AppRuntimeClaimEnvelope | null> {
    await this.recoverRun(input.org_id, input.run_id, input.attempt_id);
    const claimed = await this.#claim(input.org_id, input.run_id, input.attempt_id,
      `app_runtime:${input.session_id}`, { session_id: input.session_id, token_hash: input.token_hash });
    if (!claimed || !claimed.attempt.claim_token || !claimed.attempt.lease_expires_at
      || !claimed.attempt.runtime_sequence || !claimed.attempt.runtime_binding_id
      || claimed.attempt.runtime_session_epoch === null || claimed.attempt.runtime_epoch === null) return null;
    const authority = await this.repository.transaction((tx) => loadLiveRuntimeAuthority(
      tx, input.org_id, input.session_id, input.token_hash, this.now, input.run_id));
    if (!authority) return null;
    return Object.freeze({
      schema_version: APP_RUNTIME_CHANNEL_VERSION,
      ...authority.pin,
      run_id: claimed.run.id,
      attempt_id: claimed.attempt.id,
      attempt_number: claimed.attempt.attempt_number,
      claim_token: claimed.attempt.claim_token,
      lease_expires_at: claimed.attempt.lease_expires_at.toISOString(),
      sequence: claimed.attempt.runtime_sequence,
      initiating_actor_type: claimed.run.initiating_actor_type,
      initiating_actor_id: claimed.run.initiating_actor_id,
      grant_snapshot_id: authority.grant_snapshot_id,
      operation_name: claimed.run.operation_name,
      ...(claimed.run.retry_class === 'idempotent_with_key'
        ? { provider_idempotency_key: appRunProviderIdempotencyKey(claimed.run.id) } : {}),
    });
  }

  async startRuntimeAttempt(input: Readonly<{
    org_id: string; run_id: string; attempt_id: string; session_id: string;
    token_hash: string; claim_token: string; sequence: number;
  }>): Promise<AppRuntimeStartEnvelope | null> {
    const claimed = await this.#loadRuntimeClaim(input);
    if (!claimed) return null;
    const boundary = await this.#markProviderCallStarted(claimed,
      { session_id: input.session_id, token_hash: input.token_hash });
    if (!boundary) return null;
    const exactInput = await this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, input.org_id, input.run_id);
      if (!run || run.provider_kind !== 'app_runtime') return null;
      const authority = await loadLiveRuntimeAuthority(tx, input.org_id,
        input.session_id, input.token_hash, this.now, input.run_id);
      if (!authority) return null;
      if (run.state !== 'running' || run.cancel_requested_at
        || !run.execution_released_at || run.input_expires_at <= this.now()
        || !await runtimeRunMatchesAuthority(tx, input.org_id, input.run_id, authority)) return null;
      await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${input.org_id}
        AND id = ${input.attempt_id} FOR SHARE`);
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.id, input.attempt_id),
        eq(appRunAttempts.run_id, input.run_id),
      )).limit(1);
      if (!attempt || attempt.state !== 'provider_call_started'
        || attempt.claim_token !== input.claim_token
        || attempt.runtime_session_id !== input.session_id
        || attempt.runtime_sequence !== input.sequence
        || !attempt.lease_expires_at || attempt.lease_expires_at <= this.now()) return null;
      // The authority rows remain locked until the secret read completes.
      return this.secretRepository.readInput(input.org_id, input.run_id, tx);
    });
    if (exactInput === null) return null;
    return Object.freeze({
      schema_version: APP_RUNTIME_CHANNEL_VERSION,
      run_id: input.run_id, attempt_id: input.attempt_id,
      lease_expires_at: claimed.attempt.lease_expires_at!.toISOString(),
      input: exactInput,
      ...(claimed.run.retry_class === 'idempotent_with_key'
        ? { provider_idempotency_key: appRunProviderIdempotencyKey(input.run_id) } : {}),
    });
  }

  async heartbeatRuntimeAttempt(input: Readonly<{
    org_id: string; run_id: string; attempt_id: string; session_id: string;
    token_hash: string; claim_token: string; sequence: number;
  }>): Promise<boolean> {
    return this.renewLease(input.org_id, input.attempt_id, input.claim_token, input);
  }

  async heartbeatResourceSyncAttempt(input: Readonly<{
    org_id: string; run_id: string; attempt_id: string; session_id: string;
    token_hash: string; claim_token: string; sequence: number;
  }>) {
    if (!this.#syncEnabled()) return null;
    return this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, input.org_id, input.run_id);
      if (!run || run.review_scope !== 'reviewed_resource_sync'
        || run.provider_kind !== 'app_runtime') return null;
      const authority = await this.#loadSyncAuthority(tx, { org_id: input.org_id,
        session_id: input.session_id, token_hash: input.token_hash, clock: this.now });
      if (!authority) return null;
      const intent = await this.#resourceSyncRunMatchesAuthority(tx, run, authority);
      if (!intent) return null;
      await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${input.org_id}
        AND id = ${input.attempt_id} FOR UPDATE`);
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.id, input.attempt_id),
        eq(appRunAttempts.run_id, input.run_id),
      )).limit(1);
      // Do not release a cursor already displaced by a prior page or host
      // maintenance. This lock follows the attempt and precedes any effect.
      await tx.execute(sql`SELECT id FROM app_sync_checkpoints WHERE org_id = ${input.org_id}
        AND id = ${intent.checkpoint_id} FOR SHARE`);
      const [checkpoint] = await tx.select().from(appSyncCheckpoints).where(and(
        eq(appSyncCheckpoints.org_id, input.org_id),
        eq(appSyncCheckpoints.id, intent.checkpoint_id),
        eq(appSyncCheckpoints.resource_binding_id, authority.binding.id),
      )).limit(1);
      const now = this.now();
      if (!checkpoint || checkpoint.state !== 'active'
        || checkpoint.generation !== intent.generation
        || checkpoint.cursor_sequence !== intent.expected_cursor_sequence
        || checkpoint.cursor_hmac_key_version !== intent.expected_cursor_hmac_key_version
        || checkpoint.cursor_hmac !== intent.expected_cursor_hmac) return null;
      if (!attempt || !['claimed', 'provider_call_started'].includes(attempt.state)
        || attempt.claim_token !== input.claim_token
        || attempt.runtime_session_id !== authority.session.id
        || attempt.resource_binding_id !== authority.binding.id
        || attempt.runtime_session_epoch !== authority.session.session_epoch
        || attempt.runtime_epoch !== authority.registration.runtime_epoch
        || attempt.runtime_sequence !== input.sequence
        || !attempt.lease_expires_at || attempt.lease_expires_at <= now
        || run.cancel_requested_at || !run.execution_released_at
        || !['pending', 'running'].includes(run.state)
        || run.input_expires_at <= now || authority.binding.consent_expires_at! <= now
        || authority.session.expires_at <= now) return null;
      const leaseExpiresAt = new Date(now.getTime() + boundedLeaseMs(this.leaseMs));
      const [renewed] = await tx.update(appRunAttempts).set({
        lease_expires_at: leaseExpiresAt, updated_at: now,
      }).where(and(eq(appRunAttempts.org_id, input.org_id),
        eq(appRunAttempts.id, attempt.id),
        eq(appRunAttempts.claim_token, input.claim_token))).returning({ id: appRunAttempts.id });
      if (!renewed) return null;
      await this.#syncFinal(tx,authority,[run.input_expires_at,run.result_expires_at,leaseExpiresAt]);
      return Object.freeze({ run_id: input.run_id, attempt_id: input.attempt_id,
        sequence: input.sequence, lease_expires_at: leaseExpiresAt.toISOString() });
    });
  }

  async completeRuntimeAttempt(input: Readonly<{
    org_id: string; token_hash: string; result: AppRuntimeResultRequest;
  }>): Promise<AppRunSafeView | null> {
    const result = input.result;
    const fingerprintValue = `deft.app_runtime.result.v1:${createHash('sha256')
      .update(canonicalCapabilityJson(result)).digest('hex')}`;
    const digest = this.secrets.fingerprintText('idempotency', fingerprintValue).fingerprint;
    const replayDigests = new Set(this.secrets.fingerprintTextCandidates('idempotency',
      fingerprintValue).map((candidate) => candidate.fingerprint));
    const now = this.now();
    const completed = await this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, input.org_id, result.run_id);
      if (!run || run.provider_kind !== 'app_runtime') return false;
      const authority = await loadLiveRuntimeAuthority(tx, input.org_id,
        result.session_id, input.token_hash, this.now, result.run_id);
      if (!authority) return false;
      await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${input.org_id}
        AND id = ${result.attempt_id} FOR UPDATE`);
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.id, result.attempt_id),
        eq(appRunAttempts.run_id, result.run_id),
      )).limit(1);
      if (!attempt || attempt.claim_token !== result.claim_token
        || attempt.runtime_session_id !== result.session_id
        || attempt.runtime_sequence !== result.sequence) return false;
      if (!authority || authority.pin.runtime_binding_id !== attempt.runtime_binding_id
        || authority.pin.runtime_epoch !== attempt.runtime_epoch
        || authority.pin.session_epoch !== attempt.runtime_session_epoch) return false;
      const reviewedAction = await runtimeRunMatchesAuthority(tx, input.org_id, result.run_id, authority);
      if (!reviewedAction) return false;
      if (attempt.runtime_result_hmac) return replayDigests.has(attempt.runtime_result_hmac);
      if (attempt.state !== 'provider_call_started' || !attempt.lease_expires_at
        || attempt.lease_expires_at <= this.now()) return false;
      if (result.status === 'returned') {
        try { parseRuntimeObjectInput(reviewedAction.output_schema, result.output); }
        catch {
          // The provider may already have made the external effect. Invalid
          // output cannot be signed as success and must not trigger a retry.
          await this.#recoverUnknownInTransaction(tx, run, attempt, now, digest);
          return true;
        }
      }
      if (result.status === 'indeterminate') {
        await this.#recoverUnknownInTransaction(tx, run, attempt, now, digest);
        return true;
      }
      const outcome = await this.#knownOutcome(run, result);
      if (result.status === 'returned' && outcome.result_status === 'retained') {
        const envelope = AppRunRetainedProviderResultSchema.parse({
          schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
          provider_succeeded: result.provider_succeeded,
          output: result.output,
        });
        await this.secretRepository.insertOutput(tx, {
          org_id: input.org_id, run_id: run.id, attempt_id: attempt.id,
          value: envelope, expires_at: run.result_expires_at,
        });
      }
      await tx.update(appRunAttempts).set({
        provider_call_finished_at: now, safe_outcome: outcome,
        runtime_result_hmac: digest, updated_at: now,
      }).where(and(eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.id, attempt.id)));
      await this.#finalizeKnownInTransaction(tx, run, { ...attempt,
        provider_call_finished_at: now, safe_outcome: outcome }, now);
      return true;
    });
    if (!completed) return null;
    const settled = await this.repository.inspect(input.org_id, result.run_id);
    if (settled) await this.#projectState(settled);
    return settled;
  }

  async #loadRuntimeClaim(input: Readonly<{
    org_id: string; run_id: string; attempt_id: string; session_id: string;
    token_hash: string; claim_token: string; sequence: number;
  }>): Promise<ClaimedAttempt | null> {
    return this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, input.org_id, input.run_id);
      if (!run || run.provider_kind !== 'app_runtime') return null;
      const authority = await loadLiveRuntimeAuthority(tx, input.org_id,
        input.session_id, input.token_hash, this.now, input.run_id);
      if (!authority) return null;
      if (!await runtimeRunMatchesAuthority(tx, input.org_id, input.run_id, authority)) return null;
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.run_id, input.run_id),
        eq(appRunAttempts.id, input.attempt_id),
      )).limit(1);
      if (!attempt || attempt.claim_token !== input.claim_token
        || attempt.runtime_session_id !== input.session_id
        || attempt.runtime_binding_id !== authority.pin.runtime_binding_id
        || attempt.runtime_epoch !== authority.pin.runtime_epoch
        || attempt.runtime_session_epoch !== authority.pin.session_epoch
        || attempt.runtime_sequence !== input.sequence
        || !attempt.lease_expires_at || attempt.lease_expires_at <= this.now()
        || !['claimed', 'provider_call_started'].includes(attempt.state)) return null;
      return { run, attempt };
    });
  }

  /** Schedule against a Run already locked by the caller. Queue insertion is
   * in the same transaction as attempt creation/release, closing the crash gap
   * between durable authority and worker ownership. */
  async scheduleInTransaction(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    now: Date,
  ): Promise<string | null> {
    if (
      !run.execution_released_at
      || ['succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'].includes(run.state)
      || !await this.executionAuthorizer.authorizeExecution({
        org_id: run.org_id, run, tx, stage: 'prepare', now,
      })
      || run.input_expires_at <= now
    ) return null;
    const [existing] = await tx.select({ id: appRunAttempts.id }).from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, run.org_id),
      eq(appRunAttempts.run_id, run.id),
      inArray(appRunAttempts.state, ['pending', 'claimed', 'provider_call_started']),
    )).orderBy(asc(appRunAttempts.attempt_number)).limit(1);
    if (existing) {
      await this.attemptQueue.enqueue(tx, run.org_id, run.id, existing.id);
      return existing.id;
    }
    return (await this.#createAttempt(tx, run, now))?.id ?? null;
  }

  async completeResourceSyncAttempt(input: Readonly<{
    org_id: string; token_hash: string; result: ResourceSyncResultRequest | AttachmentSyncResultRequest;
  }>) {
    const store = this.resourceSyncStore;
    if (!this.#syncEnabled() || !store) return null;
    const result = input.result;
    if (result.schema_version !== this.#syncVersion) return null;
    const fingerprintValue = `${this.syncMode === 'attachment_v3' ? 'deft.app_resource_sync.result.v3' : 'deft.app_resource_sync.result.v2'}:${createHash('sha256')
      .update(canonicalCapabilityJson(result)).digest('hex')}`;
    const fingerprintCandidates = this.secrets.fingerprintTextCandidates('idempotency', fingerprintValue);
    const replayDigests = new Set(fingerprintCandidates.map((candidate) => candidate.fingerprint));
    const accepted = await this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, input.org_id, result.run_id);
      if (!run || run.review_scope !== 'reviewed_resource_sync'
        || run.provider_kind !== 'app_runtime') return false;
      const [runKey] = await tx.select({ key_version: appRuns.idempotency_key_version })
        .from(appRuns).where(and(eq(appRuns.org_id, input.org_id),
          eq(appRuns.id, result.run_id))).limit(1);
      const digest = fingerprintCandidates.find((candidate) =>
        candidate.key_version === runKey?.key_version)?.fingerprint;
      // Run idempotency retention already pins this purpose/key version.
      if (!digest) return false;
      const authority = await this.#loadSyncAuthority(tx, { org_id: input.org_id,
        session_id: result.session_id, token_hash: input.token_hash, clock: this.now });
      if (!authority) return false;
      const intent = await this.#resourceSyncRunMatchesAuthority(tx, run, authority);
      if (!intent) return false;
      await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${input.org_id}
        AND id = ${result.attempt_id} FOR UPDATE`);
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.id, result.attempt_id),
        eq(appRunAttempts.run_id, result.run_id),
      )).limit(1);
      if (!attempt || attempt.claim_token !== result.claim_token
        || attempt.runtime_session_id !== authority.session.id
        || attempt.resource_binding_id !== authority.binding.id
        || attempt.runtime_session_epoch !== authority.session.session_epoch
        || attempt.runtime_epoch !== authority.registration.runtime_epoch
        || attempt.runtime_sequence !== result.sequence) return false;
      // A committed callback is accepted byte-for-byte without revisiting the
      // page store. Retained fingerprint keys permit a key rotation replay.
      if (attempt.runtime_result_hmac) {
        await this.#syncFinal(tx,authority,[run.result_expires_at]);
        return replayDigests.has(attempt.runtime_result_hmac);
      }
      const now = this.now();
      if (attempt.state !== 'provider_call_started' || !attempt.lease_expires_at
        || attempt.lease_expires_at <= now || run.state !== 'running'
        || run.cancel_requested_at || run.input_expires_at <= now
        || authority.binding.consent_expires_at! <= now
        || authority.session.expires_at <= now) return false;
      if (result.status === 'indeterminate' || result.status === 'not_attempted') {
        // The host crossed provider_call_started before releasing the input.
        // A provider assertion that it did not call the source cannot prove
        // that no external effect occurred.
        await this.#recoverUnknownInTransaction(tx, run, attempt, now, digest);
        await this.#syncFinal(tx,authority,[run.input_expires_at,attempt.lease_expires_at]);
        return true;
      }
      let outcome: AppRunSafeOutcome;
      let receiptFacts: Record<string, string | number | boolean> | undefined;
      if (result.status === 'returned' && result.provider_succeeded) {
        const rawInput = await this.secretRepository.readInput(input.org_id, run.id, tx);
        let page: Extract<ResourceSyncResultRequest | AttachmentSyncResultRequest,
          { status: 'returned'; provider_succeeded: true }>['page'];
        try {
          const parsed = this.syncMode === 'attachment_v3'
            ? parseAttachmentSyncResult(result,{descriptor:authority.descriptor,starting_request:SyncRequestV2Schema.parse(rawInput)})
            : parseAppResourceSyncResult(result,{descriptor:authority.descriptor as LiveResourceSyncBindingAuthority['descriptor'],starting_request:parseSyncRequest(rawInput)});
          if (parsed.status !== 'returned' || !parsed.provider_succeeded) return false;
          page = parsed.page;
        } catch {
          // The provider may already have observed an external source effect.
          // An invalid page is never signed as success or automatically retried.
          await this.#recoverUnknownInTransaction(tx, run, attempt, now, digest);
          await this.#syncFinal(tx,authority,[run.input_expires_at,attempt.lease_expires_at]);
          return true;
        }
        if (run.result_expires_at <= now) {
          await this.#recoverUnknownInTransaction(tx, run, attempt, now, digest);
          await this.#syncFinal(tx,authority,[run.input_expires_at,attempt.lease_expires_at]);
          return true;
        }
        const applied = await store.applyPageInTransaction(tx, {
          org_id: input.org_id, run_id: run.id, attempt_id: attempt.id,
          page, clock: this.now,
        });
        const finalClock = this.now();
        if (attempt.lease_expires_at <= finalClock || authority.session.expires_at <= finalClock
          || authority.binding.consent_expires_at! <= finalClock
          || run.input_expires_at <= finalClock || run.result_expires_at <= finalClock) {
          // A page has already been written in this transaction. Returning
          // false would commit it without output, terminal Run or receipt.
          throw new Error('APP_RESOURCE_SYNC_SETTLEMENT_EXPIRED');
        }
        const envelope = AppRunRetainedProviderResultSchema.parse({
          schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
          provider_succeeded: true, output: page,
        });
        assertAppRunOutputWithinBudget(envelope);
        await this.secretRepository.insertOutput(tx, {
          org_id: input.org_id, run_id: run.id, attempt_id: attempt.id,
          value: envelope, expires_at: run.result_expires_at,
        });
        outcome = AppRunSafeOutcomeSchema.parse({ success: true,
          provider_call_attempted: true, result_status: 'retained' });
        receiptFacts = { resource_binding_id: authority.binding.id,
          checkpoint_id: intent.checkpoint_id, page_digest: applied.page_digest,
          cursor_sequence: applied.applied_sequence };
      } else {
        outcome = AppRunSafeOutcomeSchema.parse({ success: false,
          provider_call_attempted: true, result_status: 'unavailable',
          error_code: 'APP_RUN_PROVIDER_ERROR' });
      }
      const finalClock = this.now();
      if (attempt.lease_expires_at <= finalClock || authority.session.expires_at <= finalClock
        || authority.binding.consent_expires_at! <= finalClock
        || run.input_expires_at <= finalClock) {
        throw new Error('APP_RESOURCE_SYNC_SETTLEMENT_EXPIRED');
      }
      await tx.update(appRunAttempts).set({ provider_call_finished_at: finalClock,
        safe_outcome: outcome, runtime_result_hmac: digest, updated_at: finalClock,
      }).where(and(eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.id, attempt.id)));
      await this.#finalizeKnownInTransaction(tx, run, { ...attempt,
        provider_call_finished_at: finalClock, safe_outcome: outcome }, finalClock, receiptFacts);
      const committedAt = this.now();
      if (attempt.lease_expires_at <= committedAt || authority.session.expires_at <= committedAt
        || authority.binding.consent_expires_at! <= committedAt
        || run.input_expires_at <= committedAt || run.result_expires_at <= committedAt) {
        // Includes page, output and receipt writes: abort the whole transaction.
        throw new Error('APP_RESOURCE_SYNC_SETTLEMENT_EXPIRED');
      }
      await this.#syncFinal(tx,authority,[run.input_expires_at,run.result_expires_at,attempt.lease_expires_at]);
      return true;
    });
    if (!accepted) return null;
    return Object.freeze({ run_id: result.run_id, attempt_id: result.attempt_id,
      sequence: result.sequence });
  }

  async startResourceSyncAttempt(input: Readonly<{
    org_id: string; run_id: string; attempt_id: string; session_id: string;
    token_hash: string; claim_token: string; sequence: number;
  }>) {
    if (!this.#syncEnabled()) return null;
    return this.repository.transaction(async (tx) => {
      let run = await this.repository.lockRun(tx, input.org_id, input.run_id);
      if (!run || run.review_scope !== 'reviewed_resource_sync'
        || run.provider_kind !== 'app_runtime') return null;
      const authority = await this.#loadSyncAuthority(tx, { org_id: input.org_id,
        session_id: input.session_id, token_hash: input.token_hash, clock: this.now });
      if (!authority) return null;
      const intent = await this.#resourceSyncRunMatchesAuthority(tx, run, authority);
      if (!intent) return null;
      await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${input.org_id}
        AND id = ${input.attempt_id} FOR UPDATE`);
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.id, input.attempt_id),
        eq(appRunAttempts.run_id, input.run_id),
      )).limit(1);
      await tx.execute(sql`SELECT id FROM app_sync_checkpoints WHERE org_id = ${input.org_id}
        AND id = ${intent.checkpoint_id} FOR SHARE`);
      const [checkpoint] = await tx.select().from(appSyncCheckpoints).where(and(
        eq(appSyncCheckpoints.org_id, input.org_id),
        eq(appSyncCheckpoints.id, intent.checkpoint_id),
        eq(appSyncCheckpoints.resource_binding_id, authority.binding.id),
      )).limit(1);
      const now = this.now();
      if (!checkpoint || checkpoint.state !== 'active'
        || checkpoint.generation !== intent.generation
        || checkpoint.cursor_sequence !== intent.expected_cursor_sequence
        || checkpoint.cursor_hmac_key_version !== intent.expected_cursor_hmac_key_version
        || checkpoint.cursor_hmac !== intent.expected_cursor_hmac
        || !attempt || attempt.state !== 'claimed'
        || attempt.claim_token !== input.claim_token
        || attempt.runtime_session_id !== authority.session.id
        || attempt.resource_binding_id !== authority.binding.id
        || attempt.runtime_session_epoch !== authority.session.session_epoch
        || attempt.runtime_epoch !== authority.registration.runtime_epoch
        || attempt.runtime_sequence !== input.sequence
        || !attempt.lease_expires_at || attempt.lease_expires_at <= now
        || !run.execution_released_at || run.cancel_requested_at
        || !['pending', 'running'].includes(run.state)
        || run.input_expires_at <= now || authority.binding.consent_expires_at! <= now
        || authority.session.expires_at <= now) return null;
      const rawInput = await this.secretRepository.readInput(input.org_id, run.id, tx);
      let request: ReturnType<typeof parseSyncRequest> | ReturnType<typeof SyncRequestV2Schema.parse>;
      try { request = this.syncMode === 'attachment_v3' ? SyncRequestV2Schema.parse(rawInput) : parseSyncRequest(rawInput); }
      catch { return null; }
      if (request.max_items > authority.binding.max_records_per_page) return null;
      const [started] = await tx.update(appRunAttempts).set({ state: 'provider_call_started',
        provider_call_started_at: now, updated_at: now }).where(and(
        eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.id, attempt.id),
        eq(appRunAttempts.claim_token, input.claim_token),
        eq(appRunAttempts.state, 'claimed'),
      )).returning({ id: appRunAttempts.id });
      if (!started) return null;
      if (run.state === 'pending') run = await this.repository.transition(tx, {
        run, state: 'running', now,
      });
      await this.repository.appendEvent(tx, { id: crypto.randomUUID(),
        org_id: input.org_id, run_id: run.id, event_type: 'provider_call_started',
        payload: { attempt_id: attempt.id }, now });
      const checkedAt = this.now();
      if (attempt.lease_expires_at <= checkedAt || run.input_expires_at <= checkedAt
        || authority.binding.consent_expires_at! <= checkedAt
        || authority.session.expires_at <= checkedAt) {
        throw new Error('APP_RESOURCE_SYNC_START_EXPIRED');
      }
      await this.#syncFinal(tx,authority,[run.input_expires_at,run.result_expires_at,attempt.lease_expires_at!]);
      return Object.freeze({ schema_version: this.#syncVersion,
        audience: APP_RESOURCE_SYNC_AUDIENCE, work_kind: 'sync_page' as const,
        resource_binding_id: authority.binding.id, run_id: run.id,
        attempt_id: attempt.id, sequence: input.sequence,
        lease_expires_at: attempt.lease_expires_at.toISOString(),
        descriptor_digest: authority.descriptor_digest,
        descriptor: authority.descriptor, input: request });
    });
  }

  async claimResourceSyncAttempt(input: Readonly<{
    org_id: string; run_id: string; attempt_id: string;
    session_id: string; token_hash: string;
  }>) {
    if (!this.#syncEnabled()) return null;
    await this.recoverRun(input.org_id, input.run_id, input.attempt_id);
    return this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, input.org_id, input.run_id);
      if (!run || run.review_scope !== 'reviewed_resource_sync'
        || run.provider_kind !== 'app_runtime') return null;
      const authority = await this.#loadSyncAuthority(tx, { org_id: input.org_id,
        session_id: input.session_id, token_hash: input.token_hash, clock: this.now });
      if (!authority || !await this.#resourceSyncRunMatchesAuthority(tx, run, authority)) return null;
      await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${input.org_id}
        AND id = ${input.attempt_id} FOR UPDATE`);
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, input.org_id), eq(appRunAttempts.id, input.attempt_id),
        eq(appRunAttempts.run_id, run.id),
      )).limit(1);
      const now = this.now();
      if (!run.execution_released_at || run.cancel_requested_at
        || !['pending', 'running'].includes(run.state)
        || run.input_expires_at <= now || authority.binding.consent_expires_at! <= now
        || authority.session.expires_at <= now) return null;
      if (!attempt || attempt.state !== 'pending') return null;
      const [session] = await tx.update(appRuntimeSessions).set({
        next_sequence: sql`${appRuntimeSessions.next_sequence} + 1`, updated_at: now,
      }).where(and(eq(appRuntimeSessions.org_id, input.org_id),
        eq(appRuntimeSessions.id, authority.session.id)))
        .returning({ next_sequence: appRuntimeSessions.next_sequence });
      if (!session) return null;
      const sequence = session.next_sequence - 1;
      const leaseExpiresAt = new Date(now.getTime() + boundedLeaseMs(this.leaseMs));
      const [claimed] = await tx.update(appRunAttempts).set({
        state: 'claimed', claim_owner: `app_resource_sync:${input.session_id}`,
        claim_token: crypto.randomUUID(), resource_binding_id: authority.binding.id,
        runtime_session_id: authority.session.id,
        runtime_session_epoch: authority.session.session_epoch,
        runtime_epoch: authority.registration.runtime_epoch,
        runtime_sequence: sequence,
        claimed_at: now, lease_expires_at: leaseExpiresAt, updated_at: now,
      }).where(and(eq(appRunAttempts.org_id, input.org_id),
        eq(appRunAttempts.id, attempt.id), eq(appRunAttempts.state, 'pending'))).returning();
      if (!claimed?.claim_token) return null;
      await this.repository.appendEvent(tx, { id: crypto.randomUUID(), org_id: input.org_id,
        run_id: run.id, event_type: 'attempt_claimed',
        payload: { attempt_id: claimed.id }, now });
      await this.#syncFinal(tx,authority,[run.input_expires_at,run.result_expires_at,leaseExpiresAt]);
      return Object.freeze({ schema_version: this.#syncVersion,
        audience: APP_RESOURCE_SYNC_AUDIENCE, work_kind: 'sync_page' as const,
        org_id: input.org_id, app_installation_id: authority.installation.id,
        app_version_id: authority.version.id, grant_snapshot_id: authority.grant.id,
        lifecycle_epoch: authority.installation.lifecycle_epoch,
        grant_epoch: authority.installation.grant_epoch,
        runtime_registration_id: authority.registration.id,
        resource_binding_id: authority.binding.id,
        runtime_epoch: authority.registration.runtime_epoch,
        session_id: authority.session.id, session_epoch: authority.session.session_epoch,
        run_id: run.id, attempt_id: claimed.id, attempt_number: claimed.attempt_number,
        claim_token: claimed.claim_token, sequence,
        lease_expires_at: leaseExpiresAt.toISOString(),
        descriptor_digest: authority.descriptor_digest });
    });
  }

  /** Admission owns a newly inserted, locked system Run and its immutable
   * intent. This uses the existing attempt/event/queue rather than a second
   * scheduler. It is safe to call again for the same still-live attempt. */
  async scheduleResourceSyncInTransaction(
    tx: AppRunTransaction, run: AppRunSafeView, _now = this.now(),
  ): Promise<string | null> {
    if (!this.#syncEnabled()
      || run.review_scope !== 'reviewed_resource_sync' || run.provider_kind !== 'app_runtime'
      || run.origin_kind !== 'app' || run.initiating_actor_type !== 'system'
      || run.execution_actor_type !== 'system' || !run.execution_released_at
      || run.cancel_requested_at
      || ['succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'].includes(run.state)) return null;
    const [stored] = await tx.select({ binding_id: appRuns.origin_resource_binding_id })
      .from(appRuns).where(and(eq(appRuns.org_id, run.org_id), eq(appRuns.id, run.id))).limit(1);
    if (!stored?.binding_id) return null;
    const authority = await this.#loadSyncBinding(tx, {
      org_id: run.org_id, resource_binding_id: stored.binding_id, clock: this.now,
    });
    if (!authority || !await this.#resourceSyncRunMatchesAuthority(tx, run, authority)) return null;
    const checkedAt = this.now();
    if (run.input_expires_at <= checkedAt || authority.binding.consent_expires_at! <= checkedAt) return null;
    const [existing] = await tx.select({ id: appRunAttempts.id }).from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, run.org_id), eq(appRunAttempts.run_id, run.id),
      inArray(appRunAttempts.state, ['pending', 'claimed', 'provider_call_started']),
    )).orderBy(asc(appRunAttempts.attempt_number)).limit(1);
    if (existing) {
      await this.attemptQueue.enqueue(tx, run.org_id, run.id, existing.id);
      await this.#syncFinal(tx,authority,[run.input_expires_at,run.result_expires_at]);
      return existing.id;
    }
    const created=await this.#createAttempt(tx,run,checkedAt);
    await this.#syncFinal(tx,authority,[run.input_expires_at,run.result_expires_at]);
    return created?.id ?? null;
  }

  async renewLease(orgId: string, attemptId: string, claimToken: string,
    runtime?: Readonly<{ run_id: string; session_id: string; token_hash: string; sequence: number }>,
  ): Promise<boolean> {
    const now = this.now();
    const [identity] = await db.select({ run_id: appRunAttempts.run_id }).from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, orgId), eq(appRunAttempts.id, attemptId),
    )).limit(1);
    if (!identity) return false;
    return this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, orgId, identity.run_id);
      if (!run || (runtime ? run.provider_kind !== 'app_runtime' : run.provider_kind !== 'mcp')) return false;
      const authority = runtime ? await loadLiveRuntimeAuthority(tx, orgId,
        runtime.session_id, runtime.token_hash, this.now, identity.run_id) : null;
      if (runtime && !authority) return false;
      if (runtime && (!authority || runtime.run_id !== run.id
        || !await runtimeRunMatchesAuthority(tx, orgId, run.id, authority))) return false;
      await tx.execute(sql`SELECT id FROM app_run_attempts
        WHERE org_id = ${orgId} AND id = ${attemptId} FOR UPDATE`);
      const [current] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, orgId), eq(appRunAttempts.id, attemptId),
      )).limit(1);
      if (
        !current
        || current.claim_token !== claimToken
        || (runtime && (current.runtime_session_id !== runtime.session_id
          || current.runtime_binding_id !== authority!.pin.runtime_binding_id
          || current.runtime_epoch !== authority!.pin.runtime_epoch
          || current.runtime_session_epoch !== authority!.pin.session_epoch
          || current.runtime_sequence !== runtime.sequence))
        || !current.lease_expires_at
        || current.lease_expires_at <= (runtime ? this.now() : now)
        || (current.state !== 'claimed' && current.state !== 'provider_call_started')
      ) return false;
      const [renewed] = await tx.update(appRunAttempts).set({
        lease_expires_at: new Date((runtime ? this.now() : now).getTime() + boundedLeaseMs(this.leaseMs)),
        updated_at: now,
      }).where(and(
        eq(appRunAttempts.org_id, orgId),
        eq(appRunAttempts.id, attemptId),
        eq(appRunAttempts.claim_token, claimToken),
      )).returning({ id: appRunAttempts.id });
      return Boolean(renewed);
    });
  }

  #startLeaseHeartbeat(claimed: ClaimedAttempt): () => Promise<void> {
    const controller = new AbortController();
    const task = (async () => {
      while (!controller.signal.aborted) {
        try {
          await delay(Math.max(1, this.heartbeatIntervalMs), undefined, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) return;
          throw error;
        }
        let renewed = false;
        try {
          renewed = await this.renewLease(
            claimed.run.org_id,
            claimed.attempt.id,
            claimed.attempt.claim_token!,
          );
        } catch {
          return;
        }
        if (!renewed) return;
      }
    })();
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      await task;
    };
  }

  async recoverStale(limit = 100): Promise<number> {
    const now = this.now();
    const rows = await db.select({
      org_id: appRunAttempts.org_id,
      run_id: appRunAttempts.run_id,
    }).from(appRunAttempts).where(and(
      inArray(appRunAttempts.state, ['claimed', 'provider_call_started']),
      lte(appRunAttempts.lease_expires_at, now),
    )).orderBy(asc(appRunAttempts.lease_expires_at)).limit(Math.max(1, Math.min(limit, 500)));
    let recovered = 0;
    for (const row of rows) recovered += await this.recoverRun(row.org_id, row.run_id);
    return recovered;
  }

  async recoverRun(orgId: string, runId: string, attemptId?: string, options: AppRunRecoveryOptions = {}): Promise<number> {
    const now = this.now();
    const transaction = options.transaction ?? this.repository.transaction.bind(this.repository);
    const recovered = await transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, orgId, runId);
      if (!run) return 0;
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, orgId),
        eq(appRunAttempts.run_id, runId),
        ...(attemptId ? [eq(appRunAttempts.id, attemptId)] : []),
        inArray(appRunAttempts.state, ['claimed', 'provider_call_started']),
        lte(appRunAttempts.lease_expires_at, now),
      )).orderBy(asc(appRunAttempts.attempt_number)).limit(1);
      if (!attempt) return 0;
      await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${orgId} AND id = ${attempt.id} FOR UPDATE`);
      if (run.state === 'expired' && attempt.state === 'claimed') {
        // Retention can win before lease recovery. Input was never released;
        // settle its abandoned claim without changing the terminal Run.
        await tx.update(appRunAttempts).set({ state: 'failed', error_code: 'APP_RUN_EXPIRED', updated_at: now })
          .where(and(eq(appRunAttempts.org_id, orgId), eq(appRunAttempts.id, attempt.id)));
        await this.repository.appendEvent(tx, { id: crypto.randomUUID(), org_id: orgId, run_id: runId,
          event_type: 'attempt_terminal', payload: { attempt_id: attempt.id, state: 'failed' }, now });
        await this.#writeAttemptReceipt(tx, run, attempt.id, 'failed', now, 'APP_RUN_EXPIRED', false,
          { provider_call_attempted: false });
      } else if (attempt.state === 'provider_call_started' && attempt.provider_call_finished_at && attempt.safe_outcome) {
        await this.#finalizeKnownInTransaction(tx, run, attempt, now);
      } else {
        await this.#recoverUnknownInTransaction(tx, run, attempt, now);
      }
      if (options.onRecovered) {
        const [current] = await tx.select(safeRunSelection).from(appRuns).where(and(eq(appRuns.org_id, orgId), eq(appRuns.id, runId))).limit(1);
        if (current) await options.onRecovered(tx, current);
      }
      return 1;
    });
    if (recovered > 0 && !options.onRecovered) {
      const run = await this.repository.inspect(orgId, runId);
      if (run) await this.#projectState(run);
    }
    return recovered;
  }

  async #claim(
    orgId: string,
    runId: string,
    attemptId: string,
    workerId: string,
    runtime?: Readonly<{ session_id: string; token_hash: string }>,
  ): Promise<ClaimedAttempt | null> {
    const now = this.now();
    return this.repository.transaction(async (tx) => {
      let run = await this.repository.lockRun(tx, orgId, runId);
      if (!run || (runtime ? run.provider_kind !== 'app_runtime'
        : !['mcp', 'native'].includes(run.provider_kind))) return null;
      if (run.provider_kind === 'native') await tx.execute(sql`SELECT id FROM app_run_attempts
        WHERE org_id = ${orgId} AND run_id = ${runId} AND id = ${attemptId} FOR UPDATE`);
      const runtimeAuthority = runtime ? await loadLiveRuntimeAuthority(
        tx, orgId, runtime.session_id, runtime.token_hash, this.now, runId) : null;
      if (runtime && (!runtimeAuthority
        || !await runtimeRunMatchesAuthority(tx, orgId, runId, runtimeAuthority))) return null;
      if (
        !run.execution_released_at
        || ['succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'].includes(run.state)
        || (!runtime && !await this.executionAuthorizer.authorizeExecution({
          org_id: orgId, run, tx, stage: 'claim', now,
        }))
      ) return null;
      if (run.input_expires_at <= (runtime ? this.now() : now)) {
        run = await this.repository.transition(tx, {
          run, state: 'expired', now, error_code: 'APP_RUN_EXPIRED',
          safe_outcome: AppRunSafeOutcomeSchema.parse({
            success: false, provider_call_attempted: false,
            result_status: 'unavailable', error_code: 'APP_RUN_EXPIRED',
          }),
        });
        return null;
      }
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, orgId),
        eq(appRunAttempts.run_id, runId),
        eq(appRunAttempts.id, attemptId),
      )).limit(1);
      if (!attempt || attempt.state !== 'pending') return null;
      let runtimeSequence: number | null = null;
      if (runtimeAuthority) {
        const [session] = await tx.update(appRuntimeSessions).set({
          next_sequence: sql`${appRuntimeSessions.next_sequence} + 1`,
          updated_at: now,
        }).where(and(eq(appRuntimeSessions.org_id, orgId),
          eq(appRuntimeSessions.id, runtimeAuthority.pin.session_id)))
          .returning({ next_sequence: appRuntimeSessions.next_sequence });
        if (!session) return null;
        runtimeSequence = session.next_sequence - 1;
      }
      const claimToken = crypto.randomUUID();
      const [claimed] = await tx.update(appRunAttempts).set({
        state: 'claimed',
        claim_owner: workerId,
        claim_token: claimToken,
        ...(runtimeAuthority ? {
          runtime_binding_id: runtimeAuthority.pin.runtime_binding_id,
          runtime_session_id: runtimeAuthority.pin.session_id,
          runtime_session_epoch: runtimeAuthority.pin.session_epoch,
          runtime_epoch: runtimeAuthority.pin.runtime_epoch,
          runtime_sequence: runtimeSequence!,
        } : {}),
        claimed_at: now,
        lease_expires_at: new Date((runtime ? this.now() : now).getTime() + boundedLeaseMs(this.leaseMs)),
        updated_at: now,
      }).where(and(
        eq(appRunAttempts.org_id, orgId),
        eq(appRunAttempts.id, attempt.id),
        eq(appRunAttempts.state, 'pending'),
      )).returning();
      if (!claimed) return null;
      await this.repository.appendEvent(tx, {
        id: crypto.randomUUID(), org_id: orgId, run_id: runId,
        event_type: 'attempt_claimed', payload: { attempt_id: claimed.id }, now,
      });
      return { run, attempt: claimed };
    });
  }

  /** Provider start, native effect, retained result and signed receipt commit together.
   * A transport failure may have lost COMMIT's response: no effect retry occurs
   * here; redelivery observes the original Run and retained exact result. */
  async #executeNativeAtomic(claimed: ClaimedAttempt, signal?: AbortSignal): Promise<void> {
    await nativeExecutionTransaction(async tx => {
      let run = await this.repository.lockRun(tx, claimed.run.org_id, claimed.run.id);
      if (!run || run.provider_kind !== 'native') return;
      const [attempt] = await tx.select().from(appRunAttempts).where(and(eq(appRunAttempts.org_id, run.org_id),
        eq(appRunAttempts.run_id, run.id), eq(appRunAttempts.id, claimed.attempt.id))).limit(1).for('update');
      if (!attempt || attempt.state !== 'claimed' || attempt.claim_token !== claimed.attempt.claim_token
        || !attempt.lease_expires_at || attempt.lease_expires_at <= this.now()
        || !run.execution_released_at || !['pending', 'pending_approval'].includes(run.state) || run.cancel_requested_at
        || run.input_expires_at <= this.now() || run.result_expires_at <= this.now()) return;
      const pin = await this.repository.findRuntimeReviewPin(tx, run.org_id, run.id);
      if (!pin?.origin_native_binding_id) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const authority = pin.origin_public_endpoint_id && pin.origin_public_ingress_id
        ? await captureReviewedPublicNativeInTransaction(tx, { org_id: run.org_id,
          endpoint_id: pin.origin_public_endpoint_id, ingress_id: pin.origin_public_ingress_id })
        : await captureReviewedNativeInTransaction(tx, { org_id: run.org_id,
          user_id: run.execution_actor_id, native_binding_id: pin.origin_native_binding_id });
      if (!await this.executionAuthorizer.authorizeExecution({ org_id: run.org_id, run, tx, stage: 'provider_call', now: this.now() }))
        throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const input = await this.secretRepository.readInput(run.org_id, run.id, tx);
      if (!isAppNativeCalendarEnabled() || signal?.aborted || attempt.lease_expires_at <= this.now()
        || run.input_expires_at <= this.now()) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
      const now = this.now();
      await tx.update(appRunAttempts).set({ state: 'provider_call_started', provider_call_started_at: now, updated_at: now })
        .where(and(eq(appRunAttempts.org_id, run.org_id), eq(appRunAttempts.id, attempt.id), eq(appRunAttempts.claim_token, attempt.claim_token!)));
      run = await this.repository.transition(tx, { run, state: 'running', now });
      await this.repository.appendEvent(tx, { id: crypto.randomUUID(), org_id: run.org_id, run_id: run.id,
        event_type: 'provider_call_started', payload: { attempt_id: attempt.id }, now });
      const output = await executeNativeCalendarInTransaction(tx, { run, authority, input,
        secretRepository: this.secretRepository, secrets: this.secrets, now: this.now });
      const envelope = AppRunRetainedProviderResultSchema.parse({ schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
        provider_succeeded: true, output });
      assertAppRunOutputWithinBudget(envelope);
      await this.secretRepository.insertOutput(tx, { org_id: run.org_id, run_id: run.id, attempt_id: attempt.id,
        value: envelope, expires_at: run.result_expires_at });
      const outcome = AppRunSafeOutcomeSchema.parse({ success: true, provider_call_attempted: true, result_status: 'retained' });
      await tx.update(appRunAttempts).set({ provider_call_finished_at: now, safe_outcome: outcome, updated_at: now })
        .where(and(eq(appRunAttempts.org_id, run.org_id), eq(appRunAttempts.id, attempt.id)));
      await this.#finalizeKnownInTransaction(tx, run, { ...attempt, provider_call_started_at: now,
        provider_call_finished_at: now, safe_outcome: outcome }, now);
      // Mutable human kind and clocks are not protected by the participant/App
      // locks. Check them after every event, result and receipt write has waited,
      // without acquiring user locks in reverse order. Failure rolls back the
      // native effect and its entire terminal ledger together.
      if (!await nativeFinalAuthorityIsCurrent(tx, authority.participants, { clock: this.now,
        expires_at: [attempt.lease_expires_at, run.input_expires_at, run.result_expires_at], signal }))
        throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
    }, signal);
  }

  async #createAttempt(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    now: Date,
  ): Promise<typeof appRunAttempts.$inferSelect | null> {
    const [last] = await tx.select().from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, run.org_id), eq(appRunAttempts.run_id, run.id),
    )).orderBy(desc(appRunAttempts.attempt_number)).limit(1);
    const attemptNumber = (last?.attempt_number ?? 0) + 1;
    if (attemptNumber > run.attempt_limit) return null;
    const providerKey = run.retry_class === 'idempotent_with_key'
      ? appRunProviderIdempotencyKey(run.id)
      : null;
    const providerFingerprint = providerKey
      ? this.secrets.fingerprintText('idempotency', providerKey)
      : null;
    const [attempt] = await tx.insert(appRunAttempts).values({
      id: crypto.randomUUID(), org_id: run.org_id, run_id: run.id,
      attempt_number: attemptNumber,
      retry_of_attempt_id: last?.id ?? null,
      state: 'pending',
      provider_idempotency_key_version: providerFingerprint?.key_version ?? null,
      provider_idempotency_fingerprint: providerFingerprint?.fingerprint ?? null,
      created_at: now, updated_at: now,
    }).returning();
    if (!attempt) return null;
    await this.repository.appendEvent(tx, {
      id: crypto.randomUUID(), org_id: run.org_id, run_id: run.id,
      event_type: 'attempt_created', payload: { attempt_id: attempt.id, attempt_number: attemptNumber }, now,
    });
    await this.attemptQueue.enqueue(tx, run.org_id, run.id, attempt.id);
    return attempt;
  }

  async #markProviderCallStarted(claimed: ClaimedAttempt,
    runtime?: Readonly<{ session_id: string; token_hash: string }>): Promise<Readonly<{
    dispatch_pin?: AppRunProviderDispatchPin;
  }> | null> {
    const now = this.now();
    return this.repository.transaction(async (tx) => {
      let run = await this.repository.lockRun(tx, claimed.run.org_id, claimed.run.id);
      if (!run || (runtime ? run.provider_kind !== 'app_runtime'
        : run.provider_kind !== 'mcp')) return null;
      const authority = runtime ? await loadLiveRuntimeAuthority(tx, claimed.run.org_id,
        runtime.session_id, runtime.token_hash, this.now, claimed.run.id) : null;
      if (runtime && (!authority
        || !await runtimeRunMatchesAuthority(tx, run.org_id, run.id, authority))) return null;
      if (
        !run.execution_released_at
        || run.state === 'cancelled'
        || (runtime && (run.cancel_requested_at || run.input_expires_at <= this.now()))
        || (!runtime && !await this.executionAuthorizer.authorizeExecution({
          org_id: run.org_id, run, tx, stage: 'provider_call', now,
        }))
      ) return null;
      const dispatchPin = run.origin_kind === 'app' && !runtime
        ? await this.repository.loadAppProviderDispatchPin(tx, run.org_id, run.id)
        : undefined;
      if (run.origin_kind === 'app' && !runtime && !dispatchPin) return null;
      await tx.execute(sql`SELECT id FROM app_run_attempts
        WHERE org_id = ${claimed.run.org_id} AND id = ${claimed.attempt.id} FOR UPDATE`);
      const [current] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, claimed.run.org_id),
        eq(appRunAttempts.id, claimed.attempt.id),
      )).limit(1);
      if (
        !current
        || (runtime ? !['claimed', 'provider_call_started'].includes(current.state)
          : current.state !== 'claimed')
        || current.claim_token !== claimed.attempt.claim_token
        || (runtime && (current.runtime_session_id !== runtime.session_id
          || current.runtime_binding_id !== authority!.pin.runtime_binding_id
          || current.runtime_epoch !== authority!.pin.runtime_epoch
          || current.runtime_session_epoch !== authority!.pin.session_epoch
          || current.runtime_sequence !== claimed.attempt.runtime_sequence))
        || !current.lease_expires_at
        || current.lease_expires_at <= (runtime ? this.now() : now)
      ) return null;
      if (runtime && current.state === 'provider_call_started') return Object.freeze({});
      const [attempt] = await tx.update(appRunAttempts).set({
        state: 'provider_call_started', provider_call_started_at: now, updated_at: now,
      }).where(and(
        eq(appRunAttempts.org_id, claimed.run.org_id),
        eq(appRunAttempts.id, claimed.attempt.id),
        eq(appRunAttempts.state, 'claimed'),
        eq(appRunAttempts.claim_token, claimed.attempt.claim_token!),
      )).returning();
      if (!attempt) return null;
      if (run.state === 'pending' || run.state === 'pending_approval') {
        run = await this.repository.transition(tx, { run, state: 'running', now });
      }
      await this.repository.appendEvent(tx, {
        id: crypto.randomUUID(), org_id: run.org_id, run_id: run.id,
        event_type: 'provider_call_started', payload: { attempt_id: attempt.id }, now,
      });
      return Object.freeze({ ...(dispatchPin ? { dispatch_pin: dispatchPin } : {}) });
    });
  }

  async #knownOutcome(
    run: AppRunSafeView,
    result: Exclude<AppRunProviderExecutionResult, { status: 'indeterminate' }>,
  ): Promise<AppRunSafeOutcome> {
    if (result.status === 'not_attempted') {
      return AppRunSafeOutcomeSchema.parse({
        success: false, provider_call_attempted: false,
        result_status: 'unavailable',
        error_code: result.error_code ?? 'APP_RUN_PROVIDER_UNAVAILABLE',
      });
    }
    let retained = run.result_expires_at > this.now();
    if (retained) {
      try {
        const envelope = AppRunRetainedProviderResultSchema.parse({
          schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
          provider_succeeded: result.provider_succeeded,
          output: result.output,
        });
        assertAppRunOutputWithinBudget(envelope);
      } catch {
        retained = false;
      }
    }
    return AppRunSafeOutcomeSchema.parse({
      success: result.provider_succeeded, provider_call_attempted: true,
      result_status: retained ? 'retained' : 'unavailable',
      ...(result.provider_succeeded ? {} : { error_code: 'APP_RUN_PROVIDER_ERROR' }),
    });
  }

  async #persistKnownResult(
    orgId: string,
    runId: string,
    attemptId: string,
    claimToken: string,
    result: Exclude<AppRunProviderExecutionResult, { status: 'indeterminate' }>,
    outcome: AppRunSafeOutcome,
  ): Promise<void> {
    let lastError: unknown;
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        await this.repository.transaction(async (tx) => {
          const run = await this.repository.lockRun(tx, orgId, runId);
          if (!run) throw new AppRunError('APP_RUN_ACCESS_DENIED');
          await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${orgId} AND id = ${attemptId} FOR UPDATE`);
          const [attempt] = await tx.select().from(appRunAttempts).where(and(
            eq(appRunAttempts.org_id, orgId), eq(appRunAttempts.id, attemptId),
          )).limit(1);
          if (
            !attempt
            || attempt.state !== 'provider_call_started'
            || attempt.claim_token !== claimToken
          ) return;
          if (attempt.provider_call_finished_at && attempt.safe_outcome) return;
          if (result.status === 'returned' && outcome.result_status === 'retained') {
            const envelope = AppRunRetainedProviderResultSchema.parse({
              schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
              provider_succeeded: result.provider_succeeded,
              output: result.output,
            });
            await this.secretRepository.insertOutput(tx, {
              org_id: orgId, run_id: runId, attempt_id: attemptId,
              value: envelope, expires_at: run.result_expires_at,
            });
          }
          await tx.update(appRunAttempts).set({
            provider_call_finished_at: this.now(), safe_outcome: outcome, updated_at: this.now(),
          }).where(and(
            eq(appRunAttempts.org_id, orgId),
            eq(appRunAttempts.id, attemptId),
            eq(appRunAttempts.claim_token, claimToken),
          ));
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async #finalizeKnownResult(
    orgId: string,
    runId: string,
    attemptId: string,
    claimToken: string,
  ): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, orgId, runId);
      if (!run) return;
      await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${orgId} AND id = ${attemptId} FOR UPDATE`);
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, orgId), eq(appRunAttempts.id, attemptId),
      )).limit(1);
      if (
        !attempt
        || attempt.state !== 'provider_call_started'
        || attempt.claim_token !== claimToken
        || !attempt.safe_outcome
      ) return;
      await this.#finalizeKnownInTransaction(tx, run, attempt, this.now());
    });
  }

  async #finalizeKnownInTransaction(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    attempt: typeof appRunAttempts.$inferSelect,
    now: Date,
    extraReceiptFacts?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    const outcome = AppRunSafeOutcomeSchema.parse(attempt.safe_outcome);
    const attemptState = outcome.success ? 'succeeded' : 'failed';
    await tx.update(appRunAttempts).set({
      state: attemptState,
      error_code: outcome.error_code ?? null,
      updated_at: now,
    }).where(and(eq(appRunAttempts.org_id, run.org_id), eq(appRunAttempts.id, attempt.id)));
    await this.repository.appendEvent(tx, {
      id: crypto.randomUUID(), org_id: run.org_id, run_id: run.id,
      event_type: 'attempt_terminal', payload: { attempt_id: attempt.id, state: attemptState }, now,
    });
    const terminalRun = await this.repository.transition(tx, {
      run, state: outcome.success ? 'succeeded' : 'failed', safe_outcome: outcome,
      error_code: outcome.error_code, now,
    });
    await this.#writeAttemptReceipt(tx, terminalRun, attempt.id, attemptState, now,
      outcome.error_code, false, extraReceiptFacts);
  }

  async #settleBeforeCallFailure(claimed: ClaimedAttempt, code: 'APP_RUN_EXPIRED'): Promise<void> {
    const now = this.now();
    await this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, claimed.run.org_id, claimed.run.id);
      if (!run) return;
      await tx.update(appRunAttempts).set({ state: 'failed', error_code: code, updated_at: now })
        .where(and(
          eq(appRunAttempts.org_id, run.org_id),
          eq(appRunAttempts.id, claimed.attempt.id),
          eq(appRunAttempts.claim_token, claimed.attempt.claim_token!),
        ));
      await this.repository.appendEvent(tx, {
        id: crypto.randomUUID(),
        org_id: run.org_id,
        run_id: run.id,
        event_type: 'attempt_terminal',
        payload: { attempt_id: claimed.attempt.id, state: 'failed' },
        now,
      });
      const terminalRun = await this.repository.transition(tx, {
        run, state: 'expired', now, error_code: code,
        safe_outcome: AppRunSafeOutcomeSchema.parse({
          success: false, provider_call_attempted: false,
          result_status: 'unavailable', error_code: code,
        }),
      });
      await this.#writeAttemptReceipt(
        tx,
        terminalRun,
        claimed.attempt.id,
        'failed',
        now,
        code,
      );
    });
  }

  async #settleIndeterminate(
    orgId: string,
    runId: string,
    attemptId: string,
    claimToken: string,
  ): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, orgId, runId);
      if (!run) return;
      await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id = ${orgId} AND id = ${attemptId} FOR UPDATE`);
      const [attempt] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, orgId), eq(appRunAttempts.id, attemptId),
      )).limit(1);
      if (
        !attempt
        || attempt.state !== 'provider_call_started'
        || attempt.claim_token !== claimToken
      ) return;
      await this.#recoverUnknownInTransaction(tx, run, attempt, this.now());
    });
  }

  async #recoverUnknownInTransaction(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    attempt: typeof appRunAttempts.$inferSelect,
    now: Date,
    runtimeResultHmac?: string,
  ): Promise<void> {
    const nativeUnstarted = run.provider_kind === 'native' && attempt.state === 'claimed'
      && attempt.provider_call_started_at === null && run.execution_released_at !== null
      && Boolean(attempt.lease_expires_at && attempt.lease_expires_at <= now)
      && ['pending', 'pending_approval'].includes(run.state);
    if (nativeUnstarted) {
      // Native provider-start/effect/terminal writes rolled back together. The
      // existing state graph needs a running bridge to terminalize this claim.
      // started_at records recovery processing, never a provider effect.
      run = await this.repository.transition(tx, { run, state: 'running', now, error_code: 'APP_RUN_PROVIDER_UNAVAILABLE' });
    }
    const decision = classifyAppRunCrashRecovery({
      retry_class: run.retry_class,
      provider_call_started: attempt.state === 'provider_call_started',
      provider_result_known: Boolean(attempt.provider_call_finished_at && attempt.safe_outcome),
      provider_idempotency_key_bound: Boolean(attempt.provider_idempotency_fingerprint),
    });
    const terminalAttemptState = attempt.state === 'claimed' ? 'failed' : 'unknown_outcome';
    await tx.update(appRunAttempts).set({
      state: terminalAttemptState,
      error_code: terminalAttemptState === 'unknown_outcome'
        ? 'APP_RUN_UNKNOWN_OUTCOME'
        : 'APP_RUN_PROVIDER_UNAVAILABLE',
      ...(runtimeResultHmac ? { runtime_result_hmac: runtimeResultHmac } : {}),
      updated_at: now,
    }).where(and(eq(appRunAttempts.org_id, run.org_id), eq(appRunAttempts.id, attempt.id)));
    await this.repository.appendEvent(tx, {
      id: crypto.randomUUID(), org_id: run.org_id, run_id: run.id,
      event_type: 'attempt_terminal',
      payload: { attempt_id: attempt.id, state: terminalAttemptState,
        ...(nativeUnstarted ? { recovery_reason: 'native_unstarted_claim_expired', provider_call_attempted: false } : {}) }, now,
    });
    if (!nativeUnstarted && decision === 'create_retry_attempt'
      && (run.provider_kind !== 'app_runtime' || attempt.state === 'claimed')
      && attempt.attempt_number < run.attempt_limit && run.input_expires_at > now) {
      await this.#createAttempt(tx, run, now);
      await this.#writeAttemptReceipt(
        tx,
        run,
        attempt.id,
        terminalAttemptState,
        now,
        terminalAttemptState === 'unknown_outcome'
          ? 'APP_RUN_UNKNOWN_OUTCOME'
          : 'APP_RUN_PROVIDER_UNAVAILABLE',
        true,
      );
      return;
    }
    if (attempt.state === 'claimed') {
      const terminalRun = await this.repository.transition(tx, {
        run, state: 'failed', now, error_code: 'APP_RUN_PROVIDER_UNAVAILABLE',
        safe_outcome: AppRunSafeOutcomeSchema.parse({
          success: false, provider_call_attempted: false,
          result_status: 'unavailable', error_code: 'APP_RUN_PROVIDER_UNAVAILABLE',
        }),
      });
      await this.#writeAttemptReceipt(
        tx,
        terminalRun,
        attempt.id,
        terminalAttemptState,
        now,
        'APP_RUN_PROVIDER_UNAVAILABLE',
      );
      return;
    }
    const terminalRun = await this.repository.transition(tx, {
      run, state: 'unknown_outcome', now, error_code: 'APP_RUN_UNKNOWN_OUTCOME',
      safe_outcome: AppRunSafeOutcomeSchema.parse({
        success: false,
        provider_call_attempted: attempt.state === 'provider_call_started',
        result_status: 'unavailable',
        error_code: 'APP_RUN_UNKNOWN_OUTCOME',
      }),
    });
    await this.#writeAttemptReceipt(
      tx,
      terminalRun,
      attempt.id,
      terminalAttemptState,
      now,
      'APP_RUN_UNKNOWN_OUTCOME',
    );
  }

  async #writeAttemptReceipt(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    attemptId: string,
    attemptState: 'succeeded' | 'failed' | 'cancelled' | 'unknown_outcome',
    occurredAt: Date,
    errorCode?: string,
    retryScheduled = false,
    extraFacts?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    await this.receiptWriter.write(tx, {
      receipt_key: `attempt-terminal:${attemptId}`,
      receipt_kind: 'attempt_terminal',
      run,
      attempt_id: attemptId,
      facts: {
        attempt_state: attemptState,
        retry_scheduled: retryScheduled,
        ...(errorCode ? { error_code: errorCode } : {}),
        ...extraFacts,
      },
      occurred_at: occurredAt,
    });
  }

  async #projectState(run: AppRunSafeView): Promise<void> {
    const kind = run.state === 'unknown_outcome'
      ? 'unknown_outcome' as const
      : run.state === 'failed'
        ? 'failure' as const
        : null;
    if (!kind) return;
    try {
      await this.attention.projectRunState(run, kind);
    } catch (error) {
      console.warn('[app-runs] terminal Attention projection failed:',
        error instanceof Error ? error.message : 'unknown error');
    }
  }
}
