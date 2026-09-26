import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appResourceBindings, appRuntimeRegistrations, appSyncCheckpoints,
  appRuns, appRunReceipts, orgMembers } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { assertResourceSyncManager } from './app-resource-sync-web-authority.js';
import type { ResourceSyncManagementGuard } from './app-resource-sync-management.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const Id = z.string().uuid();
export const ResourceSyncListQuery = z.strictObject({
  after: Id.optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
});
const denied = () => new AppError('Private resource sync access denied', 'APP_ACCESS_DENIED', 403);
const bindingFields = { binding_id: appResourceBindings.id,
  installation_id: appResourceBindings.app_installation_id,
  app_version_id: appResourceBindings.app_version_id,
  resource_key: appResourceBindings.resource_key, state: appResourceBindings.state,
  consent_expires_at: appResourceBindings.consent_expires_at,
  reviewed_at: appResourceBindings.reviewed_at, updated_at: appResourceBindings.updated_at };
async function manager(tx: Tx, actor: ModuleActor) {
  assertResourceSyncManager(actor);
  await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${actor.org_id}
    AND user_id = ${actor.actor_id} FOR SHARE`);
  const [member] = await tx.select({ role: orgMembers.role, active: orgMembers.is_active })
    .from(orgMembers).where(and(eq(orgMembers.org_id, actor.org_id),
      eq(orgMembers.user_id, actor.actor_id)));
  if (!member?.active || !['owner', 'admin'].includes(member.role)) throw denied();
}
/** Operational observation only. Revoked/expired consent does not prevent its
 * current manager-owner from inspecting lifecycle. This is not delivery authority. */
export async function listResourceSyncBindings(actor: ModuleActor, value: unknown,
  guard?: ResourceSyncManagementGuard) {
  const query = ResourceSyncListQuery.parse(value);
  return db.transaction(async (tx) => {
    await manager(tx, actor);
    const rows = await tx.select(bindingFields).from(appResourceBindings).where(and(
      eq(appResourceBindings.org_id, actor.org_id),
      eq(appResourceBindings.owner_user_id, actor.actor_id),
      query.after ? gt(appResourceBindings.id, query.after) : undefined))
      .orderBy(asc(appResourceBindings.id)).limit(query.limit + 1);
    const bindings = rows.slice(0, query.limit);
    await guard?.(tx);
    return { bindings, next_after: rows.length > query.limit ? bindings.at(-1)!.binding_id : null };
  });
}
export async function inspectResourceSyncBinding(actor: ModuleActor, bindingId: string,
  guard?: ResourceSyncManagementGuard) {
  bindingId = Id.parse(bindingId);
  return db.transaction(async (tx) => {
    await manager(tx, actor);
    const [binding] = await tx.select(bindingFields).from(appResourceBindings).where(and(
      eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.id, bindingId),
      eq(appResourceBindings.owner_user_id, actor.actor_id))).for('share');
    if (!binding) throw denied();
    const [checkpoint] = await tx.select({ checkpoint_id: appSyncCheckpoints.id,
      state: appSyncCheckpoints.state, generation: appSyncCheckpoints.generation,
      cursor_sequence: appSyncCheckpoints.cursor_sequence,
      retained_record_count: appSyncCheckpoints.retained_record_count,
      last_applied_at: appSyncCheckpoints.last_applied_at,
      last_checked_at: appSyncCheckpoints.last_checked_at,
      fresh_until: appSyncCheckpoints.fresh_until }).from(appSyncCheckpoints).where(and(
      eq(appSyncCheckpoints.org_id, actor.org_id), eq(appSyncCheckpoints.resource_binding_id, bindingId)));
    const [run] = await tx.select({ run_id: appRuns.id, state: appRuns.state,
      created_at: appRuns.created_at, terminal_at: appRuns.terminal_at }).from(appRuns).where(and(
      eq(appRuns.org_id, actor.org_id), eq(appRuns.origin_resource_binding_id, bindingId)))
      .orderBy(desc(appRuns.created_at), desc(appRuns.id)).limit(1);
    const [receipt] = run ? await tx.select({ receipt_id: appRunReceipts.id }).from(appRunReceipts)
      .where(and(eq(appRunReceipts.org_id, actor.org_id), eq(appRunReceipts.run_id, run.run_id)))
      .orderBy(desc(appRunReceipts.created_at), desc(appRunReceipts.id)).limit(1) : [];
    await guard?.(tx);
    return { binding, checkpoint: checkpoint ?? null,
      latest_run: run ? { ...run, receipt_id: receipt?.receipt_id ?? null } : null };
  });
}
/** The web surface narrows the host emergency manager API to self-owned consent.
 * Called as a final guard under the host method's registration/binding locks. */
export async function assertOwnedResourceSyncRegistration(tx: Tx, actor: ModuleActor, registrationId: string) {
  const [binding] = await tx.select({ id: appResourceBindings.id }).from(appResourceBindings)
    .innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, appResourceBindings.org_id),
      eq(appRuntimeRegistrations.id, appResourceBindings.runtime_registration_id)))
    .where(and(eq(appResourceBindings.org_id, actor.org_id),
      eq(appResourceBindings.runtime_registration_id, registrationId),
      eq(appResourceBindings.owner_user_id, actor.actor_id),
      eq(appRuntimeRegistrations.contract_version, 'deft.app_runtime_channel.v2'))).limit(1);
  if (!binding) throw denied();
}
