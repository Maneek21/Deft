import { randomUUID } from 'node:crypto';
import { and, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { digestResourceSyncDescriptorV2 } from '@deft/app-kit/core';
import { appInstallations, appOwnerConnectionAdmissions, appResourceBindings, appRuntimeBindings, appRuntimeRegistrations, appRuntimeSessions, appRuns, auditLog, users } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { assertCurrentModuleManagerWithExecutor } from './module-service.js';
import { loadReviewedAttachmentApp } from './app-attachment-authority.js';
import { runtimeActionDescriptors } from './app-runtime-review.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { AppResourceSyncManagement } from './app-resource-sync-management.js';
import { prepareRuntimeBindingReview, activateRuntimeBinding } from './app-runtime-management.js';
import { assertOwnerConnectionMember, assertOwnerConnectionRegistration, loadOwnerConnectionAdmission, ownerConnectionDenied } from './app-owner-connection-authority.js';
import { loadLiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import { attachmentSyncConsentReview } from './app-attachment-sync-consent.js';
import { OwnerConnectionAdmissionInputSchema, OwnerConnectionAdmissionSnapshotSchema, OwnerConnectionResourceRequestSchema,
  OwnerConnectionActionRequestSchema, ownerConnectionLimitsWithin, resolveOwnerConnectionProfile, ownerConnectionTransportDigest, type OwnerConnectionAdmissionReference, type OwnerConnectionContext } from './app-owner-connection-contract.js';
import { connectionProfileDigest } from './app-connection-session-registry.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { samplePrivateAccessClock } from './app-private-access-clock.js';
import { isAppOwnerConnectionsEnabled } from './env.js';
import { compatibleOwnerRecoverySnapshot } from './app-owner-recovery-targets.js';

type Human = Extract<ModuleActor, { kind: 'human' }>;
const activation = { expected_review_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), accept_host_policy: z.literal(true) };
const stale = () => new AppError('Private connection review changed', 'APP_STALE', 409);
const pageLimitsRequest = z.strictObject({ binding_id: z.string().uuid(), max_records_per_page: z.number().int().min(1).max(100) });
function human(actor: ModuleActor): asserts actor is Human {
  if (actor.kind !== 'human' || !['ui', 'rest'].includes(actor.source) || !['owner', 'admin', 'member'].includes(actor.role)
    || !isAppOwnerConnectionsEnabled()) throw ownerConnectionDenied();
}
async function members(tx: AppRunTransaction, orgId: string, ids: readonly string[]) {
  for (const id of [...new Set(ids)].sort()) await tx.execute(sql`SELECT id FROM org_members WHERE org_id=${orgId} AND user_id=${id} FOR SHARE`);
}

/** Explicit opt-in owner consent. Deployment and operator approval remain admin-only. */
export class AppOwnerConnectionService {
  constructor(private readonly keys: AppRunKeyProvider, private readonly now = () => new Date()) {}
  private async guarded<T>(actor: Human, operator: string, guard: WebAuthorityGuard,
    use: (tx: AppRunTransaction) => Promise<T>, expiresAt: Date[] = []) {
    let afterCommit = () => {};
    const result = await db.transaction(async tx => {
      await members(tx, actor.org_id, [actor.actor_id, operator]);
      await assertOwnerConnectionMember(tx, actor.org_id, actor.actor_id);
      const clock = await samplePrivateAccessClock(tx, this.now);
      const output = await use(tx);
      await guard(tx);
      const deadline = guard.current_web_session_expires_at();
      afterCommit = () => { if (!isAppOwnerConnectionsEnabled() || clock.current() >= deadline
        || expiresAt.some(expiry => clock.current() >= expiry)) throw ownerConnectionDenied(); };
      afterCommit(); return output;
    });
    afterCommit(); return result;
  }
  private async admissionLocator(orgId: string, id: string) {
    const [row] = await db.select().from(appOwnerConnectionAdmissions).where(and(eq(appOwnerConnectionAdmissions.org_id, orgId),
      eq(appOwnerConnectionAdmissions.id, id))).limit(1);
    if (!row) throw ownerConnectionDenied(); return row;
  }
  /** Owner-reviewed CAS amendment of page size only; identity, expiry and retained custody are unchanged. */
  async resourcePageLimits(actor: ModuleActor, raw: unknown, guard: WebAuthorityGuard, activate = false) {
    human(actor);
    const input = (activate ? pageLimitsRequest.extend(activation) : pageLimitsRequest).parse(raw);
    const [locator] = await db.select({ operator: appRuntimeRegistrations.operator_user_id })
      .from(appResourceBindings).innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, appResourceBindings.org_id),
        eq(appRuntimeRegistrations.id, appResourceBindings.runtime_registration_id)))
      .where(and(eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.id, input.binding_id),
        eq(appResourceBindings.owner_user_id, actor.actor_id))).limit(1);
    if (!locator) throw ownerConnectionDenied();
    const expiresAt: Date[] = [];
    return this.guarded(actor, locator.operator, guard, async tx => {
      // Take UPDATE at the established binding lock position, never upgrade a shared lock.
      const authority = await loadLiveAttachmentSyncBindingAuthority(tx, { org_id: actor.org_id,
        resource_binding_id: input.binding_id, clock: this.now, binding_lock: 'update',
        prelocked_participant_ids: [actor.actor_id, locator.operator] });
      if (!authority || authority.binding.owner_user_id !== actor.actor_id) throw ownerConnectionDenied();
      const { binding, registration } = authority;
      const admission = await assertOwnerConnectionRegistration(tx, registration, { owner_user_id: actor.actor_id,
        resource_key: binding.resource_key, lockedReviewed: authority });
      const limits = { max_records_per_page: input.max_records_per_page, max_page_bytes: binding.max_page_bytes,
        max_retained_records: binding.max_retained_records, max_retained_bytes: binding.max_retained_bytes,
        min_interval_seconds: binding.min_interval_seconds };
      if (!ownerConnectionLimitsWithin(limits, admission.snapshot.limits)) throw ownerConnectionDenied();
      if (input.max_records_per_page === binding.max_records_per_page) throw stale();
      if(binding.consent_expires_at)expiresAt.push(binding.consent_expires_at);
      const consent = { ...attachmentSyncConsentReview({ org_id: actor.org_id, owner_user_id: actor.actor_id,
        operator_user_id: registration.operator_user_id, reviewed: authority, consent_expires_at: binding.consent_expires_at,...(binding.consent_lifetime?{consent_lifetime:binding.consent_lifetime}:{}),
        limits, attachment_policy: binding.attachment_policy, owner_connection_admission: admission.reference }),
        ...(binding.target_key === 'primary' ? {} : { target_key: binding.target_key }) };
      const review = { schema_version: 'deft.owner_resource_page_limits_review.v1', binding_id: binding.id,
        registration_id: registration.id, runtime_epoch: registration.runtime_epoch,
        previous_consent_digest: binding.attachment_consent_digest, previous_max_records_per_page: binding.max_records_per_page,
        consent };
      const review_digest = digestAppGrantValue(review);
      if (!activate) return { ...review, review_digest };
      if (!('expected_review_digest' in input) || input.expected_review_digest !== review_digest) throw stale();
      // No queued/active sync may lose its reviewed authorization during this amendment.
      const active = await tx.select({ id: appRuns.id }).from(appRuns).where(and(eq(appRuns.org_id, actor.org_id),
        eq(appRuns.origin_resource_binding_id, binding.id), inArray(appRuns.state, ['pending', 'running', 'waiting_external']))).limit(1);
      if (active.length) throw new AppError('Private sync is active', 'APP_STATE_CONFLICT', 409);
      const now = this.now();
      // The database amendment guard requires old sync sessions retired first, atomically with the CAS.
      await tx.update(appRuntimeSessions).set({ revoked_at: now }).where(and(eq(appRuntimeSessions.org_id, actor.org_id),
        eq(appRuntimeSessions.resource_binding_id, binding.id), eq(appRuntimeSessions.runtime_registration_id, registration.id),
        eq(appRuntimeSessions.audience, 'app_resource_sync'), isNull(appRuntimeSessions.revoked_at)));
      const changed = await tx.update(appResourceBindings).set({ max_records_per_page: input.max_records_per_page,
        attachment_consent_digest: digestAppGrantValue(consent), updated_at: now }).where(and(eq(appResourceBindings.org_id, actor.org_id),
          eq(appResourceBindings.id, binding.id), eq(appResourceBindings.state, 'active'),
          eq(appResourceBindings.attachment_consent_digest, binding.attachment_consent_digest!))).returning({ id: appResourceBindings.id });
      if (changed.length !== 1) throw stale();
      await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human', actor_id: actor.actor_id,
        action: 'app.owner_resource_page_limits_activate', entity_type: 'app_resource_binding', entity_id: binding.id,
        metadata: { previous_max_records_per_page: binding.max_records_per_page, max_records_per_page: input.max_records_per_page,
          previous_consent_digest: binding.attachment_consent_digest, consent_digest: digestAppGrantValue(consent), review_digest } });
      return { binding_id: binding.id, registration_id: registration.id, max_records_per_page: input.max_records_per_page,
        consent_digest: digestAppGrantValue(consent), review_digest };
    }, expiresAt);
  }
  private async administrativeReview(tx: AppRunTransaction, actor: Human, input: z.infer<typeof OwnerConnectionAdmissionInputSchema>) {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    await assertOwnerConnectionMember(tx, actor.org_id, input.operator_user_id);
    const reviewed = await loadReviewedAttachmentApp(tx, actor.org_id, input.installation_id);
    const { installation, version, grant, manifest } = reviewed;
    const policy = manifest.owner_connections?.find(item => item.key === input.policy_key);
    const descriptor = manifest.sync_descriptors.find(item => item.key === policy?.resource_key);
    if (!policy || !descriptor || version.id !== input.expected_app_version_id || version.package_digest !== input.expected_package_digest
      || grant.snapshot_digest !== input.expected_grant_snapshot_digest || installation.lifecycle_epoch !== input.expected_lifecycle_epoch
      || installation.grant_epoch !== input.expected_grant_epoch) throw stale();
    const connectionProfile = await resolveOwnerConnectionProfile(actor.org_id, installation.id, policy, input.operator_user_id, tx);
    const actions = runtimeActionDescriptors(manifest).filter(action => policy.action_keys.includes(action.action_key))
      .map(action => ({ action_key: action.action_key, contract_digest: action.contract_digest }))
      .sort((a,b) => a.action_key < b.action_key ? -1 : a.action_key > b.action_key ? 1 : 0);
    const snapshot = OwnerConnectionAdmissionSnapshotSchema.parse({ schema_version: 'deft.owner_connection_admission.v1',
      org_id: actor.org_id, installation_id: installation.id, app_version_id: version.id, grant_snapshot_id: grant.id,
      package_digest: version.package_digest, grant_snapshot_digest: grant.snapshot_digest, lifecycle_epoch: installation.lifecycle_epoch,
      grant_epoch: installation.grant_epoch, operator_user_id: input.operator_user_id, policy, policy_digest: digestAppGrantValue(policy),
      resource_descriptor_digest: await digestResourceSyncDescriptorV2(descriptor), actions, limits: input.limits,
      ...(connectionProfile ? { connection_profile: connectionProfile, connection_profile_digest: connectionProfileDigest(connectionProfile),
        connection_transport_digest: await ownerConnectionTransportDigest(actor.org_id, installation.id, connectionProfile, tx) } : {}) });
    return { snapshot, review_digest: digestAppGrantValue(snapshot) };
  }
  async reviewAdmission(actor: ModuleActor, raw: unknown, guard: WebAuthorityGuard) {
    human(actor); const input = OwnerConnectionAdmissionInputSchema.parse(raw);
    return this.guarded(actor, input.operator_user_id, guard, tx => this.administrativeReview(tx, actor, input));
  }
  async activateAdmission(actor: ModuleActor, raw: unknown, guard: WebAuthorityGuard) {
    human(actor); const { expected_review_digest, accept_host_policy: _accept, ...input } = OwnerConnectionAdmissionInputSchema.extend(activation).parse(raw);
    return this.guarded(actor, input.operator_user_id, guard, async tx => {
      const review = await this.administrativeReview(tx, actor, input);
      if (review.review_digest !== expected_review_digest) throw stale();
      const id = randomUUID(), now = this.now();
      try { await tx.insert(appOwnerConnectionAdmissions).values({ id, org_id: actor.org_id, app_installation_id: input.installation_id,
        app_version_id: input.expected_app_version_id, grant_snapshot_id: review.snapshot.grant_snapshot_id, operator_user_id: input.operator_user_id,
        policy_key: input.policy_key, snapshot: review.snapshot, review_digest: review.review_digest, reviewed_by_user_id: actor.actor_id,
        reviewed_at: now, state: 'active', created_at: now, updated_at: now }); }
      catch (error) { if ((error as { code?: string; cause?: { code?: string } }).code === '23505'
        || (error as { cause?: { code?: string } }).cause?.code === '23505') throw new AppError('Private connection deployment already admitted', 'APP_STATE_CONFLICT', 409); throw error; }
      return { admission_id: id, admission_digest: review.review_digest };
    });
  }
  async revokeAdmission(actor: ModuleActor, admissionId: string, guard: WebAuthorityGuard) {
    human(actor); const locator = await this.admissionLocator(actor.org_id, z.string().uuid().parse(admissionId));
    return this.guarded(actor, locator.operator_user_id, guard, async tx => {
      await assertCurrentModuleManagerWithExecutor(tx, actor);
      await tx.execute(sql`SELECT id FROM app_installations WHERE org_id=${actor.org_id} AND id=${locator.app_installation_id} FOR UPDATE`);
      const [row] = await tx.select().from(appOwnerConnectionAdmissions).where(and(eq(appOwnerConnectionAdmissions.org_id, actor.org_id),
        eq(appOwnerConnectionAdmissions.id, locator.id))).limit(1).for('update');
      if (!row) throw ownerConnectionDenied();
      if (row.state === 'active') await tx.update(appOwnerConnectionAdmissions).set({ state: 'revoked', revoked_at: this.now(), updated_at: this.now() })
        .where(and(eq(appOwnerConnectionAdmissions.org_id, actor.org_id), eq(appOwnerConnectionAdmissions.id, row.id)));
      return { revoked: true };
    });
  }
  async context(actor: ModuleActor, installationId: string, guard: WebAuthorityGuard): Promise<OwnerConnectionContext> {
    human(actor); z.string().uuid().parse(installationId);
    const locators = await db.select(getTableColumns(appOwnerConnectionAdmissions)).from(appOwnerConnectionAdmissions)
      .innerJoin(appInstallations, and(eq(appInstallations.org_id, appOwnerConnectionAdmissions.org_id),
        eq(appInstallations.id, appOwnerConnectionAdmissions.app_installation_id),
        eq(appInstallations.active_version_id, appOwnerConnectionAdmissions.app_version_id),
        eq(appInstallations.active_grant_snapshot_id, appOwnerConnectionAdmissions.grant_snapshot_id)))
      .where(and(eq(appOwnerConnectionAdmissions.org_id, actor.org_id),
      eq(appOwnerConnectionAdmissions.app_installation_id, installationId), eq(appOwnerConnectionAdmissions.state, 'active'))).limit(16);
    let afterCommit = () => {};
    const result = await db.transaction(async tx => {
      await members(tx, actor.org_id, [actor.actor_id, ...locators.map(row => row.operator_user_id)]);
      await assertOwnerConnectionMember(tx, actor.org_id, actor.actor_id);
      const reviewed = await loadReviewedAttachmentApp(tx, actor.org_id, installationId), policies: OwnerConnectionContext['policies'][number][] = [];
      const clock = await samplePrivateAccessClock(tx, this.now);
      for (const policy of reviewed.manifest.owner_connections ?? []) {
        // Unadmitted declarations are setup choices, not account authority.
        // Resolve deployment pins only for an actual admission below; an
        // optional provider must not hide another provider's usable account.
        const locator = locators.find(row => row.policy_key === policy.key && row.app_version_id === reviewed.version.id && row.grant_snapshot_id === reviewed.grant.id);
        let admission: OwnerConnectionContext['policies'][number]['admission'] = null;
        const recoveryTargets = new Set<string>();
        const owned = locator ? await tx.select().from(appResourceBindings).innerJoin(appRuntimeRegistrations, and(
          eq(appRuntimeRegistrations.org_id, appResourceBindings.org_id), eq(appRuntimeRegistrations.id, appResourceBindings.runtime_registration_id)))
          .where(and(eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.owner_user_id, actor.actor_id),
            eq(appRuntimeRegistrations.owner_connection_admission_id, locator.id), inArray(appResourceBindings.state, ['active', 'disabled']))).limit(16) : [];
        if (locator) {
          const current = await loadOwnerConnectionAdmission(tx, actor.org_id, { admission_id: locator.id, admission_digest: locator.review_digest });
          const retained = await tx.select({ binding: { target_key: appResourceBindings.target_key, app_version_id: appResourceBindings.app_version_id,
            grant_snapshot_id: appResourceBindings.grant_snapshot_id, descriptor_digest: appResourceBindings.descriptor_digest },
            registration: { app_installation_id: appRuntimeRegistrations.app_installation_id, app_version_id: appRuntimeRegistrations.app_version_id,
              grant_snapshot_id: appRuntimeRegistrations.grant_snapshot_id, operator_user_id: appRuntimeRegistrations.operator_user_id },
            historical: { snapshot: appOwnerConnectionAdmissions.snapshot, review_digest: appOwnerConnectionAdmissions.review_digest,
              app_installation_id: appOwnerConnectionAdmissions.app_installation_id, app_version_id: appOwnerConnectionAdmissions.app_version_id,
              grant_snapshot_id: appOwnerConnectionAdmissions.grant_snapshot_id, operator_user_id: appOwnerConnectionAdmissions.operator_user_id } }).from(appResourceBindings)
            .innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, appResourceBindings.org_id),
              eq(appRuntimeRegistrations.id, appResourceBindings.runtime_registration_id)))
            .innerJoin(appOwnerConnectionAdmissions, and(eq(appOwnerConnectionAdmissions.org_id, appRuntimeRegistrations.org_id),
              eq(appOwnerConnectionAdmissions.id, appRuntimeRegistrations.owner_connection_admission_id),
              eq(appOwnerConnectionAdmissions.review_digest, appRuntimeRegistrations.owner_connection_admission_digest)))
            .where(and(eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.app_installation_id, installationId),
              eq(appResourceBindings.owner_user_id, actor.actor_id), eq(appResourceBindings.resource_key, policy.resource_key),
              eq(appResourceBindings.owner_scope, 'private_user'), eq(appResourceBindings.reviewed_by_user_id, actor.actor_id),
              inArray(appResourceBindings.state, ['active', 'disabled']), eq(appRuntimeRegistrations.reviewed_by_user_id, actor.actor_id),
              eq(appRuntimeRegistrations.operator_user_id, current.row.operator_user_id),
              inArray(appRuntimeRegistrations.state, ['active', 'disabled']),
              eq(appOwnerConnectionAdmissions.state, 'active'), isNull(appOwnerConnectionAdmissions.revoked_at),
              eq(appOwnerConnectionAdmissions.policy_key, policy.key))).limit(257);
          if (retained.length > 256) throw stale();
          for (const { binding, registration, historical } of retained) {
            const parsed = OwnerConnectionAdmissionSnapshotSchema.safeParse(historical.snapshot);
            if (!parsed.success || digestAppGrantValue(parsed.data) !== historical.review_digest
              || historical.app_installation_id !== installationId || registration.app_installation_id !== installationId
              || binding.app_version_id !== registration.app_version_id || historical.app_version_id !== registration.app_version_id
              || binding.grant_snapshot_id !== registration.grant_snapshot_id || historical.grant_snapshot_id !== registration.grant_snapshot_id
              || parsed.data.app_version_id !== historical.app_version_id || parsed.data.grant_snapshot_id !== historical.grant_snapshot_id
              || parsed.data.operator_user_id !== historical.operator_user_id || registration.operator_user_id !== historical.operator_user_id
              || binding.descriptor_digest !== parsed.data.resource_descriptor_digest
              || !compatibleOwnerRecoverySnapshot(current.snapshot, parsed.data)) continue;
            recoveryTargets.add(binding.target_key);
          }
          if (recoveryTargets.size > 16) throw stale();
          const [operator] = await tx.select({ name: users.name }).from(users).where(eq(users.id, current.row.operator_user_id));
          admission = { ...current.reference, operator_user_id: current.row.operator_user_id, operator_label: operator?.name ?? 'Reviewed operator',
            resource_request: { ...current.reference, target_key: 'personal', consent_expires_at: new Date(clock.issuance().getTime()
              + Math.min(policy.max_consent_seconds, 30 * 86400) * 1000).toISOString(), limits: current.snapshot.limits,
              attachment_policy: reviewed.manifest.sync_descriptors.find(item => item.key === policy.resource_key)!.attachments } };
        }
        const bindings = await Promise.all(owned.map(async ({ app_resource_bindings: binding }) => ({ binding_id: binding.id, target_key: binding.target_key,
          state: binding.state, consent_expires_at: binding.consent_expires_at?.toISOString() ?? null,...(binding.consent_lifetime?{consent_lifetime:binding.consent_lifetime}:{}),
          actions: await tx.select({ action_key: appRuntimeBindings.action_key, binding_id: appRuntimeBindings.id, state: appRuntimeBindings.state })
            .from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id, actor.org_id), eq(appRuntimeBindings.owner_resource_binding_id, binding.id),
              inArray(appRuntimeBindings.state, ['active', 'disabled']))).limit(16) })));
        policies.push({ policy, status: admission ? 'admitted' : 'deployment_review_required', admission,
          record_store_keys: ('record_stores' in reviewed.manifest ? reviewed.manifest.record_stores ?? [] : []).filter(store => store.resource_key === policy.resource_key).map(store => store.key),
          recovery_targets: [...recoveryTargets].sort().map(key => ({ key })), bindings });
      }
      await guard(tx); const deadline = guard.current_web_session_expires_at();
      afterCommit = () => { if (!isAppOwnerConnectionsEnabled() || clock.current() >= deadline) throw ownerConnectionDenied(); };
      afterCommit(); return { schema_version: 'deft.owner_connection_context.v1' as const, installation_id: installationId, policies };
    });
    afterCommit(); return result;
  }
  private async ownerInput(actor: Human, reference: OwnerConnectionAdmissionReference, guard: WebAuthorityGuard) {
    const locator = await this.admissionLocator(actor.org_id, reference.admission_id);
    return this.guarded(actor, locator.operator_user_id, guard, tx => loadOwnerConnectionAdmission(tx, actor.org_id, reference));
  }
  async resource(actor: ModuleActor, raw: unknown, guard: WebAuthorityGuard, activate = false) {
    human(actor); const parsed = (activate ? OwnerConnectionResourceRequestSchema.safeExtend(activation) : OwnerConnectionResourceRequestSchema).parse(raw);
    const reference = { admission_id: parsed.admission_id, admission_digest: parsed.admission_digest }, current = await this.ownerInput(actor, reference, guard);
    const input = { schema_version: 'deft.app_attachment_consent_request.v1', installation_id: current.row.app_installation_id,
      resource_key: current.policy.resource_key, operator_user_id: current.row.operator_user_id, expected_app_version_id: current.row.app_version_id,
      expected_package_digest: current.snapshot.package_digest, expected_grant_snapshot_digest: current.snapshot.grant_snapshot_digest,
      expected_lifecycle_epoch: current.snapshot.lifecycle_epoch, expected_grant_epoch: current.snapshot.grant_epoch,
      target_key: parsed.target_key, consent_expires_at: parsed.consent_expires_at,...(parsed.consent_lifetime?{consent_lifetime:parsed.consent_lifetime}:{}), limits: parsed.limits, attachment_policy: parsed.attachment_policy,
      ...(activate ? { expected_review_digest: 'expected_review_digest' in parsed ? parsed.expected_review_digest : undefined, accept_host_policy: true } : {}) };
    const management = new AppResourceSyncManagement(this.keys, this.now, 'attachment_v3');
    return activate ? management.activateConsent(actor, input, guard, reference) : management.prepareConsent(actor, input, guard, reference);
  }
  async action(actor: ModuleActor, raw: unknown, guard: WebAuthorityGuard, activate = false) {
    human(actor); const parsed = (activate ? OwnerConnectionActionRequestSchema.extend(activation) : OwnerConnectionActionRequestSchema).parse(raw);
    const reference = { admission_id: parsed.admission_id, admission_digest: parsed.admission_digest }, current = await this.ownerInput(actor, reference, guard);
    const input = { installation_id: current.row.app_installation_id, operator_user_id: current.row.operator_user_id, action_key: parsed.action_key,
      owner_resource_binding_id: parsed.owner_resource_binding_id, expected_app_version_id: current.row.app_version_id,
      expected_package_digest: current.snapshot.package_digest, expected_grant_snapshot_digest: current.snapshot.grant_snapshot_digest,
      expected_lifecycle_epoch: current.snapshot.lifecycle_epoch, expected_grant_epoch: current.snapshot.grant_epoch,
      ...(activate ? { expected_review_digest: 'expected_review_digest' in parsed ? parsed.expected_review_digest : undefined, accept_host_policy: true } : {}) };
    return activate ? activateRuntimeBinding(actor, input, { guard, ownerAdmission: reference })
      : prepareRuntimeBindingReview(actor, input, { guard, ownerAdmission: reference });
  }
}
