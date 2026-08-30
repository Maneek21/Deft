import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { appRunAttempts } from '@deft/db/schema';
import {
  APP_RUN_CONTRACT_VERSIONS,
  AppRunRetainedProviderResultSchema,
  AppRunSafeOutcomeSchema,
  assertAppRunOutputWithinBudget,
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
import { PostgresAppRunRepository, type AppRunSafeView, type AppRunTransaction } from './app-run-repository.js';
import { AppRunSecretRepository } from './app-run-secret-repository.js';
import type { AppRunSecretService } from './app-run-secrets.js';

type ClaimedAttempt = Readonly<{
  run: AppRunSafeView;
  attempt: typeof appRunAttempts.$inferSelect;
}>;

function providerIdempotencyKey(runId: string): string {
  return createHash('sha256')
    .update('deft.app_run.provider_idempotency.v1\0')
    .update(runId)
    .digest('base64url');
}

function boundedLeaseMs(value: number): number {
  return Math.max(1_000, Math.min(value, 15 * 60_000));
}

export class AppRunAttemptRunner {
  constructor(
    private readonly repository: PostgresAppRunRepository,
    private readonly secretRepository: AppRunSecretRepository,
    private readonly secrets: AppRunSecretService,
    private readonly executor: AppRunProviderExecutor,
    private readonly executionAuthorizer: AppRunExecutionAuthorizer = denyAllAppRunExecutionAuthorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = 60_000,
    private readonly heartbeatIntervalMs = Math.max(250, Math.floor(boundedLeaseMs(leaseMs) / 3)),
  ) {}

  async run(
    orgId: string,
    runId: string,
    attemptId: string,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<AppRunSafeView> {
    await this.recoverRun(orgId, runId, attemptId);
    const claimed = await this.#claim(orgId, runId, attemptId, workerId);
    if (!claimed) return this.repository.inspect(orgId, runId).then((run) => {
      if (!run) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      return run;
    });

    const input = await this.secretRepository.readInput(orgId, runId);
    if (input === null) {
      await this.#settleBeforeCallFailure(claimed, 'APP_RUN_EXPIRED');
      return this.repository.inspect(orgId, runId).then((run) => run!);
    }
    const boundaryCommitted = await this.#markProviderCallStarted(claimed);
    if (!boundaryCommitted) return this.repository.inspect(orgId, runId).then((run) => run!);

    const stableProviderKey = claimed.run.retry_class === 'idempotent_with_key'
      ? providerIdempotencyKey(runId)
      : undefined;
    const stopHeartbeat = this.#startLeaseHeartbeat(claimed);
    let result: AppRunProviderExecutionResult;
    try {
      result = await this.executor.execute({
        org_id: orgId,
        provider_kind: claimed.run.provider_kind,
        provider_instance_id: claimed.run.provider_instance_id,
        operation_name: claimed.run.operation_name,
        input,
        provider_idempotency_key: stableProviderKey,
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
      return this.repository.inspect(orgId, runId).then((run) => run!);
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
    return this.repository.inspect(orgId, runId).then((run) => run!);
  }

  async prepareAttempt(orgId: string, runId: string): Promise<string | null> {
    const now = this.now();
    return this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, orgId, runId);
      if (
        !run
        || !run.execution_released_at
        || ['succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'].includes(run.state)
        || !await this.executionAuthorizer.authorizeExecution({
          org_id: orgId, run, tx, stage: 'prepare', now,
        })
      ) return null;
      if (run.input_expires_at <= now) return null;
      const [existing] = await tx.select({ id: appRunAttempts.id }).from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, orgId),
        eq(appRunAttempts.run_id, runId),
        inArray(appRunAttempts.state, ['pending', 'claimed', 'provider_call_started']),
      )).orderBy(asc(appRunAttempts.attempt_number)).limit(1);
      if (existing) return existing.id;
      return (await this.#createAttempt(tx, run, now))?.id ?? null;
    });
  }

  async renewLease(orgId: string, attemptId: string, claimToken: string): Promise<boolean> {
    const now = this.now();
    const [identity] = await db.select({ run_id: appRunAttempts.run_id }).from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, orgId), eq(appRunAttempts.id, attemptId),
    )).limit(1);
    if (!identity) return false;
    return this.repository.transaction(async (tx) => {
      if (!await this.repository.lockRun(tx, orgId, identity.run_id)) return false;
      await tx.execute(sql`SELECT id FROM app_run_attempts
        WHERE org_id = ${orgId} AND id = ${attemptId} FOR UPDATE`);
      const [current] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, orgId), eq(appRunAttempts.id, attemptId),
      )).limit(1);
      if (
        !current
        || current.claim_token !== claimToken
        || !current.lease_expires_at
        || current.lease_expires_at <= now
        || (current.state !== 'claimed' && current.state !== 'provider_call_started')
      ) return false;
      const [renewed] = await tx.update(appRunAttempts).set({
        lease_expires_at: new Date(now.getTime() + boundedLeaseMs(this.leaseMs)),
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
    return this.repository.transaction(async (tx) => {
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
  }

  async #claim(
    orgId: string,
    runId: string,
    attemptId: string,
    workerId: string,
  ): Promise<ClaimedAttempt | null> {
    const now = this.now();
    return this.repository.transaction(async (tx) => {
      let run = await this.repository.lockRun(tx, orgId, runId);
      if (
        !run
        || !run.execution_released_at
        || ['succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'].includes(run.state)
        || !await this.executionAuthorizer.authorizeExecution({
          org_id: orgId, run, tx, stage: 'claim', now,
        })
      ) return null;
      if (run.input_expires_at <= now) {
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
      const claimToken = crypto.randomUUID();
      const [claimed] = await tx.update(appRunAttempts).set({
        state: 'claimed',
        claim_owner: workerId,
        claim_token: claimToken,
        claimed_at: now,
        lease_expires_at: new Date(now.getTime() + boundedLeaseMs(this.leaseMs)),
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
      ? providerIdempotencyKey(run.id)
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
    return attempt;
  }

  async #markProviderCallStarted(claimed: ClaimedAttempt): Promise<boolean> {
    const now = this.now();
    return this.repository.transaction(async (tx) => {
      let run = await this.repository.lockRun(tx, claimed.run.org_id, claimed.run.id);
      if (
        !run
        || !run.execution_released_at
        || run.state === 'cancelled'
        || !await this.executionAuthorizer.authorizeExecution({
          org_id: run.org_id, run, tx, stage: 'provider_call', now,
        })
      ) return false;
      await tx.execute(sql`SELECT id FROM app_run_attempts
        WHERE org_id = ${claimed.run.org_id} AND id = ${claimed.attempt.id} FOR UPDATE`);
      const [current] = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, claimed.run.org_id),
        eq(appRunAttempts.id, claimed.attempt.id),
      )).limit(1);
      if (
        !current
        || current.state !== 'claimed'
        || current.claim_token !== claimed.attempt.claim_token
        || !current.lease_expires_at
        || current.lease_expires_at <= now
      ) return false;
      const [attempt] = await tx.update(appRunAttempts).set({
        state: 'provider_call_started', provider_call_started_at: now, updated_at: now,
      }).where(and(
        eq(appRunAttempts.org_id, claimed.run.org_id),
        eq(appRunAttempts.id, claimed.attempt.id),
        eq(appRunAttempts.state, 'claimed'),
        eq(appRunAttempts.claim_token, claimed.attempt.claim_token!),
      )).returning();
      if (!attempt) return false;
      if (run.state === 'pending' || run.state === 'pending_approval') {
        run = await this.repository.transition(tx, { run, state: 'running', now });
      }
      await this.repository.appendEvent(tx, {
        id: crypto.randomUUID(), org_id: run.org_id, run_id: run.id,
        event_type: 'provider_call_started', payload: { attempt_id: attempt.id }, now,
      });
      return true;
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
    await this.repository.transition(tx, {
      run, state: outcome.success ? 'succeeded' : 'failed', safe_outcome: outcome,
      error_code: outcome.error_code, now,
    });
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
      await this.repository.transition(tx, {
        run, state: 'expired', now, error_code: code,
        safe_outcome: AppRunSafeOutcomeSchema.parse({
          success: false, provider_call_attempted: false,
          result_status: 'unavailable', error_code: code,
        }),
      });
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
      updated_at: now,
    }).where(and(eq(appRunAttempts.org_id, run.org_id), eq(appRunAttempts.id, attempt.id)));
    await this.repository.appendEvent(tx, {
      id: crypto.randomUUID(), org_id: run.org_id, run_id: run.id,
      event_type: 'attempt_terminal',
      payload: { attempt_id: attempt.id, state: terminalAttemptState }, now,
    });
    if (decision === 'create_retry_attempt' && attempt.attempt_number < run.attempt_limit && run.input_expires_at > now) {
      await this.#createAttempt(tx, run, now);
      return;
    }
    if (attempt.state === 'claimed') {
      await this.repository.transition(tx, {
        run, state: 'failed', now, error_code: 'APP_RUN_PROVIDER_UNAVAILABLE',
        safe_outcome: AppRunSafeOutcomeSchema.parse({
          success: false, provider_call_attempted: false,
          result_status: 'unavailable', error_code: 'APP_RUN_PROVIDER_UNAVAILABLE',
        }),
      });
      return;
    }
    await this.repository.transition(tx, {
      run, state: 'unknown_outcome', now, error_code: 'APP_RUN_UNKNOWN_OUTCOME',
      safe_outcome: AppRunSafeOutcomeSchema.parse({
        success: false,
        provider_call_attempted: attempt.state === 'provider_call_started',
        result_status: 'unavailable',
        error_code: 'APP_RUN_UNKNOWN_OUTCOME',
      }),
    });
  }
}
