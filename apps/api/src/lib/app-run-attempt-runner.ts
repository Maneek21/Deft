import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { appRunAttempts, appRuntimeSessions } from '@deft/db/schema';
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
  ) {}

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
        provider_kind: claimed.run.provider_kind,
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
      return run ? this.scheduleInTransaction(tx, run, now) : null;
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
      tx, input.org_id, input.session_id, input.token_hash, this.now));
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
      const authority = await loadLiveRuntimeAuthority(tx, input.org_id,
        input.session_id, input.token_hash, this.now);
      if (!authority) return null;
      const run = await this.repository.lockRun(tx, input.org_id, input.run_id);
      if (!run || run.state !== 'running' || run.cancel_requested_at
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
      const authority = await loadLiveRuntimeAuthority(tx, input.org_id,
        result.session_id, input.token_hash, this.now);
      if (!authority) return false;
      const run = await this.repository.lockRun(tx, input.org_id, result.run_id);
      if (!run || run.provider_kind !== 'app_runtime') return false;
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
        || authority.pin.session_epoch !== attempt.runtime_session_epoch
        || !await runtimeRunMatchesAuthority(tx, input.org_id, result.run_id, authority)) return false;
      if (attempt.runtime_result_hmac) return replayDigests.has(attempt.runtime_result_hmac);
      if (attempt.state !== 'provider_call_started' || !attempt.lease_expires_at
        || attempt.lease_expires_at <= this.now()) return false;
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
      const authority = await loadLiveRuntimeAuthority(tx, input.org_id,
        input.session_id, input.token_hash, this.now);
      if (!authority) return null;
      const run = await this.repository.lockRun(tx, input.org_id, input.run_id);
      if (!run || run.provider_kind !== 'app_runtime') return null;
      if (!authority || !await runtimeRunMatchesAuthority(tx, input.org_id, input.run_id, authority)) return null;
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

  async renewLease(orgId: string, attemptId: string, claimToken: string,
    runtime?: Readonly<{ run_id: string; session_id: string; token_hash: string; sequence: number }>,
  ): Promise<boolean> {
    const now = this.now();
    const [identity] = await db.select({ run_id: appRunAttempts.run_id }).from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, orgId), eq(appRunAttempts.id, attemptId),
    )).limit(1);
    if (!identity) return false;
    return this.repository.transaction(async (tx) => {
      const authority = runtime ? await loadLiveRuntimeAuthority(tx, orgId,
        runtime.session_id, runtime.token_hash, this.now) : null;
      if (runtime && !authority) return false;
      const run = await this.repository.lockRun(tx, orgId, identity.run_id);
      if (!run || (runtime ? run.provider_kind !== 'app_runtime' : run.provider_kind !== 'mcp')) return false;
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

  async recoverRun(orgId: string, runId: string, attemptId?: string): Promise<number> {
    const now = this.now();
    const recovered = await this.repository.transaction(async (tx) => {
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
      if (attempt.state === 'provider_call_started' && attempt.provider_call_finished_at && attempt.safe_outcome) {
        await this.#finalizeKnownInTransaction(tx, run, attempt, now);
        return 1;
      }
      await this.#recoverUnknownInTransaction(tx, run, attempt, now);
      return 1;
    });
    if (recovered > 0) {
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
      const runtimeAuthority = runtime ? await loadLiveRuntimeAuthority(
        tx, orgId, runtime.session_id, runtime.token_hash, this.now) : null;
      if (runtime && !runtimeAuthority) return null;
      let run = await this.repository.lockRun(tx, orgId, runId);
      if (
        !run
        || (runtime ? (
          run.provider_kind !== 'app_runtime'
          || !runtimeAuthority
          || !await runtimeRunMatchesAuthority(tx, orgId, runId, runtimeAuthority)
        ) : run.provider_kind !== 'mcp')
        || !run.execution_released_at
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
      const authority = runtime ? await loadLiveRuntimeAuthority(tx, claimed.run.org_id,
        runtime.session_id, runtime.token_hash, this.now) : null;
      if (runtime && !authority) return null;
      let run = await this.repository.lockRun(tx, claimed.run.org_id, claimed.run.id);
      if (
        !run
        || (runtime ? (run.provider_kind !== 'app_runtime' || !authority
          || !await runtimeRunMatchesAuthority(tx, run.org_id, run.id, authority))
          : run.provider_kind !== 'mcp')
        || !run.execution_released_at
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
    await this.#writeAttemptReceipt(tx, terminalRun, attempt.id, attemptState, now, outcome.error_code);
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
      payload: { attempt_id: attempt.id, state: terminalAttemptState }, now,
    });
    if (decision === 'create_retry_attempt'
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
