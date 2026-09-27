import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ModuleActor } from '@deft/shared/modules';
import { appInstallations, appNativeBindings, appPublicCancellations, appPublicCancellationSelections,
  appPublicEndpoints, appRuns, appVersions, appGrantSnapshots, orgMembers } from '@deft/db/schema';
import { db } from './db.js';
import { assertNativeCalendarEnabled, lockNativeParticipants, loadLiveNativeAuthority, nativeStale } from './app-native-authority.js';
import { nativeFinalAuthorityIsCurrent } from './app-native-final-authority.js';
import { acquireRetainedCancellationMutex, retainedPublicCancellation } from './app-public-cancellation-authority.js';
import { historicalCreateIsExplicitlyConsented } from './app-public-cancellation-contract.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import type { AppRunTransaction } from './app-run-repository.js';

export const PublicCancellationListQuerySchema = z.strictObject({ installation_id: z.uuid(), after_cancellation_id: z.uuid().optional() });
type Options = { guard: WebAuthorityGuard };
function human(actor: ModuleActor) {
  assertNativeCalendarEnabled();
  if (actor.kind !== 'human' || !['rest', 'ui'].includes(actor.source)) throw nativeStale();
}
async function member(tx: AppRunTransaction, actor: ModuleActor) {
  const [row] = await tx.select().from(orgMembers).where(and(eq(orgMembers.org_id, actor.org_id), eq(orgMembers.user_id, actor.actor_id))).limit(1);
  if (!row?.is_active || row.role === 'guest') throw nativeStale();
}
async function final(tx: AppRunTransaction, participants: readonly string[], options: Options) {
  const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const pg = new Date((result.rows[0] as { now: Date | string }).now), sampled = performance.now();
  if (!Number.isFinite(pg.getTime()) || !await nativeFinalAuthorityIsCurrent(tx, participants, { guard: options.guard,
    clock: () => new Date(Math.max(Date.now(), pg.getTime() + performance.now() - sampled)) })) throw nativeStale();
}
async function limits(tx: AppRunTransaction) {
  await tx.execute(sql`SET LOCAL statement_timeout=5000`);
  await tx.execute(sql`SET LOCAL lock_timeout=1000`);
}

/** Historical metadata is owned by the immutable Calendar owner. It grants no
 * current binding authority and never reads an input or output capsule. */
export async function listPublicCancellationOwner(actor: ModuleActor, raw: unknown, options: Options) {
  human(actor);
  const query = PublicCancellationListQuerySchema.parse(raw);
  return db.transaction(async tx => {
    await limits(tx);
    await lockNativeParticipants(tx, actor.org_id, [actor.actor_id]);
    await member(tx, actor);
    const [app] = await tx.select({ id: appInstallations.id }).from(appInstallations).where(and(
      eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, query.installation_id))).limit(1).for('share');
    if (!app) throw nativeStale();
    const rows = await tx.select({ id: appPublicCancellations.id, state: appPublicCancellations.state,
      accepted_at: appPublicCancellations.accepted_at, original_version: appVersions.version,
      cancel_run_id: appPublicCancellationSelections.cancel_run_id, cancel_run_state: appRuns.state })
      .from(appPublicCancellations).innerJoin(appPublicEndpoints, and(eq(appPublicEndpoints.org_id, appPublicCancellations.org_id),
        eq(appPublicEndpoints.id, appPublicCancellations.endpoint_id), eq(appPublicEndpoints.app_installation_id, appPublicCancellations.app_installation_id)))
      .innerJoin(appVersions, and(eq(appVersions.org_id, appPublicEndpoints.org_id), eq(appVersions.id, appPublicEndpoints.app_version_id),
        eq(appVersions.installation_id, appPublicEndpoints.app_installation_id)))
      .leftJoin(appPublicCancellationSelections, and(eq(appPublicCancellationSelections.org_id, appPublicCancellations.org_id),
        eq(appPublicCancellationSelections.cancellation_id, appPublicCancellations.id)))
      .leftJoin(appRuns, and(eq(appRuns.org_id, appPublicCancellationSelections.org_id), eq(appRuns.id, appPublicCancellationSelections.cancel_run_id)))
      .where(and(eq(appPublicCancellations.org_id, actor.org_id), eq(appPublicCancellations.app_installation_id, app.id),
        eq(appPublicEndpoints.approver_user_id, actor.actor_id),
        query.after_cancellation_id ? gt(appPublicCancellations.id, query.after_cancellation_id) : undefined))
      .orderBy(asc(appPublicCancellations.id)).limit(21);
    const items = rows.slice(0, 20).map(row => ({ ...row, accepted_at: row.accepted_at.toISOString() }));
    await final(tx, [actor.actor_id], options);
    return { schema_version: 'deft.app_public_cancellation_owner_list.v1', installation_id: app.id,
      items, next_after_cancellation_id: rows.length > 20 ? items.at(-1)!.id : null };
  });
}

async function candidates(tx: AppRunTransaction, orgId: string, appId: string, ownerId: string, versionId: string | null, grantId: string | null) {
  if (!versionId || !grantId) throw nativeStale();
  return tx.select({ id: appNativeBindings.id, manager_id: appNativeBindings.stage_manager_user_id })
    .from(appNativeBindings).where(and(eq(appNativeBindings.org_id, orgId), eq(appNativeBindings.app_installation_id, appId),
      eq(appNativeBindings.owner_user_id, ownerId), eq(appNativeBindings.app_version_id, versionId),
      eq(appNativeBindings.grant_snapshot_id, grantId), eq(appNativeBindings.state, 'active'),
      eq(appNativeBindings.operation_name, 'calendar.events.cancel.v1'))).orderBy(asc(appNativeBindings.id)).limit(9);
}

export async function contextPublicCancellationOwner(actor: ModuleActor, cancellationId: string, options: Options) {
  human(actor);
  return db.transaction(async tx => {
    await limits(tx);
    const locator = await acquireRetainedCancellationMutex(tx, actor.org_id, cancellationId);
    if (locator.endpoint.approver_user_id !== actor.actor_id) throw nativeStale();
    const [initialApp] = await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, actor.org_id),
      eq(appInstallations.id, locator.cancellation.app_installation_id))).limit(1);
    if (!initialApp) throw nativeStale();
    const initial = await candidates(tx, actor.org_id, initialApp.id, actor.actor_id, initialApp.active_version_id, initialApp.active_grant_snapshot_id);
    if (initial.length > 8) throw nativeStale();
    const participants = [...new Set([actor.actor_id, ...initial.map(row => row.manager_id)])].sort();
    await lockNativeParticipants(tx, actor.org_id, participants);
    await member(tx, actor);
    const [app] = await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, initialApp.id)))
      .limit(1).for('share');
    if (!app || app.state !== 'active' || app.active_version_id !== initialApp.active_version_id
      || app.active_grant_snapshot_id !== initialApp.active_grant_snapshot_id) throw nativeStale();
    const fixed = await candidates(tx, actor.org_id, app.id, actor.actor_id, app.active_version_id, app.active_grant_snapshot_id);
    // Reject a changed locator set. Never discover and acquire another manager
    // membership after entering the App fence.
    if (JSON.stringify(fixed) !== JSON.stringify(initial)) throw nativeStale();
    const retained = await retainedPublicCancellation(tx, actor.org_id, cancellationId);
    const [original] = await tx.select().from(appRuns).where(and(eq(appRuns.org_id, actor.org_id), eq(appRuns.id, retained.cancellation.original_run_id!))).limit(1);
    const [version] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, actor.org_id), eq(appVersions.installation_id, app.id),
      eq(appVersions.id, retained.endpoint.app_version_id))).limit(1);
    const [grant] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, actor.org_id),
      eq(appGrantSnapshots.app_installation_id, app.id), eq(appGrantSnapshots.id, retained.endpoint.grant_snapshot_id))).limit(1);
    if (!original || !version || !grant || grant.app_version_id !== version.id || grant.package_digest !== version.package_digest
      || original.state !== 'succeeded' || original.provider_kind !== 'native' || original.origin_kind !== 'app'
      || original.origin_runtime_binding_id !== null || original.provider_instance_id !== `calendar:${actor.actor_id}`
      || original.operation_name !== 'calendar.events.create.v1' || original.execution_actor_type !== 'human' || original.execution_actor_id !== actor.actor_id
      || original.initiating_actor_type !== 'app_public' || original.initiating_actor_id !== retained.claim.ingress_id
      || original.origin_app_installation_id !== app.id || original.origin_app_version_id !== version.id
      || original.origin_app_grant_snapshot_id !== grant.id || original.origin_native_binding_id !== retained.endpoint.native_binding_id
      || original.origin_public_endpoint_id !== retained.endpoint.id || original.origin_public_ingress_id !== retained.claim.ingress_id) throw nativeStale();
    const pin = { app_version_id: version.id, package_digest: version.package_digest, grant_snapshot_id: grant.id, grant_snapshot_digest: grant.snapshot_digest };
    const choices = [];
    for (const candidate of fixed) {
      const current = await loadLiveNativeAuthority(tx, { org_id: actor.org_id, native_binding_id: candidate.id, prelocked_participant_ids: participants });
      if (current.binding.owner_user_id !== actor.actor_id || !current.binding.consent_digest) throw nativeStale();
      if ((version.id !== current.version.id || grant.id !== current.grant.id)
        && !historicalCreateIsExplicitlyConsented(current.binding.historical_create_policy, pin)) continue;
      choices.push({ native_binding_id: current.binding.id, action_label: current.action.label,
        consent_digest: current.binding.consent_digest, current_app_version_id: current.version.id,
        historical_create_authorized: version.id !== current.version.id || grant.id !== current.grant.id });
    }
    const [selection] = await tx.select({ cancel_run_id: appPublicCancellationSelections.cancel_run_id }).from(appPublicCancellationSelections)
      .where(and(eq(appPublicCancellationSelections.org_id, actor.org_id), eq(appPublicCancellationSelections.cancellation_id, cancellationId))).limit(1);
    await final(tx, participants, options);
    return { schema_version: 'deft.app_public_cancellation_owner_context.v1', cancellation_id: cancellationId,
      installation_id: app.id, state: retained.cancellation.state, original_version: version.version,
      choices, cancel_run_id: selection?.cancel_run_id ?? null };
  });
}
