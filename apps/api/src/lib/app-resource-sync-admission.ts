import { SyncRequestV2Schema } from '@deft/app-kit';
import { loadLiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import { buildAttachmentSyncAuthorizationSnapshot } from './app-attachment-sync-run.js';
import { attachmentFinalAuthorityIsCurrent } from './app-attachment-authority.js';
import { parseAttachmentConsentPolicy } from './app-attachment-policy.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appRuns, appRunAttempts, appAttachmentStages, appSyncCheckpoints, appSyncIntents } from '@deft/db/schema';
import { APP_RUN_CONTRACT_VERSIONS, APP_RUN_DEFAULT_ATTEMPT_LIMIT,
  AppRunSafePreviewSchema,
  idempotencyDeadline, retentionDeadline } from '@deft/shared';
import { parseSyncRequest } from '@deft/app-kit/experimental/resource-sync';
import { AppError } from './app-errors.js';
import { loadLiveResourceSyncBindingAuthority } from './app-resource-sync-authority.js';
import { buildResourceSyncAuthorizationSnapshot } from './app-resource-sync-authorization.js';
import { APP_RESOURCE_SYNC_HOST_POLICY } from './app-resource-sync-policy.js';
import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import { PostgresAppRunRepository, safeRunSelection,
  type AppRunSafeView, type AppRunTransaction } from './app-run-repository.js';
import { AppRunSecretRepository } from './app-run-secret-repository.js';
import { AppRunSecretService } from './app-run-secrets.js';

const HostTargetSchema = z.strictObject({ org_id: z.string().uuid(),
  resource_binding_id: z.string().uuid() });
const unavailable = () => new AppError('Resource sync authority unavailable', 'APP_ACCESS_DENIED', 403);

const AdmissionLimitsSchema = z.strictObject({
  lock_timeout_ms: z.number().int().min(1).max(5_000),
  statement_timeout_ms: z.number().int().min(1).max(10_000),
  deadline_at: z.date(),
});
export type ResourceSyncAdmissionLimits = z.infer<typeof AdmissionLimitsSchema> & {
  signal?: AbortSignal;
};

export interface ResourceSyncAttemptScheduler {
  scheduleResourceSyncInTransaction(tx: AppRunTransaction, run: AppRunSafeView,
    now: Date): Promise<string | null>;
}
export type ResourceSyncAdmissionResult = Readonly<
  | { state: 'created'; run_id: string; attempt_id: string }
  | { state: 'existing'; run_id: string }
  | { state: 'blocked'; reason: 'cursor_requires_recovery' }
  | { state: 'not_due'; due_at: string }
>;

/** Host-only intake. No request route may forward caller-selected owner,
 * cursor, policy, actor or descriptor into this service. It uses the existing
 * Run and attempt ledger, and never invokes a provider itself. */
export class AppResourceSyncAdmissionService {
  constructor(
    private readonly repository: PostgresAppRunRepository,
    private readonly runInputs: AppRunSecretRepository,
    private readonly runSecrets: AppRunSecretService,
    private readonly syncSecrets: AppResourceSyncSecretService,
    private readonly scheduler: ResourceSyncAttemptScheduler,
    private readonly clock: () => Date = () => new Date(),
    private readonly enabled: () => boolean = () => false,
    private readonly internalMode: 'resource_v2' | 'attachment_v3' = 'resource_v2',
  ) {}

  async resumeObservation(raw: unknown, caller: { owner_user_id: string; guard: WebAuthorityGuard }): Promise<ResourceSyncAdmissionResult> {
    const parsed = HostTargetSchema.extend({ previous_run_id: z.string().uuid() }).parse(raw);
    return this.admitDue({ org_id: parsed.org_id, resource_binding_id: parsed.resource_binding_id }, undefined, caller, parsed.previous_run_id);
  }

  async admitDue(raw: unknown, limits?: ResourceSyncAdmissionLimits, attachmentCaller?: { owner_user_id: string; guard: WebAuthorityGuard }, recoveryRunId?: string): Promise<ResourceSyncAdmissionResult> {
    if (!this.enabled()) throw new AppError('Resource sync is disabled', 'APP_FEATURE_DISABLED', 503);
    const target = HostTargetSchema.parse(raw);
    const bounded = limits ? AdmissionLimitsSchema.parse({ lock_timeout_ms: limits.lock_timeout_ms,
      statement_timeout_ms: limits.statement_timeout_ms, deadline_at: limits.deadline_at }) : undefined;
    const assertWithinBudget = () => {
      if (limits?.signal?.aborted || (bounded && bounded.deadline_at <= new Date())) {
        throw new AppError('Resource sync admission budget expired', 'APP_ACCESS_DENIED', 403);
      }
    };
    assertWithinBudget();
    return this.repository.transaction(async (tx) => {
      if (bounded) {
        await tx.execute(sql`SELECT set_config('lock_timeout', ${String(bounded.lock_timeout_ms)}, true),
          set_config('statement_timeout', ${String(bounded.statement_timeout_ms)}, true)`);
      }
      assertWithinBudget();
      // Recovery locks its terminal predecessor before authority and checkpoint.
      // It never modifies that Run, its receipt, or any cursor/projection.
      let recoveryIntent: typeof appSyncIntents.$inferSelect | undefined;
      let recoveryCandidates: ReturnType<AppRunSecretService['fingerprintJsonCandidates']> = [];
      let recoveryFingerprint: ReturnType<AppRunSecretService['fingerprintJson']> | undefined;
      if (recoveryRunId) {
        if (!attachmentCaller || this.internalMode !== 'attachment_v3') throw unavailable();
        const [predecessor] = await tx.select().from(appRuns).where(and(eq(appRuns.org_id,target.org_id),eq(appRuns.id,recoveryRunId))).limit(1).for('update');
        if (!predecessor || !['failed','cancelled','unknown_outcome'].includes(predecessor.state)) throw unavailable();
        [recoveryIntent] = await tx.select().from(appSyncIntents).where(and(eq(appSyncIntents.org_id,target.org_id),eq(appSyncIntents.run_id,recoveryRunId),eq(appSyncIntents.resource_binding_id,target.resource_binding_id))).limit(1);
        if (!recoveryIntent) throw unavailable();
        const attempts = await tx.select({state:appRunAttempts.state}).from(appRunAttempts).where(and(eq(appRunAttempts.org_id,target.org_id),eq(appRunAttempts.run_id,recoveryRunId))).for('update');
        if (attempts.some(a => ['pending','claimed','provider_call_started'].includes(a.state))) throw unavailable();
        recoveryCandidates = this.runSecrets.fingerprintJsonCandidates('idempotency', {domain:'deft.app_attachment_sync.explicit_recovery.v1',org_id:target.org_id,resource_binding_id:target.resource_binding_id,previous_run_id:recoveryRunId});
        recoveryFingerprint = this.runSecrets.fingerprintJson('idempotency',{domain:'deft.app_attachment_sync.explicit_recovery.v1',org_id:target.org_id,resource_binding_id:target.resource_binding_id,previous_run_id:recoveryRunId});
      }
      // A new Run is not visible yet. Lock authority first, then checkpoint;
      // never take an existing Run lock while holding these later locks.
      const authority = await (this.internalMode === 'attachment_v3'
        ? loadLiveAttachmentSyncBindingAuthority : loadLiveResourceSyncBindingAuthority)(tx, { ...target, clock: this.clock });
      assertWithinBudget();
      if (!authority || (attachmentCaller && (this.internalMode !== 'attachment_v3'
        || authority.binding.owner_user_id !== attachmentCaller.owner_user_id))) throw unavailable();
      const { binding, installation, version, grant, registration } = authority;
      const [checkpoint] = await tx.select().from(appSyncCheckpoints).where(and(
        eq(appSyncCheckpoints.org_id, target.org_id),
        eq(appSyncCheckpoints.resource_binding_id, binding.id),
      )).limit(1).for('update');
      const now = this.clock();
      assertWithinBudget();
      if (!checkpoint || checkpoint.state !== 'active' || !Number.isFinite(now.getTime())
        || !binding.consent_expires_at || binding.consent_expires_at <= now) throw unavailable();
      const consentExpiry = binding.consent_expires_at;
      const finalAttachment = async (deadlines: readonly Date[] = []) => {
        if (this.internalMode === 'attachment_v3' && !await attachmentFinalAuthorityIsCurrent(tx,
          [binding.owner_user_id,registration.operator_user_id], { guard:attachmentCaller?.guard,
            clock:this.clock,signal:limits?.signal,expires_at:[consentExpiry,...deadlines] })) throw unavailable();
      };

      // The checkpoint lock serializes host admission. Read existing Runs
      // without locking them: completion holds Run before checkpoint, so
      // reversing that order here would deadlock. Returned IDs confer no
      // authority; the channel always rechecks current state and intent.
      if (recoveryFingerprint) {
        const [replacement] = await tx.select(safeRunSelection).from(appRuns).where(and(eq(appRuns.org_id,target.org_id),or(...recoveryCandidates.map(f => and(eq(appRuns.idempotency_key_version,f.key_version),eq(appRuns.idempotency_fingerprint,f.fingerprint)))))).limit(1);
        if (replacement) { await finalAttachment(); return Object.freeze({state:'existing',run_id:replacement.id}); }
        if (!recoveryIntent || recoveryIntent.checkpoint_id !== checkpoint.id || recoveryIntent.generation !== checkpoint.generation
          || recoveryIntent.expected_cursor_sequence !== checkpoint.cursor_sequence || recoveryIntent.expected_cursor_hmac !== checkpoint.cursor_hmac
          || recoveryIntent.expected_cursor_hmac_key_version !== checkpoint.cursor_hmac_key_version) throw unavailable();
        const stages = await tx.select({id:appAttachmentStages.id}).from(appAttachmentStages).where(and(eq(appAttachmentStages.org_id,target.org_id),eq(appAttachmentStages.run_id,recoveryRunId!))).limit(1);
        if (stages.length) throw unavailable();
      }
      const cursorPredicate = and(eq(appSyncIntents.org_id,target.org_id),eq(appSyncIntents.resource_binding_id,binding.id),eq(appSyncIntents.checkpoint_id,checkpoint.id),eq(appSyncIntents.generation,checkpoint.generation),eq(appSyncIntents.expected_cursor_sequence,checkpoint.cursor_sequence));
      const active = await tx.select({ run_id: appSyncIntents.run_id, state:appRuns.state, expires_at:appRuns.input_expires_at })
        .from(appSyncIntents).innerJoin(appRuns,and(eq(appRuns.org_id,appSyncIntents.org_id),eq(appRuns.id,appSyncIntents.run_id)))
        .where(and(cursorPredicate,inArray(appRuns.state,['pending','running','waiting_external']))).limit(2);
      if (active.length) {
        if (recoveryRunId) throw unavailable();
        if (active.length !== 1 || active[0]!.expires_at <= now) { await finalAttachment(); return Object.freeze({state:'blocked',reason:'cursor_requires_recovery'}); }
        await finalAttachment([active[0]!.expires_at]);
        return Object.freeze({state:'existing',run_id:active[0]!.run_id});
      }
      const prior = await tx.select({id:appSyncIntents.id}).from(appSyncIntents).where(cursorPredicate).limit(1);
      if (prior.length && !recoveryRunId) { await finalAttachment(); return Object.freeze({state:'blocked',reason:'cursor_requires_recovery'}); }
      const [latest] = await tx.select({ created_at: appSyncIntents.created_at })
        .from(appSyncIntents).where(and(eq(appSyncIntents.org_id, target.org_id),
          eq(appSyncIntents.resource_binding_id, binding.id)))
        .orderBy(desc(appSyncIntents.created_at)).limit(1);
      if (latest) {
        const due = new Date(latest.created_at.getTime() + binding.min_interval_seconds * 1_000);
        if (due > now) {
          await finalAttachment();
          return Object.freeze({ state: 'not_due', due_at: due.toISOString() });
        }
      }

      const cursorContext = { org_id: target.org_id, resource_binding_id: binding.id,
        checkpoint_id: checkpoint.id, payload_kind: 'cursor' as const,
        generation: checkpoint.generation, cursor_sequence: checkpoint.cursor_sequence };
      const cursor = checkpoint.cursor_state === 'empty' ? null : this.syncSecrets.openJson({
        schema_version: checkpoint.cursor_envelope_version,
        algorithm: checkpoint.cursor_algorithm, key_version: checkpoint.cursor_key_version,
        nonce_b64: checkpoint.cursor_nonce_b64, ciphertext_b64: checkpoint.cursor_ciphertext_b64,
        auth_tag_b64: checkpoint.cursor_auth_tag_b64,
      }, cursorContext);
      if (cursor !== null && typeof cursor !== 'string') throw unavailable();
      const fingerprint = this.syncSecrets.cursorFingerprint(cursor, cursorContext,
        checkpoint.cursor_hmac_key_version);
      if (fingerprint.fingerprint !== checkpoint.cursor_hmac) throw unavailable();
      const request = this.internalMode === 'attachment_v3'
        ? SyncRequestV2Schema.parse({ schema_version: 'deft.app_sync_request.v2', cursor, max_items: binding.max_records_per_page,
          attachments: parseAttachmentConsentPolicy(binding.reviewed_descriptor.attachments,binding.attachment_policy) })
        : parseSyncRequest({ schema_version: 'deft.app_sync_request.v1',cursor,max_items:binding.max_records_per_page });
      const idempotency = recoveryFingerprint ?? this.runSecrets.fingerprintJson('idempotency', {
        domain: this.internalMode === 'attachment_v3' ? 'deft.app_attachment_sync.admission.v1' : 'deft.app_resource_sync.admission.v1', org_id: target.org_id,
        resource_binding_id: binding.id, checkpoint_id: checkpoint.id,
        generation: checkpoint.generation, cursor_sequence: checkpoint.cursor_sequence,
      });
      const inputFingerprint = this.runSecrets.fingerprintJson('input', request);
      const runId = randomUUID();
      const inputExpiresAt = new Date(Math.min(retentionDeadline('standard', now).getTime(),
        binding.consent_expires_at.getTime()));
      const actor = { actor_type: 'system' as const, system_id: binding.id };
      const authorization = this.internalMode === 'attachment_v3'
        ? buildAttachmentSyncAuthorizationSnapshot(await loadLiveAttachmentSyncBindingAuthority(tx,{ ...target,clock:this.clock }).then(live => { if (!live) throw unavailable(); return live; }))
        : buildResourceSyncAuthorizationSnapshot(authority);
      const [run] = await tx.insert(appRuns).values({ id: runId, org_id: target.org_id,
        contract_version: APP_RUN_CONTRACT_VERSIONS.run, origin_kind: 'app',
        initiating_actor_type: 'system', initiating_actor_id: binding.id,
        execution_actor_type: 'system', execution_actor_id: binding.id,
        provider_kind: 'app_runtime', provider_instance_id: registration.id,
        provider_snapshot_id: binding.provider_snapshot_id, operation_name: binding.operation_name,
        origin_app_installation_id: installation.id, origin_app_version_id: version.id,
        origin_app_grant_snapshot_id: grant.id, origin_resource_binding_id: binding.id,
        state: 'pending', ...APP_RESOURCE_SYNC_HOST_POLICY,
        idempotency_key_version: idempotency.key_version,
        idempotency_fingerprint: idempotency.fingerprint,
        input_fingerprint_key_version: inputFingerprint.key_version,
        input_fingerprint: inputFingerprint.fingerprint, authorization_snapshot: authorization,
        safe_preview: AppRunSafePreviewSchema.parse({ schema_version: APP_RUN_CONTRACT_VERSIONS.run,
          title: 'Sync private App resource', resource_refs: [] }),
        root_run_id: runId, input_expires_at: inputExpiresAt,
        result_expires_at: retentionDeadline('standard', now),
        idempotency_expires_at: idempotencyDeadline('standard', now),
        attempt_limit: APP_RUN_DEFAULT_ATTEMPT_LIMIT,
        execution_release_kind: 'policy_satisfied', execution_released_at: now,
        created_at: now, updated_at: now,
      }).returning(safeRunSelection);
      if (!run) throw unavailable();
      await this.runInputs.insertInput(tx, { org_id: target.org_id, run_id: runId,
        value: request, expires_at: inputExpiresAt });
      await tx.insert(appSyncIntents).values({ id: randomUUID(), org_id: target.org_id,
        run_id: runId, resource_binding_id: binding.id, checkpoint_id: checkpoint.id,
        app_installation_id: installation.id, app_version_id: version.id,
        grant_snapshot_id: grant.id, provider_snapshot_id: binding.provider_snapshot_id,
        owner_user_id: binding.owner_user_id, descriptor_digest: authority.descriptor_digest,
        generation: checkpoint.generation, expected_cursor_sequence: checkpoint.cursor_sequence,
        expected_cursor_hmac_key_version: checkpoint.cursor_hmac_key_version,
        expected_cursor_hmac: checkpoint.cursor_hmac, created_at: now });
      await this.repository.appendEvent(tx, { id: randomUUID(), org_id: target.org_id,
        run_id: runId, event_type: 'run_created', actor, now,
        payload: { resource_binding_id: binding.id, checkpoint_id: checkpoint.id,
          generation: checkpoint.generation, cursor_sequence: checkpoint.cursor_sequence, ...(recoveryRunId ? { previous_run_id: recoveryRunId } : {}) } });
      const attemptId = await this.scheduler.scheduleResourceSyncInTransaction(tx, run, now);
      const completedAt = this.clock();
      assertWithinBudget();
      if (!attemptId || !Number.isFinite(completedAt.getTime())
        || inputExpiresAt <= completedAt || binding.consent_expires_at <= completedAt) throw unavailable();
      await finalAttachment([inputExpiresAt,run.result_expires_at]);
      return Object.freeze({ state: 'created', run_id: runId, attempt_id: attemptId });
    });
  }
}
