import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appInstallations, appRuntimeBindings, appRuntimeRegistrations, orgMembers } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { AppError } from './app-errors.js';
import { assertCurrentModuleManagerWithExecutor } from './module-service.js';
import { isModuleError } from './module-errors.js';
import { loadReviewedAttachmentApp, attachmentFinalAuthorityIsCurrent } from './app-attachment-authority.js';
import { runtimeActionDescriptors } from './app-runtime-review.js';
import { isAppV5RuntimeActionsEnabled } from './env.js';
import { appRuntimeChannelEnabled } from './app-runtime-channel.js';
import { experienceExposureDatabase } from './app-experience-exposure-db.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import { RuntimeSetupContextSchema } from './app-runtime-setup-contract.js';
const Id = z.string().uuid();
const stale = () => new AppError('Runtime setup changed. Refresh before reviewing.', 'APP_STALE', 409);
const denied = () => new AppError('Runtime setup unavailable', 'APP_ACCESS_DENIED', 403);
function enabled() { if (!appRuntimeChannelEnabled() || !isAppV5RuntimeActionsEnabled()) throw new AppError('Runtime actions unavailable', 'APP_FEATURE_DISABLED', 503); }
/** Read-only manager metadata. Existing mutation endpoints remain the sole
 * review, activation and explicit credential issuance paths. Bounded DB factory
 * retains checked-out slots until cancellation/rollback has settled. */
export async function getRuntimeSetupContext(actor: ModuleActor, installationId: string, versionId: string,
  options: { guard: WebAuthorityGuard; signal?: AbortSignal }) {
  if (actor.kind !== 'human' || !['owner','admin'].includes(actor.role) || !['ui','rest'].includes(actor.source)) throw denied();
  Id.parse(installationId); Id.parse(versionId); enabled();
  return experienceExposureDatabase().transaction(async tx => {
    const [manager] = await tx.select({active:orgMembers.is_active,role:orgMembers.role}).from(orgMembers)
      .where(and(eq(orgMembers.org_id,actor.org_id),eq(orgMembers.user_id,actor.actor_id))).limit(1);
    if (!manager?.active || !['owner','admin'].includes(manager.role)) throw denied();
    const [locator] = await tx.select({ version: appInstallations.active_version_id, grant: appInstallations.active_grant_snapshot_id })
      .from(appInstallations).where(and(eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, installationId))).limit(1);
    if (!locator || locator.version !== versionId || !locator.grant) throw stale();
    const locators = await tx.select({ id: appRuntimeBindings.id, registration: appRuntimeBindings.runtime_registration_id,
      operator: appRuntimeRegistrations.operator_user_id }).from(appRuntimeBindings)
      .innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, appRuntimeBindings.org_id), eq(appRuntimeRegistrations.id, appRuntimeBindings.runtime_registration_id)))
      .where(and(eq(appRuntimeBindings.org_id, actor.org_id), eq(appRuntimeBindings.app_installation_id, installationId),
        eq(appRuntimeBindings.app_version_id, versionId), eq(appRuntimeBindings.grant_snapshot_id, locator.grant),
        inArray(appRuntimeBindings.state, ['active','disabled']))).limit(17);
    if (locators.length > 16) throw stale();
    const participants = [...new Set([actor.actor_id, ...locators.map(row => row.operator)])].sort();
    for (const userId of participants) await tx.execute(sql`SELECT id FROM org_members WHERE org_id=${actor.org_id} AND user_id=${userId} ${sql.raw(userId === actor.actor_id ? 'FOR UPDATE' : 'FOR SHARE')}`);
    try { await assertCurrentModuleManagerWithExecutor(tx, actor); } catch (error) { if (isModuleError(error)) throw denied(); throw error; }
    const parent = await loadReviewedAttachmentApp(tx, actor.org_id, installationId);
    if (!parent.composition || parent.version.id !== versionId || parent.grant.id !== locator.grant) throw stale();
    const currentSet = await tx.select({ id: appRuntimeBindings.id }).from(appRuntimeBindings).where(and(
      eq(appRuntimeBindings.org_id, actor.org_id), eq(appRuntimeBindings.app_installation_id, installationId),
      eq(appRuntimeBindings.app_version_id, versionId), eq(appRuntimeBindings.grant_snapshot_id, parent.grant.id),
      inArray(appRuntimeBindings.state, ['active','disabled']))).limit(17);
    if (currentSet.length !== locators.length || currentSet.some(row => !locators.some(old => old.id === row.id))) throw stale();
    const descriptors = runtimeActionDescriptors(parent.manifest);
    if (descriptors.length > 16) throw stale();
    for (const registration of [...new Set(locators.map(row => row.registration))].sort()) await tx.execute(sql`SELECT id FROM app_runtime_registrations WHERE org_id=${actor.org_id} AND id=${registration} FOR SHARE`);
    for (const id of locators.map(row => row.id).sort()) await tx.execute(sql`SELECT id FROM app_runtime_bindings WHERE org_id=${actor.org_id} AND id=${id} FOR SHARE`);
    const bindings = locators.length ? await tx.select({ id: appRuntimeBindings.id, registration_id: appRuntimeBindings.runtime_registration_id,
      action_key: appRuntimeBindings.action_key, operator_user_id: appRuntimeRegistrations.operator_user_id,
      state: appRuntimeBindings.state, registration_state: appRuntimeRegistrations.state,
      installation: appRuntimeRegistrations.app_installation_id, version: appRuntimeRegistrations.app_version_id, grant: appRuntimeRegistrations.grant_snapshot_id })
      .from(appRuntimeBindings).innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, appRuntimeBindings.org_id), eq(appRuntimeRegistrations.id, appRuntimeBindings.runtime_registration_id)))
      .where(and(eq(appRuntimeBindings.org_id, actor.org_id), eq(appRuntimeBindings.app_installation_id, installationId),
        eq(appRuntimeBindings.app_version_id, versionId), eq(appRuntimeBindings.grant_snapshot_id, parent.grant.id),
        inArray(appRuntimeBindings.id, locators.map(row => row.id)))).limit(17) : [];
    if (bindings.length !== locators.length || bindings.some(row => !locators.some(old => old.id === row.id && old.registration === row.registration_id && old.operator === row.operator_user_id)
      || row.installation !== installationId || row.version !== versionId || row.grant !== parent.grant.id || !descriptors.some(d => d.action_key === row.action_key))) throw stale();
    const memberships = await tx.select({ user: orgMembers.user_id, active: orgMembers.is_active, role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, actor.org_id), inArray(orgMembers.user_id, participants))).limit(17);
    if (participants.some(user => !memberships.some(row => row.user === user && row.active && row.role !== 'guest'))) throw stale();
    const result = RuntimeSetupContextSchema.parse({ schema_version: 'deft.app_runtime_setup_context.v1', installation_id: installationId,
      app_version_id: versionId, grant_snapshot_id: parent.grant.id, package_digest: parent.version.package_digest,
      grant_snapshot_digest: parent.grant.snapshot_digest, lifecycle_epoch: parent.installation.lifecycle_epoch,
      grant_epoch: parent.installation.grant_epoch, operator_user_id: actor.actor_id,
      policy: { review_requirement: 'always', review_scope: 'per_invocation', retry_class: 'unsafe_or_unknown' },
      actions: descriptors.map(action => {
        const current = bindings.filter(row => row.action_key === action.action_key); if (current.length > 1) throw stale();
        const binding = current[0];
        return { key: action.action_key, label: parent.manifest.runtime_actions.find(row => row.key === action.action_key)?.label ?? action.action_key,
          review_request: { installation_id: installationId, action_key: action.action_key, operator_user_id: actor.actor_id,
            expected_app_version_id: versionId, expected_package_digest: parent.version.package_digest,
            expected_grant_snapshot_digest: parent.grant.snapshot_digest, expected_lifecycle_epoch: parent.installation.lifecycle_epoch,
            expected_grant_epoch: parent.installation.grant_epoch },
          binding: binding ? { id: binding.id, registration_id: binding.registration_id, operator_user_id: binding.operator_user_id,
            state: binding.state, registration_state: binding.registration_state,
            can_issue_session: binding.state === 'active' && binding.registration_state === 'active' && binding.operator_user_id === actor.actor_id } : null };
      }) });
    if (JSON.stringify(result).length > 64 * 1024) throw stale();
    if (!await attachmentFinalAuthorityIsCurrent(tx, participants, { guard: options.guard, signal: options.signal })) throw stale();
    enabled(); return result;
  }, options.signal);
}
