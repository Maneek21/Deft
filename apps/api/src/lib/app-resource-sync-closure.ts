import { and, desc, eq, sql } from 'drizzle-orm';
import { appRuns, appRunAttempts, appRunReceipts, appSyncIntents, appSyncCheckpoints,
  appResourceBindings, appRuntimeRegistrations, orgMembers, users } from '@deft/db/schema';
import { AppRunSafeOutcomeSchema, canonicalCapabilityJson, parseAppRunReceiptEnvelope } from '@deft/shared';
import type { ModuleActor } from '@deft/shared/modules';
import { AppError } from './app-errors.js';
import { PostgresAppRunRepository, type AppRunTransaction } from './app-run-repository.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { AppRunSecretService } from './app-run-secrets.js';
import { AppRunSecretRepository } from './app-run-secret-repository.js';
import { PostgresAppRunReceiptWriter, PostgresAppRunReceiptReader } from './app-run-receipts.js';
import { PostgresAppRunAttentionProjector } from './app-run-attention.js';
import { loadAttachmentSyncClosureBindingAuthority } from './app-attachment-sync-authority.js';
import { loadHistoricalSyncClosureAuthority } from './app-resource-sync-historical-closure-authority.js';
import { loadLiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import { buildAttachmentSyncAuthorizationSnapshot } from './app-attachment-sync-run.js';
import {appResourceObservationConsents,appResourceObservationRuns} from '../../../../packages/db/src/resource-observation-schema.js';
import {appConsentDeadline,ResourceObservationSnapshotSchema} from '@deft/app-kit';
import {hasResourceObservationPin,loadObservationConnection,observedResourceAuthorization,observationPolicyDigest} from './app-resource-observation-authority.js';
import {isDeepStrictEqual} from 'node:util';
import { attachmentFinalAuthorityIsCurrent, assertAttachmentBrokerEnabled } from './app-attachment-authority.js';
import { isAppAttachmentBrokerEnabled, isAppOwnerConnectionsEnabled } from './env.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { samplePrivateAccessClock } from './app-private-access-clock.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import { AppResourceSyncClosureRequestSchema, AppResourceSyncClosureActivationSchema,
  AppResourceSyncClosureReceiptRequestSchema, AppResourceSyncClosureReviewSchema, type AppResourceSyncClosureResult } from './app-resource-sync-closure-contract.js';

type Human = Extract<ModuleActor, { kind: 'human' }>;
const denied = () => new AppError('Private sync closure access denied', 'APP_ACCESS_DENIED', 403);
const stale = () => new AppError('Private sync closure review changed', 'APP_STALE', 409);
const conflict = () => new AppError('Private sync Run is not available for closure', 'APP_STATE_CONFLICT', 409);
const basis = 'operator_closes_unknown_sync' as const;
/** Closure proves the original read obligation, without reviving an opted-out
 * observation or granting provider access. Its historical consent must remain
 * intact and its current account/custody/resource policy must still match. */
async function closureAuthorization(tx:AppRunTransaction,stored:typeof appRuns.$inferSelect,
 authority:NonNullable<Awaited<ReturnType<typeof loadAttachmentSyncClosureBindingAuthority>>>){
 const base=buildAttachmentSyncAuthorizationSnapshot(authority);
 const [link]=await tx.select().from(appResourceObservationRuns).where(and(eq(appResourceObservationRuns.org_id,stored.org_id),
  eq(appResourceObservationRuns.run_id,stored.id))).limit(1);
 if(!link){if(hasResourceObservationPin(stored.authorization_snapshot,authority.binding.id))throw stale();return {authorization:base};}
 const [row]=await tx.select().from(appResourceObservationConsents).where(and(eq(appResourceObservationConsents.org_id,stored.org_id),
  eq(appResourceObservationConsents.consent_id,link.consent_id))).limit(1).for('share');
 if(!row||!['active','revoked'].includes(row.state)||row.consent_digest!==link.consent_digest
  ||row.owner_user_id!==authority.binding.owner_user_id||row.resource_binding_id!==authority.binding.id)throw stale();
 const snapshot=ResourceObservationSnapshotSchema.parse(row.snapshot);
 if(digestAppGrantValue(snapshot)!==row.consent_digest||row.connection_session_id!==snapshot.connection.session_id
  ||(row.expires_at?.toISOString()??null)!==snapshot.expires_at||snapshot.scope.org_id!==stored.org_id
  ||snapshot.scope.owner_user_id!==authority.binding.owner_user_id||snapshot.scope.resource_binding_id!==authority.binding.id
  ||snapshot.resource_policy_digest!==await observationPolicyDigest(authority))throw stale();
 const record=await loadObservationConnection(tx,authority,snapshot.connection.session_id),receipt=record.credential_repair?.receipt??record.upgrade?.receipt??record.reattachment?.receipt;
 if(!isDeepStrictEqual(record.scope,snapshot.scope)||record.runtime_session_ref!==snapshot.connection.runtime_session_ref
  ||record.account!.account_ref!==snapshot.connection.account_ref
  ||snapshot.connection.expected_custody_generation!==(receipt?.custody_generation??null)
  ||snapshot.connection.receipt_digest!==(receipt?.receipt_digest??null))throw stale();
 return {authorization:observedResourceAuthorization(base,row),observation:{consent_id:row.consent_id,consent_digest:row.consent_digest,
  connection_session_id:snapshot.connection.session_id,account_ref:snapshot.connection.account_ref,
  expected_custody_generation:snapshot.connection.expected_custody_generation,receipt_digest:snapshot.connection.receipt_digest}};
}
function interactive(actor: ModuleActor): asserts actor is Human {
  if (actor.kind !== 'human' || !['ui', 'rest'].includes(actor.source)
    || !['owner', 'admin', 'member'].includes(actor.role)) throw denied();
  assertAttachmentBrokerEnabled();
}

/** Close only the local private Sync obligation. This grants no Runtime token,
 * provider access, payload read or retry; historical effect uncertainty survives. */
export class AppResourceSyncClosureService {
  private readonly secrets: AppRunSecretService;
  private readonly receipts: PostgresAppRunReceiptWriter;
  constructor(keys: AppRunKeyProvider, private readonly repository = new PostgresAppRunRepository(),
    private readonly now = () => new Date()) {
    this.secrets = new AppRunSecretService(keys);
    this.receipts = new PostgresAppRunReceiptWriter(this.secrets, new AppRunSecretRepository(this.secrets));
  }

  async historicalCandidates(actor: ModuleActor, currentBindingId: string, guard: WebAuthorityGuard) {
    interactive(actor);
    let afterCommit = () => {};
    const result = await this.repository.transaction(async tx => {
      const authority = await loadLiveAttachmentSyncBindingAuthority(tx, { org_id: actor.org_id,
        resource_binding_id: currentBindingId, clock: this.now });
      if (!authority || ![authority.binding.owner_user_id, authority.registration.operator_user_id].includes(actor.actor_id)) throw denied();
      if (!await attachmentFinalAuthorityIsCurrent(tx, [authority.binding.owner_user_id, authority.registration.operator_user_id],
        { guard, clock: this.now, expires_at: authority.binding.consent_expires_at ? [authority.binding.consent_expires_at] : [] })) throw stale();
      // Metadata only, limited to the caller's exact selected target. Review
      // still independently reconstructs every original/current authority pin.
      const rows = await tx.select({ run_id: appRuns.id, operation_name: appRuns.operation_name,
        created_at: appRuns.created_at, unknown_outcome_at: appRuns.unknown_outcome_at })
        .from(appRuns).innerJoin(appResourceBindings, and(eq(appResourceBindings.org_id, appRuns.org_id),
          eq(appResourceBindings.id, appRuns.origin_resource_binding_id)))
        .where(and(eq(appRuns.org_id, actor.org_id), eq(appRuns.state, 'unknown_outcome'),
          eq(appRuns.review_scope, 'reviewed_resource_sync'), eq(appRuns.risk_class, 'internal_write'),
          eq(appRuns.provider_kind, 'app_runtime'), eq(appRuns.origin_app_installation_id, authority.installation.id),
          eq(appResourceBindings.owner_user_id, authority.binding.owner_user_id),
          eq(appResourceBindings.target_key, authority.binding.target_key), eq(appResourceBindings.resource_key, authority.binding.resource_key)))
        .orderBy(desc(appRuns.created_at)).limit(8);
      const clock = await samplePrivateAccessClock(tx, this.now);
      const deadlines = [...(authority.binding.consent_expires_at ? [authority.binding.consent_expires_at] : []),
        guard.current_web_session_expires_at()];
      if (!await attachmentFinalAuthorityIsCurrent(tx, [authority.binding.owner_user_id, authority.registration.operator_user_id],
        { guard, clock: this.now, expires_at: deadlines })) throw stale();
      afterCommit = () => { if (!isAppAttachmentBrokerEnabled() || !isAppOwnerConnectionsEnabled()
        || deadlines.some(deadline => deadline <= clock.current())) throw stale(); };
      afterCommit();
      return { current_resource_binding_id: currentBindingId, target_key: authority.binding.target_key,
        resource_key: authority.binding.resource_key, runs: rows.map(row => ({ ...row,
          created_at: row.created_at.toISOString(), unknown_outcome_at: row.unknown_outcome_at?.toISOString() ?? null })) };
    });
    afterCommit(); return result;
  }

  private async current(tx: AppRunTransaction, actor: Human, runId: string, allowReplay: boolean, currentBindingId?: string) {
    // Run precedes member/App/registration/binding/attempt/checkpoint, matching
    // completion and the existing attachment authority lock order.
    const run = await this.repository.lockRun(tx, actor.org_id, runId);
    if (!run) throw denied();
    const [stored] = await tx.select().from(appRuns).where(and(eq(appRuns.org_id, actor.org_id), eq(appRuns.id, runId))).limit(1);
    if (!stored || stored.origin_kind !== 'app' || stored.provider_kind !== 'app_runtime'
      || stored.review_scope !== 'reviewed_resource_sync' || stored.risk_class !== 'internal_write'
      || !stored.origin_resource_binding_id || stored.origin_runtime_binding_id !== null
      || stored.initiating_actor_type !== 'system' || stored.execution_actor_type !== 'system'
      || stored.initiating_actor_id !== stored.origin_resource_binding_id || stored.execution_actor_id !== stored.origin_resource_binding_id) throw denied();
    const [locator] = await tx.select({ owner: appResourceBindings.owner_user_id,
      operator: appRuntimeRegistrations.operator_user_id }).from(appResourceBindings)
      .innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, appResourceBindings.org_id),
        eq(appRuntimeRegistrations.id, appResourceBindings.runtime_registration_id)))
      .where(and(eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.id, stored.origin_resource_binding_id))).limit(1);
    if (!locator || ![locator.owner, locator.operator].includes(actor.actor_id)) throw denied();
    const participants = [...new Set([locator.owner, locator.operator])].sort();
    for (const userId of participants) await tx.execute(sql`SELECT id FROM org_members
      WHERE org_id=${actor.org_id} AND user_id=${userId} FOR SHARE`);
    const [caller] = await tx.select({ role: orgMembers.role, active: orgMembers.is_active, kind: users.kind, is_agent: users.is_agent })
      .from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id))
      .where(and(eq(orgMembers.org_id, actor.org_id), eq(orgMembers.user_id, actor.actor_id))).limit(1);
    if (!caller?.active || caller.kind !== 'human' || caller.is_agent !== false || !['owner', 'admin', 'member'].includes(caller.role)) throw denied();
    const historical = currentBindingId ? await loadHistoricalSyncClosureAuthority(tx, { run: stored,
      current_resource_binding_id: currentBindingId, participant_ids: participants, clock: this.now }) : null;
    const live = historical ? null : await loadAttachmentSyncClosureBindingAuthority(tx, { org_id: actor.org_id,
      resource_binding_id: stored.origin_resource_binding_id, clock: this.now, prelocked_participant_ids: participants });
    const authority = historical?.historical ?? live;
    if (!authority) throw stale();
    const { binding, registration, installation, version, grant, provider_snapshot } = authority;
    const closure = historical ? { authorization: historical.authorization, observation: historical.observation }
      : await closureAuthorization(tx, stored, live!);
    if (binding.owner_user_id !== locator.owner || registration.operator_user_id !== locator.operator
      || !registration.owner_connection_admission_id && !['owner', 'admin'].includes(caller.role)) throw denied();
    if (stored.origin_app_installation_id !== installation.id || stored.origin_app_version_id !== version.id
      || stored.origin_app_grant_snapshot_id !== grant.id || stored.provider_instance_id !== registration.id
      || stored.provider_snapshot_id !== provider_snapshot.id || stored.operation_name !== binding.operation_name
      || stored.review_requirement !== binding.review_requirement || stored.retry_class !== binding.retry_class
      || stored.retention_class !== binding.retention_class
      || canonicalCapabilityJson(stored.authorization_snapshot) !== canonicalCapabilityJson(closure.authorization)) throw stale();
    if ((!allowReplay || run.state !== 'failed') && run.state !== 'unknown_outcome') throw conflict();
    if (!run.unknown_outcome_at || run.safe_outcome?.provider_call_attempted !== true) throw conflict();
    const [intent] = await tx.select().from(appSyncIntents).where(and(eq(appSyncIntents.org_id, actor.org_id), eq(appSyncIntents.run_id, run.id))).limit(1);
    if (!intent || intent.resource_binding_id !== binding.id || intent.app_installation_id !== installation.id
      || intent.app_version_id !== version.id || intent.grant_snapshot_id !== grant.id
      || intent.provider_snapshot_id !== provider_snapshot.id || intent.owner_user_id !== binding.owner_user_id
      || intent.descriptor_digest !== authority.descriptor_digest) throw stale();
    const attempts = await tx.select().from(appRunAttempts).where(and(eq(appRunAttempts.org_id, actor.org_id), eq(appRunAttempts.run_id, run.id)))
      .orderBy(desc(appRunAttempts.attempt_number)).limit(33).for('share');
    const attempt = attempts[0];
    if (!attempt || attempts.length >= 33 || attempt.state !== 'unknown_outcome'
      || attempts.some(row => ['pending', 'claimed', 'provider_call_started'].includes(row.state))
      || attempt.resource_binding_id !== binding.id || attempt.runtime_binding_id !== null
      || attempt.runtime_epoch !== registration.runtime_epoch || !attempt.provider_call_started_at
      || !attempt.lease_expires_at || attempt.lease_expires_at > this.now()) throw conflict();
    if (historical && (historical.original_consent_deadline <= attempt.provider_call_started_at.getTime()
      || historical.original_reviewed_at > attempt.provider_call_started_at
      || historical.observation_created_at > attempt.provider_call_started_at
      || historical.admission_created_at > attempt.provider_call_started_at
      || historical.connection_created_at > attempt.provider_call_started_at)) throw stale();
    const [checkpoint] = await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id, actor.org_id),
      eq(appSyncCheckpoints.id, intent.checkpoint_id), eq(appSyncCheckpoints.resource_binding_id, binding.id))).limit(1).for('share');
    if (!checkpoint || checkpoint.state !== 'active') throw stale();
    // Later successful observations may have advanced this checkpoint. The
    // current review pins that fact; closure makes no claim about prior ingestion.
    const base = {
      schema_version: 'deft.app_private_sync_closure_review.v1' as const, org_id: actor.org_id, run_id: run.id,
      reviewer_user_id: actor.actor_id, resource_binding_id: binding.id, runtime_registration_id: registration.id,
      owner_user_id: binding.owner_user_id, operator_user_id: registration.operator_user_id,
      installation_id: installation.id, app_version_id: version.id, grant_snapshot_id: grant.id,
      package_digest: version.package_digest, grant_snapshot_digest: grant.snapshot_digest, descriptor_digest: authority.descriptor_digest,
      lifecycle_epoch: installation.lifecycle_epoch, grant_epoch: installation.grant_epoch, runtime_epoch: registration.runtime_epoch,
      target_key: binding.target_key, consent_expires_at: binding.consent_expires_at?.toISOString()??null,...(binding.consent_lifetime?{consent_lifetime:binding.consent_lifetime}:{}),
      state: 'unknown_outcome' as const, unknown_outcome_at: run.unknown_outcome_at.toISOString(), attempt_id: attempt.id,
      attempt_digest: digestAppGrantValue({ id: attempt.id, attempt_number: attempt.attempt_number, state: attempt.state,
        resource_binding_id: attempt.resource_binding_id, runtime_epoch: attempt.runtime_epoch,
        provider_call_started_at: attempt.provider_call_started_at.toISOString(), provider_call_finished_at: attempt.provider_call_finished_at?.toISOString() ?? null,
        lease_expires_at: attempt.lease_expires_at.toISOString(), updated_at: attempt.updated_at.toISOString() }),
      intent_digest: digestAppGrantValue({ ...intent, created_at: intent.created_at.toISOString() }), checkpoint_id: checkpoint.id,
      checkpoint_digest: digestAppGrantValue({ id: checkpoint.id, state: checkpoint.state, generation: checkpoint.generation,
        cursor_sequence: checkpoint.cursor_sequence, cursor_hmac: checkpoint.cursor_hmac, cursor_hmac_key_version: checkpoint.cursor_hmac_key_version,
        last_applied_run_id: checkpoint.last_applied_run_id, last_applied_page_digest: checkpoint.last_applied_page_digest,
        updated_at: checkpoint.updated_at.toISOString() }),
      basis, provider_outcome: 'unknown' as const, no_retry: true as const,
      ...(closure.observation?{observation:closure.observation}:{}),
      ...(historical ? { historical_closure: {
        operation_name: stored.operation_name, run_created_at: stored.created_at.toISOString(),
        current_resource_binding_id: historical.current.binding.id, current_runtime_registration_id: historical.current.registration.id,
        current_app_version_id: historical.current.version.id, current_grant_snapshot_id: historical.current.grant.id,
        current_package_digest: historical.current.version.package_digest, current_grant_snapshot_digest: historical.current.grant.snapshot_digest,
        current_lifecycle_epoch: historical.current.installation.lifecycle_epoch, current_grant_epoch: historical.current.installation.grant_epoch,
        current_runtime_epoch: historical.current.registration.runtime_epoch,
        current_consent_expires_at: historical.current.binding.consent_expires_at?.toISOString() ?? null,
        ...(historical.current.binding.consent_lifetime ? { current_consent_lifetime: historical.current.binding.consent_lifetime } : {}),
        profile_digest: historical.current.owner_connection_admission!.snapshot.connection_profile_digest!,
        transport_digest: historical.current.owner_connection_admission!.snapshot.connection_transport_digest!,
      } } : {}),
    };
    return { run, attempt, authority, currentAuthority: historical?.current ?? live!, participants,
      review: AppResourceSyncClosureReviewSchema.parse({ ...base, review_digest: digestAppGrantValue(base) }) };
  }

  private async final(tx: AppRunTransaction, context: Awaited<ReturnType<AppResourceSyncClosureService['current']>>, guard: WebAuthorityGuard) {
    const clock = await samplePrivateAccessClock(tx, this.now);
    const binding = context.currentAuthority.binding;
    if (appConsentDeadline(binding.consent_expires_at, binding.consent_lifetime ?? undefined) <= clock.current().getTime()) throw stale();
    const consentDeadlines = binding.consent_expires_at ? [binding.consent_expires_at] : [];
    if (!await attachmentFinalAuthorityIsCurrent(tx, context.participants, { guard, clock: this.now,
      expires_at: consentDeadlines })) throw stale();
    const deadlines = [...consentDeadlines, guard.current_web_session_expires_at()];
    return () => { if (!isAppAttachmentBrokerEnabled()
      || context.authority.registration.owner_connection_admission_id && !isAppOwnerConnectionsEnabled()
      || deadlines.some(deadline => deadline <= clock.current())) throw stale(); };
  }

  async review(actor: ModuleActor, raw: unknown, guard: WebAuthorityGuard) {
    interactive(actor); const input = AppResourceSyncClosureRequestSchema.parse(raw); let afterCommit = () => {};
    const review = await this.repository.transaction(async tx => {
      const context = await this.current(tx, actor, input.run_id, false, input.current_resource_binding_id);
      afterCommit = await this.final(tx, context, guard); afterCommit(); return context.review;
    });
    afterCommit(); return review;
  }

  /** Lookup only. Absence never activates, transitions, retries, or dispatches. */
  async historicalReceipt(actor: ModuleActor, raw: unknown, guard: WebAuthorityGuard) {
    interactive(actor); const input = AppResourceSyncClosureReceiptRequestSchema.parse(raw); let afterCommit = () => {};
    const result = await this.repository.transaction(async tx => {
      const context = await this.current(tx, actor, input.run_id, true, input.current_resource_binding_id);
      let result: { status: 'unconfirmed' } | { status: 'closed'; closure: AppResourceSyncClosureResult } = { status: 'unconfirmed' };
      if (context.run.state === 'failed') {
        const [row] = await tx.select().from(appRunReceipts).where(and(eq(appRunReceipts.org_id, actor.org_id),
          eq(appRunReceipts.run_id, context.run.id), eq(appRunReceipts.receipt_key, `private-sync-closure:${context.run.id}`))).limit(1);
        if (!row || row.receipt_kind !== 'reconciliation' || !context.run.reconciled_at) throw conflict();
        const [receipt] = await new PostgresAppRunReceiptReader(this.secrets, { list: async () => [row] }).readVerified(actor.org_id, context.run.id);
        const envelope = parseAppRunReceiptEnvelope(row.envelope);
        if (envelope.facts.review_digest !== input.expected_review_digest || envelope.facts.basis !== basis
          || envelope.facts.provider_outcome !== 'unknown' || envelope.facts.no_retry !== true
          || envelope.actor?.actor_type !== 'human' || envelope.actor.user_id !== actor.actor_id) throw conflict();
        if (!isDeepStrictEqual(envelope.facts.historical_closure, context.review.historical_closure)) throw stale();
        result = { status: 'closed', closure: { run_id: context.run.id, state: 'failed', basis, provider_outcome: 'unknown',
          no_retry: true, review_digest: input.expected_review_digest, receipt } };
      }
      afterCommit = await this.final(tx, context, guard); afterCommit(); return result;
    });
    afterCommit(); return result;
  }

  async activate(actor: ModuleActor, raw: unknown, guard: WebAuthorityGuard): Promise<AppResourceSyncClosureResult> {
    interactive(actor); const input = AppResourceSyncClosureActivationSchema.parse(raw); let afterCommit = () => {};
    let resolved: Awaited<ReturnType<PostgresAppRunRepository['inspect']>> = null;
    const closure = await this.repository.transaction(async tx => {
      const context = await this.current(tx, actor, input.run_id, true, input.current_resource_binding_id);
      const receiptKey = `private-sync-closure:${context.run.id}`;
      if (context.run.state === 'failed') {
        const [row] = await tx.select().from(appRunReceipts).where(and(eq(appRunReceipts.org_id, actor.org_id),
          eq(appRunReceipts.run_id, context.run.id), eq(appRunReceipts.receipt_key, receiptKey))).limit(1);
        if (!row || row.receipt_kind !== 'reconciliation' || !context.run.reconciled_at) throw conflict();
        await new PostgresAppRunReceiptReader(this.secrets, { list: async () => [row] }).readVerified(actor.org_id, context.run.id);
        const envelope = parseAppRunReceiptEnvelope(row.envelope);
        if (envelope.facts.review_digest !== input.expected_review_digest || envelope.facts.basis !== basis
          || envelope.facts.provider_outcome !== 'unknown' || envelope.facts.no_retry !== true
          || envelope.actor?.actor_type !== 'human' || envelope.actor.user_id !== actor.actor_id) throw conflict();
        if (context.review.historical_closure
          && !isDeepStrictEqual(envelope.facts.historical_closure, context.review.historical_closure)) throw stale();
        // Recover a committed acknowledgement using the signed original review;
        // later checkpoint observations cannot rewrite or invalidate its facts.
      } else {
        if (context.review.review_digest !== input.expected_review_digest) throw stale();
        const human = { actor_type: 'human' as const, user_id: actor.actor_id };
        resolved = await this.repository.transition(tx, { run: context.run, state: 'failed', actor: human,
          now: this.now(), event_type: 'reconciliation_recorded', error_code: 'APP_RUN_UNKNOWN_OUTCOME', safe_outcome: AppRunSafeOutcomeSchema.parse({
            success: false, provider_call_attempted: true, result_status: 'unavailable', error_code: 'APP_RUN_UNKNOWN_OUTCOME',
          }) });
        await this.receipts.write(tx, { receipt_key: receiptKey, receipt_kind: 'reconciliation', run: resolved,
          attempt_id: context.attempt.id, actor: human, occurred_at: resolved.reconciled_at!,
          facts: { basis, provider_outcome: 'unknown', no_retry: true, resolution: 'failed',
            review_digest: input.expected_review_digest, original_unknown_outcome_at: context.review.unknown_outcome_at,
            resource_binding_id: context.review.resource_binding_id, checkpoint_id: context.review.checkpoint_id,
            intent_digest: context.review.intent_digest, checkpoint_digest: context.review.checkpoint_digest,
            ...(context.review.observation?{observation:context.review.observation}:{}),
            ...(context.review.historical_closure ? { historical_closure: context.review.historical_closure } : {}) } });
      }
      let verifiedReceipt;
      if (context.review.historical_closure) {
        const [row] = await tx.select().from(appRunReceipts).where(and(eq(appRunReceipts.org_id, actor.org_id),
          eq(appRunReceipts.run_id, context.run.id), eq(appRunReceipts.receipt_key, receiptKey))).limit(1);
        if (!row) throw conflict();
        [verifiedReceipt] = await new PostgresAppRunReceiptReader(this.secrets, { list: async () => [row] }).readVerified(actor.org_id, context.run.id);
      }
      afterCommit = await this.final(tx, context, guard); afterCommit();
      return { run_id: context.run.id, state: 'failed' as const, basis,
        provider_outcome: 'unknown' as const, no_retry: true as const, review_digest: input.expected_review_digest,
        ...(verifiedReceipt ? { receipt: verifiedReceipt } : {}) };
    });
    afterCommit();
    if (resolved) try { await new PostgresAppRunAttentionProjector().projectRunState(resolved, 'reconciled'); } catch {
      // A committed signed closure remains true if the ancillary projection fails.
      console.warn('[app-private-sync-closure] Attention projection unavailable');
    }
    afterCommit(); return closure;
  }
}
