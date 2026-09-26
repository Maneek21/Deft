import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { digestResourceSyncDescriptor } from '@deft/app-kit/experimental/resource-sync';
import {
  appResourceBindings, appRuntimeRegistrations, appRuntimeSessions,
  appSyncCheckpoints, auditLog, orgMembers, users,
} from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { isModuleError } from './module-errors.js';
import { assertCurrentModuleManagerWithExecutor } from './module-service.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { persistCapabilityProviderSnapshotWithExecutor } from './capability-provider-snapshot-repository.js';
import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import { createResourceSyncDiscoverySnapshot } from './app-resource-sync-discovery.js';
import { loadReviewedResourceSyncDescriptor } from './app-resource-sync-reviewed.js';
import { loadLiveResourceSyncBindingAuthority,
  loadLiveResourceSyncAuthority, resourceSyncParticipantsAreHuman } from './app-resource-sync-authority.js';
import { APP_RESOURCE_SYNC_HOST_POLICY, APP_RESOURCE_SYNC_SESSION_MS, APP_RESOURCE_SYNC_MAX_CONSENT_MS,
  APP_RESOURCE_SYNC_LIMIT_BOUNDS,
  AppResourceSyncConsentActivationSchema, AppResourceSyncConsentRequestSchema,
  assertResourceSyncConsentWindow, hashAppResourceSyncToken,
  type AppResourceSyncConsentRequest } from './app-resource-sync-policy.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ResourceSyncManagementGuard = (tx: Tx) => Promise<void>;

async function managementTransaction<T>(guard: ResourceSyncManagementGuard | undefined,
  operation: (tx: Tx) => Promise<T>, assertFinal?: (result: T, tx: Tx) => void | Promise<void>): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await operation(tx);
    await guard?.(tx);
    await assertFinal?.(result, tx);
    return result;
  });
}
type Human = Extract<ModuleActor, { kind: 'human' }>;
const Id = z.string().uuid();
const stale = () => new AppError('Private resource sync authority changed', 'APP_STALE', 409);
const denied = () => new AppError('Private resource sync access denied', 'APP_ACCESS_DENIED', 403);
function assertBeforeDeadline(deadline: Date, clock: () => Date) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || deadline <= now) throw stale();
}
const conflict = () => new AppError('Private resource sync already has current consent', 'APP_STATE_CONFLICT', 409);

function reviewer(actor: ModuleActor): asserts actor is Human {
  if (actor.kind !== 'human' || !['owner', 'admin'].includes(actor.role)
    || !['ui', 'rest'].includes(actor.source)) throw denied();
}
function operator(actor: ModuleActor): asserts actor is Human {
  if (actor.kind !== 'human' || !['ui', 'rest'].includes(actor.source)) throw denied();
}
async function assertManager(tx: Tx, actor: Human) {
  try { await assertCurrentModuleManagerWithExecutor(tx, actor); }
  catch (error) { if (isModuleError(error)) throw denied(); throw error; }
  const [user] = await tx.select({ kind: users.kind }).from(users).where(eq(users.id, actor.actor_id));
  if (user?.kind !== 'human') throw denied();
}
async function lockMembers(tx: Tx, orgId: string, userIds: readonly string[], mode: 'SHARE' | 'UPDATE') {
  for (const userId of [...new Set(userIds)].sort()) {
    if (mode === 'UPDATE') await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${orgId}
      AND user_id = ${userId} FOR UPDATE`);
    else await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${orgId}
      AND user_id = ${userId} FOR SHARE`);
  }
}

export class AppResourceSyncManagement {
  readonly #secrets: AppResourceSyncSecretService;
  constructor(keys: AppRunKeyProvider, private readonly clock: () => Date = () => new Date()) {
    this.#secrets = new AppResourceSyncSecretService(keys);
  }

  /** Discovery conveys no private read or Runtime authority. The only operator
   * offered by this initial setup surface is the current manager-owner. */
  async setupContext(actor: ModuleActor, value: unknown, guard?: ResourceSyncManagementGuard) {
    reviewer(actor);
    const { installation_id } = z.strictObject({ installation_id: Id }).parse(value);
    return db.transaction(async (tx) => {
      await assertManager(tx, actor);
      const reviewed = await loadReviewedResourceSyncDescriptor(tx, actor.org_id, installation_id);
      const { installation, version, grant } = reviewed;
      const bindings = await tx.select({ binding_id: appResourceBindings.id,
        resource_key: appResourceBindings.resource_key, state: appResourceBindings.state,
        operator_user_id: appRuntimeRegistrations.operator_user_id,
        registration_state: appRuntimeRegistrations.state,
        consent_expires_at: appResourceBindings.consent_expires_at })
        .from(appResourceBindings).innerJoin(appRuntimeRegistrations, and(
          eq(appRuntimeRegistrations.org_id, appResourceBindings.org_id),
          eq(appRuntimeRegistrations.id, appResourceBindings.runtime_registration_id)))
        .where(and(eq(appResourceBindings.org_id, actor.org_id),
          eq(appResourceBindings.app_installation_id, installation.id),
          eq(appResourceBindings.grant_snapshot_id, grant.id),
          eq(appResourceBindings.owner_user_id, actor.actor_id),
          inArray(appResourceBindings.state, ['active', 'disabled'])))
        // Advisory locator only: registration/binding authority is rechecked by
        // every operation. Joined rowmarks can lock binding before registration.
        .limit(8);
      const descriptors = await Promise.all(reviewed.descriptors.map(async (descriptor) => ({
        resource_key: descriptor.key, resource_type: descriptor.resource_type,
        visibility: descriptor.requested_visibility,
        descriptor_digest: await digestResourceSyncDescriptor(descriptor),
      })));
      await guard?.(tx);
      if (!await resourceSyncParticipantsAreHuman(tx, actor.actor_id, actor.actor_id)) throw denied();
      const now = this.clock();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      return { schema_version: 'deft.app_resource_sync_setup.v1' as const,
        org_id: actor.org_id, owner_user_id: actor.actor_id, operator_user_id: actor.actor_id,
        installation_id: installation.id, app_version_id: version.id,
        host_policy: APP_RESOURCE_SYNC_HOST_POLICY,
        host_limits: { max_consent_ms: APP_RESOURCE_SYNC_MAX_CONSENT_MS,
          session_ms: APP_RESOURCE_SYNC_SESSION_MS, limits: APP_RESOURCE_SYNC_LIMIT_BOUNDS },
        descriptors: descriptors.map((descriptor) => {
          const binding = bindings.find((item) => item.resource_key === descriptor.resource_key);
          const consent_request: AppResourceSyncConsentRequest = {
            installation_id: installation.id, resource_key: descriptor.resource_key,
            operator_user_id: actor.actor_id, expected_app_version_id: version.id,
            expected_package_digest: version.package_digest,
            expected_grant_snapshot_digest: grant.snapshot_digest,
            expected_lifecycle_epoch: installation.lifecycle_epoch,
            expected_grant_epoch: installation.grant_epoch,
            consent_expires_at: expiresAt, limits: {
              max_records_per_page: 100, max_page_bytes: 524_288,
              max_retained_records: 10_000, max_retained_bytes: 104_857_600,
              min_interval_seconds: 300,
            },
          };
          return { ...descriptor, consent_request,
            existing_binding: binding ? { binding_id: binding.binding_id,
              state: binding.state as 'active' | 'disabled',
              consent_expires_at: binding.consent_expires_at?.toISOString() ?? null,
              can_issue_session: binding.operator_user_id === actor.actor_id
                && binding.registration_state === 'active' && binding.state === 'active'
                && binding.consent_expires_at !== null && binding.consent_expires_at > now,
              requires_revoke: binding.state !== 'active' || !binding.consent_expires_at
                || binding.consent_expires_at <= now } : null };
        }),
      };
    });
  }

  async #reviewContext(tx: Tx, actor: Human, input: AppResourceSyncConsentRequest,
    activation: boolean) {
    await lockMembers(tx, actor.org_id, [actor.actor_id, input.operator_user_id], 'UPDATE');
    await assertManager(tx, actor);
    const [operatorMember] = await tx.select({ is_active: orgMembers.is_active, role: orgMembers.role, kind: users.kind })
      .from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id))
      .where(and(eq(orgMembers.org_id, actor.org_id),
        eq(orgMembers.user_id, input.operator_user_id))).limit(1);
    if (!operatorMember?.is_active || operatorMember.role === 'guest' || operatorMember.kind !== 'human') throw denied();
    if (activation) await tx.execute(sql`SELECT id FROM app_installations
      WHERE org_id = ${actor.org_id} AND id = ${input.installation_id} FOR UPDATE`);
    const reviewed = await loadReviewedResourceSyncDescriptor(tx, actor.org_id,
      input.installation_id, input.resource_key);
    const { installation, version, grant, descriptor, descriptor_digest } = reviewed;
    if (version.id !== input.expected_app_version_id
      || version.package_digest !== input.expected_package_digest
      || grant.snapshot_digest !== input.expected_grant_snapshot_digest
      || installation.lifecycle_epoch !== input.expected_lifecycle_epoch
      || installation.grant_epoch !== input.expected_grant_epoch) throw stale();
    let expiresAt: Date;
    try { expiresAt = assertResourceSyncConsentWindow(input.consent_expires_at, this.clock()); }
    catch { throw activation ? stale() : new AppError('Invalid private sync consent window',
      'APP_ACTION_INVALID', 400); }
    const review = Object.freeze({ schema_version: 'deft.app_resource_sync_consent_review.v1' as const,
      org_id: actor.org_id, owner_user_id: actor.actor_id,
      installation_id: installation.id, app_version_id: version.id,
      grant_snapshot_id: grant.id, grant_snapshot_digest: grant.snapshot_digest,
      package_digest: version.package_digest, lifecycle_epoch: installation.lifecycle_epoch,
      grant_epoch: installation.grant_epoch, operator_user_id: input.operator_user_id,
      resource_key: descriptor.key, descriptor_digest,
      consent_expires_at: expiresAt.toISOString(), limits: input.limits,
      host_policy: APP_RESOURCE_SYNC_HOST_POLICY });
    return { ...reviewed, expiresAt,
      review: Object.freeze({ ...review, review_digest: digestAppGrantValue(review) }) };
  }

  async prepareConsent(actor: ModuleActor, value: unknown, guard?: ResourceSyncManagementGuard) {
    reviewer(actor);
    const input = AppResourceSyncConsentRequestSchema.parse(value);
    return managementTransaction(guard, async (tx) => (await this.#reviewContext(tx, actor, input, false)).review);
  }

  async activateConsent(actor: ModuleActor, value: unknown, guard?: ResourceSyncManagementGuard) {
    reviewer(actor);
    const input = AppResourceSyncConsentActivationSchema.parse(value);
    return managementTransaction(guard, async (tx) => {
      const { installation, version, grant, descriptor, descriptor_digest, expiresAt, review } =
        await this.#reviewContext(tx, actor, input, true);
      if (review.review_digest !== input.expected_review_digest) throw stale();
      const [existing] = await tx.select({ id: appResourceBindings.id }).from(appResourceBindings)
        .where(and(eq(appResourceBindings.org_id, actor.org_id),
          eq(appResourceBindings.app_installation_id, installation.id),
          eq(appResourceBindings.grant_snapshot_id, grant.id),
          eq(appResourceBindings.owner_user_id, actor.actor_id),
          eq(appResourceBindings.resource_key, descriptor.key),
          inArray(appResourceBindings.state, ['disabled', 'active']))).limit(1);
      if (existing) throw conflict();
      const now = this.clock();
      if (expiresAt <= now) throw stale();
      const registrationId = randomUUID();
      const bindingId = randomUUID();
      const checkpointId = randomUUID();
      const providerSnapshot = await createResourceSyncDiscoverySnapshot({
        org_id: actor.org_id, registration_id: registrationId, descriptor, captured_at: now });
      await tx.insert(appRuntimeRegistrations).values({ id: registrationId, org_id: actor.org_id,
        app_installation_id: installation.id, app_version_id: version.id,
        grant_snapshot_id: grant.id, operator_user_id: input.operator_user_id,
        contract_version: 'deft.app_runtime_channel.v2', state: 'disabled',
        created_at: now, updated_at: now });
      const providerSnapshotId = await persistCapabilityProviderSnapshotWithExecutor(tx, providerSnapshot);
      await tx.insert(appResourceBindings).values({ id: bindingId, org_id: actor.org_id,
        app_installation_id: installation.id, app_version_id: version.id,
        grant_snapshot_id: grant.id, runtime_registration_id: registrationId,
        registration_contract_version: 'deft.app_runtime_channel.v2',
        provider_kind: 'app_runtime', provider_instance_id: registrationId,
        provider_snapshot_id: providerSnapshotId,
        resource_key: descriptor.key, resource_family: descriptor.resource_type,
        operation_name: `sync_${descriptor.key}`,
        interface_identity: `deft.resource_sync.v2:${actor.org_id.toLowerCase()}:${installation.id.toLowerCase()}:${descriptor.key}`,
        reviewed_descriptor: descriptor, descriptor_digest,
        owner_user_id: actor.actor_id, owner_scope: 'private_user',
        ...APP_RESOURCE_SYNC_HOST_POLICY,
        ...input.limits,
        state: 'disabled', created_at: now, updated_at: now });
      const cursor = this.#secrets.cursorFingerprint(null, { org_id: actor.org_id,
        resource_binding_id: bindingId, checkpoint_id: checkpointId,
        payload_kind: 'cursor', generation: 1, cursor_sequence: 0 });
      await tx.insert(appSyncCheckpoints).values({ id: checkpointId, org_id: actor.org_id,
        resource_binding_id: bindingId, generation: 1, state: 'active', cursor_sequence: 0,
        cursor_hmac_key_version: cursor.key_version, cursor_hmac: cursor.fingerprint,
        cursor_state: 'empty', cursor_bytes: 0, retained_record_count: 0, retained_bytes: 0,
        created_at: now, updated_at: now });
      await tx.update(appRuntimeRegistrations).set({ state: 'active', runtime_epoch: 1,
        reviewed_by_user_id: actor.actor_id, reviewed_at: now, updated_at: now })
        .where(and(eq(appRuntimeRegistrations.org_id, actor.org_id),
          eq(appRuntimeRegistrations.id, registrationId)));
      await tx.update(appResourceBindings).set({ state: 'active',
        reviewed_by_user_id: actor.actor_id, reviewed_at: now,
        consent_expires_at: expiresAt, updated_at: now })
        .where(and(eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.id, bindingId)));
      const live = await loadLiveResourceSyncBindingAuthority(tx, { org_id: actor.org_id,
        resource_binding_id: bindingId, clock: this.clock });
      if (!live) throw stale();
      await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human',
        actor_id: actor.actor_id, action: 'app.resource_sync_consent_activate',
        entity_type: 'app_resource_binding', entity_id: bindingId,
        before_state: null, after_state: { registration_id: registrationId,
          binding_id: bindingId, checkpoint_id: checkpointId, installation_id: installation.id,
          app_version_id: version.id, grant_snapshot_id: grant.id,
          descriptor_digest, review_digest: review.review_digest },
        metadata: { source: actor.source } });
      return Object.freeze({ registration_id: registrationId, binding_id: bindingId,
        checkpoint_id: checkpointId, app_version_id: version.id,
        grant_snapshot_id: grant.id, resource_key: descriptor.key,
        review_digest: review.review_digest });
    }, async (_result, tx) => {
      if (!await resourceSyncParticipantsAreHuman(tx, actor.actor_id, input.operator_user_id)) throw denied();
      assertBeforeDeadline(new Date(input.consent_expires_at), this.clock);
    });
  }

  async issueOperatorSession(actor: ModuleActor, bindingId: string, guard?: ResourceSyncManagementGuard) {
    operator(actor);
    bindingId = Id.parse(bindingId);
    const sessionId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashAppResourceSyncToken(token);
    const issued = await managementTransaction(guard, async (tx) => {
      const live = await loadLiveResourceSyncBindingAuthority(tx, { org_id: actor.org_id,
        resource_binding_id: bindingId, clock: this.clock });
      if (!live || live.registration.operator_user_id !== actor.actor_id) throw denied();
      const checkedAt = this.clock();
      if (live.binding.consent_expires_at === null || live.binding.consent_expires_at <= checkedAt) throw stale();
      const expiresAt = new Date(Math.min(checkedAt.getTime() + APP_RESOURCE_SYNC_SESSION_MS,
        live.binding.consent_expires_at.getTime()));
      await tx.insert(appRuntimeSessions).values({ id: sessionId, org_id: actor.org_id,
        runtime_registration_id: live.registration.id, runtime_binding_id: null,
        resource_binding_id: live.binding.id, operator_user_id: actor.actor_id,
        token_hash: tokenHash, audience: 'app_resource_sync', session_epoch: 0,
        runtime_epoch: live.registration.runtime_epoch,
        lifecycle_epoch: live.installation.lifecycle_epoch,
        grant_epoch: live.installation.grant_epoch, expires_at: expiresAt,
        created_at: checkedAt, updated_at: checkedAt });
      if (!await loadLiveResourceSyncAuthority(tx, { org_id: actor.org_id,
        session_id: sessionId, token_hash: tokenHash, clock: this.clock })) throw stale();
      await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human',
        actor_id: actor.actor_id, action: 'app.resource_sync_session_issue',
        entity_type: 'app_runtime_session', entity_id: sessionId,
        before_state: null, after_state: { resource_binding_id: live.binding.id,
          runtime_registration_id: live.registration.id,
          audience: 'app_resource_sync', expires_at: expiresAt.toISOString() },
        metadata: { source: actor.source } });
      return { expiresAt, ownerUserId: live.binding.owner_user_id,
        operatorUserId: live.registration.operator_user_id };
    }, async (result, tx) => {
      if (!await resourceSyncParticipantsAreHuman(tx, result.ownerUserId, result.operatorUserId)) throw denied();
      assertBeforeDeadline(result.expiresAt, this.clock);
    });
    return Object.freeze({ session_id: sessionId, session_token: token, expires_at: issued.expiresAt });
  }

  /** The private owner can end consent without retaining a live App grant. */
  async revokeConsent(actor: ModuleActor, bindingId: string, guard?: ResourceSyncManagementGuard) {
    reviewer(actor);
    bindingId = Id.parse(bindingId);
    return managementTransaction(guard, async (tx) => {
      const [locator] = await tx.select({ owner_user_id: appResourceBindings.owner_user_id,
        installation_id: appResourceBindings.app_installation_id,
        registration_id: appResourceBindings.runtime_registration_id })
        .from(appResourceBindings).where(and(eq(appResourceBindings.org_id, actor.org_id),
          eq(appResourceBindings.id, bindingId))).limit(1);
      if (!locator || locator.owner_user_id !== actor.actor_id) throw denied();
      const [registrationLocator] = await tx.select({ operator_user_id: appRuntimeRegistrations.operator_user_id })
        .from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id, actor.org_id),
          eq(appRuntimeRegistrations.id, locator.registration_id))).limit(1);
      if (!registrationLocator) throw stale();
      await lockMembers(tx, actor.org_id, [actor.actor_id, registrationLocator.operator_user_id], 'UPDATE');
      await assertManager(tx, actor);
      await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${actor.org_id}
        AND id = ${locator.installation_id} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM app_runtime_registrations WHERE org_id = ${actor.org_id}
        AND id = ${locator.registration_id} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM app_resource_bindings WHERE org_id = ${actor.org_id}
        AND id = ${bindingId} FOR UPDATE`);
      const [binding] = await tx.select().from(appResourceBindings).where(and(
        eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.id, bindingId))).limit(1);
      const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(
        eq(appRuntimeRegistrations.org_id, actor.org_id),
        eq(appRuntimeRegistrations.id, locator.registration_id))).limit(1);
      if (!binding || !registration || binding.owner_user_id !== actor.actor_id
        || binding.app_installation_id !== locator.installation_id
        || binding.runtime_registration_id !== registration.id
        || registration.operator_user_id !== registrationLocator.operator_user_id) throw stale();
      if (binding.state === 'revoked') return { revoked: true };
      const now = this.clock();
      await tx.update(appResourceBindings).set({ state: 'revoked', updated_at: now }).where(and(
        eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.id, bindingId)));
      await tx.update(appRuntimeRegistrations).set({ state: 'revoked',
        runtime_epoch: registration.runtime_epoch + 1, updated_at: now }).where(and(
        eq(appRuntimeRegistrations.org_id, actor.org_id), eq(appRuntimeRegistrations.id, registration.id)));
      await tx.update(appRuntimeSessions).set({ revoked_at: now, updated_at: now }).where(and(
        eq(appRuntimeSessions.org_id, actor.org_id),
        eq(appRuntimeSessions.resource_binding_id, bindingId),
        eq(appRuntimeSessions.audience, 'app_resource_sync'),
        sql`${appRuntimeSessions.revoked_at} IS NULL`));
      await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human',
        actor_id: actor.actor_id, action: 'app.resource_sync_consent_revoke',
        entity_type: 'app_resource_binding', entity_id: bindingId,
        before_state: { state: binding.state }, after_state: { state: 'revoked' },
        metadata: { source: actor.source } });
      return { revoked: true };
    });
  }

  /** Emergency operator registration revoke. A registration is per consent. */
  async revokeRegistration(actor: ModuleActor, registrationId: string, guard?: ResourceSyncManagementGuard) {
    reviewer(actor);
    registrationId = Id.parse(registrationId);
    return managementTransaction(guard, async (tx) => {
      const [locator] = await tx.select({ installation_id: appRuntimeRegistrations.app_installation_id,
        operator_user_id: appRuntimeRegistrations.operator_user_id })
        .from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id, actor.org_id),
          eq(appRuntimeRegistrations.id, registrationId),
          eq(appRuntimeRegistrations.contract_version, 'deft.app_runtime_channel.v2'))).limit(1);
      if (!locator) throw denied();
      const [bindingLocator] = await tx.select({ id: appResourceBindings.id,
        owner_user_id: appResourceBindings.owner_user_id })
        .from(appResourceBindings).where(and(eq(appResourceBindings.org_id, actor.org_id),
          eq(appResourceBindings.runtime_registration_id, registrationId))).limit(1);
      if (!bindingLocator) throw stale();
      await lockMembers(tx, actor.org_id,
        [actor.actor_id, locator.operator_user_id, bindingLocator.owner_user_id], 'UPDATE');
      await assertManager(tx, actor);
      await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${actor.org_id}
        AND id = ${locator.installation_id} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM app_runtime_registrations WHERE org_id = ${actor.org_id}
        AND id = ${registrationId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM app_resource_bindings WHERE org_id = ${actor.org_id}
        AND id = ${bindingLocator.id} FOR UPDATE`);
      const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(
        eq(appRuntimeRegistrations.org_id, actor.org_id),
        eq(appRuntimeRegistrations.id, registrationId))).limit(1);
      const [binding] = await tx.select().from(appResourceBindings).where(and(
        eq(appResourceBindings.org_id, actor.org_id),
        eq(appResourceBindings.id, bindingLocator.id))).limit(1);
      if (!registration || !binding || registration.contract_version !== 'deft.app_runtime_channel.v2'
        || registration.app_installation_id !== locator.installation_id
        || registration.operator_user_id !== locator.operator_user_id
        || binding.runtime_registration_id !== registration.id
        || binding.owner_user_id !== bindingLocator.owner_user_id) throw stale();
      if (registration.state === 'revoked') return { revoked: true };
      const now = this.clock();
      await tx.update(appRuntimeRegistrations).set({ state: 'revoked',
        runtime_epoch: registration.runtime_epoch + 1, updated_at: now }).where(and(
        eq(appRuntimeRegistrations.org_id, actor.org_id), eq(appRuntimeRegistrations.id, registrationId)));
      await tx.update(appResourceBindings).set({ state: 'revoked', updated_at: now }).where(and(
        eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.id, binding.id)));
      await tx.update(appRuntimeSessions).set({ revoked_at: now, updated_at: now }).where(and(
        eq(appRuntimeSessions.org_id, actor.org_id),
        eq(appRuntimeSessions.runtime_registration_id, registrationId),
        eq(appRuntimeSessions.audience, 'app_resource_sync'),
        sql`${appRuntimeSessions.revoked_at} IS NULL`));
      await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human',
        actor_id: actor.actor_id, action: 'app.resource_sync_registration_revoke',
        entity_type: 'app_runtime_registration', entity_id: registrationId,
        before_state: { state: registration.state, runtime_epoch: registration.runtime_epoch },
        after_state: { state: 'revoked', runtime_epoch: registration.runtime_epoch + 1 },
        metadata: { source: actor.source } });
      return { revoked: true };
    });
  }

  async revokeOperatorSession(actor: ModuleActor, sessionId: string, guard?: ResourceSyncManagementGuard) {
    operator(actor);
    sessionId = Id.parse(sessionId);
    return managementTransaction(guard, async (tx) => {
      const [locator] = await tx.select({ audience: appRuntimeSessions.audience,
        operator_user_id: appRuntimeSessions.operator_user_id,
        registration_id: appRuntimeSessions.runtime_registration_id,
        resource_binding_id: appRuntimeSessions.resource_binding_id,
        runtime_binding_id: appRuntimeSessions.runtime_binding_id })
        .from(appRuntimeSessions).where(and(eq(appRuntimeSessions.org_id, actor.org_id),
          eq(appRuntimeSessions.id, sessionId))).limit(1);
      if (!locator || locator.audience !== 'app_resource_sync'
        || !locator.resource_binding_id || locator.runtime_binding_id !== null
        || locator.operator_user_id !== actor.actor_id) throw denied();
      const [bindingLocator] = await tx.select({ owner_user_id: appResourceBindings.owner_user_id,
        installation_id: appResourceBindings.app_installation_id })
        .from(appResourceBindings).where(and(eq(appResourceBindings.org_id, actor.org_id),
          eq(appResourceBindings.id, locator.resource_binding_id))).limit(1);
      if (!bindingLocator) throw stale();
      await lockMembers(tx, actor.org_id, [actor.actor_id, bindingLocator.owner_user_id], 'SHARE');
      const [member] = await tx.select({ is_active: orgMembers.is_active, role: orgMembers.role })
        .from(orgMembers).where(and(eq(orgMembers.org_id, actor.org_id),
          eq(orgMembers.user_id, actor.actor_id))).limit(1);
      if (!member?.is_active || member.role === 'guest') throw denied();
      await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${actor.org_id}
        AND id = ${bindingLocator.installation_id} FOR SHARE`);
      await tx.execute(sql`SELECT id FROM app_runtime_registrations WHERE org_id = ${actor.org_id}
        AND id = ${locator.registration_id} FOR SHARE`);
      await tx.execute(sql`SELECT id FROM app_resource_bindings WHERE org_id = ${actor.org_id}
        AND id = ${locator.resource_binding_id} FOR SHARE`);
      await tx.execute(sql`SELECT id FROM app_runtime_sessions WHERE org_id = ${actor.org_id}
        AND id = ${sessionId} FOR UPDATE`);
      const [session] = await tx.select().from(appRuntimeSessions).where(and(
        eq(appRuntimeSessions.org_id, actor.org_id), eq(appRuntimeSessions.id, sessionId))).limit(1);
      if (!session || session.audience !== 'app_resource_sync' || session.runtime_binding_id !== null
        || session.resource_binding_id !== locator.resource_binding_id
        || session.runtime_registration_id !== locator.registration_id
        || session.operator_user_id !== actor.actor_id) throw stale();
      if (session.revoked_at) return { revoked: true };
      const now = this.clock();
      await tx.update(appRuntimeSessions).set({ revoked_at: now, updated_at: now }).where(and(
        eq(appRuntimeSessions.org_id, actor.org_id), eq(appRuntimeSessions.id, sessionId)));
      await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human',
        actor_id: actor.actor_id, action: 'app.resource_sync_session_revoke',
        entity_type: 'app_runtime_session', entity_id: sessionId,
        before_state: { revoked: false }, after_state: { revoked: true },
        metadata: { source: actor.source } });
      return { revoked: true };
    });
  }
}
