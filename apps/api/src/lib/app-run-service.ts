import { createHash } from 'node:crypto';
import {
  APP_RUN_DEFAULT_ATTEMPT_LIMIT,
  AppRunSafeOutcomeSchema,
  idempotencyDeadline,
  parseAppRunSubmission,
  retentionDeadline,
  type AppRunActor,
  type AppRunErrorCode,
  type AppRunSubmission,
} from '@deft/shared';
import {
  assertAppRunReferencedKeysAvailable,
  type AppRunKeyProvider,
} from './app-run-keyrings.js';
import type { AppRunSecretService } from './app-run-secrets.js';
import {
  denyAllAppRunAuthorizer,
  type AppRunAccessAction,
  type AppRunAuthorizer,
} from './app-run-authorization.js';
import { AppRunError, asAppRunError } from './app-run-errors.js';
import {
  PostgresAppRunRepository,
  appRunActorId,
  type AppRunSafeView,
} from './app-run-repository.js';
import { AppRunSecretRepository } from './app-run-secret-repository.js';
import {
  postgresAppRunApprovalAdapter,
  type AppRunApprovalAdapter,
} from './app-run-approval-adapter.js';

export type AppRunTrustedContext = Readonly<{
  org_id: string;
  initiating_actor: AppRunActor;
  execution_actor: AppRunActor;
}>;

function sameActor(left: AppRunActor, right: AppRunActor): boolean {
  return left.actor_type === right.actor_type && appRunActorId(left) === appRunActorId(right);
}

function derivedSubmissionLock(submission: AppRunSubmission): string {
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
  ]) {
    digest.update(value);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function replayExecutionMatches(run: AppRunSafeView, submission: AppRunSubmission): boolean {
  return run.execution_actor_type === submission.execution_actor.actor_type
    && run.execution_actor_id === appRunActorId(submission.execution_actor)
    && run.origin_kind === submission.origin.origin_kind;
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
  ) {}

  async submit(context: AppRunTrustedContext, rawSubmission: unknown): Promise<AppRunSafeView> {
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
      || submission.origin.origin_kind === 'app'
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
    const lock = derivedSubmissionLock(submission);
    const runId = crypto.randomUUID();
    const inputExpiresAt = retentionDeadline(submission.retention_class, now);
    const resultExpiresAt = retentionDeadline(submission.retention_class, now);
    const idempotencyExpiresAt = idempotencyDeadline(submission.retention_class, now);

    return this.repository.transaction(async (tx) => {
      await this.repository.acquireSubmissionLock(tx, lock);
      const replay = await this.repository.findReplay(tx, submission, replayCandidates, now);
      if (replay) {
        const sameInput = inputCandidates.some((candidate) =>
          candidate.key_version === replay.input_fingerprint_key_version
          && candidate.fingerprint === replay.input_fingerprint);
        if (!sameInput || !replayExecutionMatches(replay, submission)) {
          throw new AppRunError('APP_RUN_IDEMPOTENCY_CONFLICT');
        }
        const { input_fingerprint: _fingerprint, input_fingerprint_key_version: _version, ...safe } = replay;
        return safe;
      }
      const snapshot = await this.repository.findProviderSnapshot(tx, submission);
      if (!snapshot) throw new AppRunError('APP_RUN_PROVIDER_UNAVAILABLE');
      const run = await this.repository.insertRun(tx, {
        id: runId,
        submission,
        provider_snapshot_id: snapshot.id,
        idempotency,
        input_fingerprint: inputFingerprint,
        input_expires_at: inputExpiresAt,
        result_expires_at: resultExpiresAt,
        idempotency_expires_at: idempotencyExpiresAt,
        attempt_limit: APP_RUN_DEFAULT_ATTEMPT_LIMIT,
        now,
      });
      await this.secretRepository.insertInput(tx, {
        org_id: submission.org_id,
        run_id: runId,
        value: submission.input,
        expires_at: inputExpiresAt,
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
      return run;
    });
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
    return this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, orgId, runId);
      if (!run || run.state !== 'unknown_outcome') {
        throw new AppRunError('APP_RUN_ILLEGAL_TRANSITION');
      }
      const errorCode: AppRunErrorCode | undefined = resolution === 'failed'
        ? 'APP_RUN_PROVIDER_ERROR'
        : undefined;
      return this.repository.transition(tx, {
        run, state: resolution, actor, now: this.now(), error_code: errorCode,
        event_type: 'reconciliation_recorded',
        safe_outcome: AppRunSafeOutcomeSchema.parse({
          success: resolution === 'succeeded',
          provider_call_attempted: true,
          result_status: 'unavailable',
          ...(errorCode ? { error_code: errorCode } : {}),
        }),
      });
    });
  }

  async result(orgId: string, runId: string, actor: AppRunActor): Promise<Readonly<{
    run: AppRunSafeView;
    value: unknown;
  }>> {
    const run = await this.requiredRun(orgId, runId);
    await this.assertAuthorized('result', orgId, actor, run);
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
