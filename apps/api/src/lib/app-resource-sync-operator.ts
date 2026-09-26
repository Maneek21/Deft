import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appInstallations, appResourceBindings, appRuntimeRegistrations, appRuntimeSessions, orgMembers, users } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { assertResourceSyncManager } from './app-resource-sync-web-authority.js';
import { ResourceSyncListQuery } from './app-resource-sync-status.js';
import { loadLiveResourceSyncBindingAuthority, resourceSyncParticipantsAreHuman } from './app-resource-sync-authority.js';
import type { ResourceSyncManagementGuard } from './app-resource-sync-management.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const Id = z.string().uuid();
const DateTime = z.iso.datetime();
const denied = () => new AppError('Private resource operator access denied', 'APP_ACCESS_DENIED', 403);
const name = (value: string) => value.slice(0, 160);
const Operators = z.strictObject({ schema_version: z.literal('deft.app_resource_sync_operators.v1'),
  operators: z.array(z.strictObject({ user_id: Id, name: z.string().max(160) })).max(50), next_after: Id.nullable() });
const Assignments = z.strictObject({ schema_version: z.literal('deft.app_resource_sync_assignments.v1'),
  assignments: z.array(z.strictObject({ binding_id: Id, installation_id: Id, resource_key: z.string(),
    owner_user_id: Id, owner_name: z.string().max(160), consent_expires_at: DateTime })).max(50), next_after: Id.nullable() });
const Sessions = z.strictObject({ schema_version: z.literal('deft.app_resource_sync_sessions.v1'),
  sessions: z.array(z.strictObject({ session_id: Id, created_at: DateTime,
    expires_at: DateTime, revoked_at: DateTime.nullable() })).max(50), next_after: Id.nullable() });

async function members(tx: Tx, orgId: string, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) await tx.execute(sql`SELECT id FROM org_members
    WHERE org_id = ${orgId} AND user_id = ${id} FOR SHARE`);
}
async function currentActor(tx: Tx, actor: ModuleActor, manager = false) {
  if (actor.kind !== 'human' || !['rest', 'ui'].includes(actor.source) || actor.role === 'guest') throw denied();
  if (manager) assertResourceSyncManager(actor);
  const [member] = await tx.select({ active: orgMembers.is_active, role: orgMembers.role, kind: users.kind })
    .from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(
      eq(orgMembers.org_id, actor.org_id), eq(orgMembers.user_id, actor.actor_id))).limit(1);
  if (!member?.active || member.kind !== 'human' || member.role === 'guest'
    || (manager && !['owner', 'admin'].includes(member.role))) throw denied();
}

/** Advisory choices only. Do not lock candidates after the manager membership;
 * consent takes all nominated participant memberships in sorted order. */
export async function listEligibleResourceSyncOperators(actor: ModuleActor, raw: unknown,
  guard?: ResourceSyncManagementGuard) {
  const query = ResourceSyncListQuery.parse(raw);
  return db.transaction(async tx => {
    await members(tx, actor.org_id, [actor.actor_id]);
    await currentActor(tx, actor, true);
    await guard?.(tx);
    await currentActor(tx, actor, true);
    const rows = await tx.select({ user_id: users.id, name: users.name }).from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(eq(orgMembers.org_id, actor.org_id),
        eq(orgMembers.is_active, true), ne(orgMembers.role, 'guest'), eq(users.kind, 'human'),
        query.after ? gt(users.id, query.after) : undefined)).orderBy(asc(users.id)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit).map(row => ({ ...row, name: name(row.name) }));
    return Operators.parse({ schema_version: 'deft.app_resource_sync_operators.v1', operators: page,
      next_after: rows.length > query.limit ? page.at(-1)!.user_id : null });
  });
}

export async function listAssignedResourceSyncBindings(actor: ModuleActor, raw: unknown,
  guard?: ResourceSyncManagementGuard) {
  const query = ResourceSyncListQuery.parse(raw);
  return db.transaction(async tx => {
    // Locate at most one page, then lock the complete participant set before
    // taking any App lock. Invalid rows still advance this bounded scan's cursor.
    const rows = await tx.select({ binding_id: appResourceBindings.id,
      installation_id: appResourceBindings.app_installation_id,
      version_id: appResourceBindings.app_version_id,
      registration_id: appResourceBindings.runtime_registration_id,
      owner_user_id: appResourceBindings.owner_user_id, owner_name: users.name })
      .from(appResourceBindings).innerJoin(appRuntimeRegistrations, and(
        eq(appRuntimeRegistrations.org_id, appResourceBindings.org_id),
        eq(appRuntimeRegistrations.id, appResourceBindings.runtime_registration_id)))
      .innerJoin(users, eq(users.id, appResourceBindings.owner_user_id)).where(and(
        eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.state, 'active'),
        eq(appRuntimeRegistrations.operator_user_id, actor.actor_id), eq(appRuntimeRegistrations.state, 'active'),
        eq(appRuntimeRegistrations.contract_version, 'deft.app_runtime_channel.v2'),
        gt(appResourceBindings.consent_expires_at, new Date()),
        query.after ? gt(appResourceBindings.id, query.after) : undefined))
      .orderBy(asc(appResourceBindings.id)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    await members(tx, actor.org_id, [actor.actor_id, ...page.map(row => row.owner_user_id)]);
    await currentActor(tx, actor);
    const installationIds = [...new Set(page.map(row => row.installation_id))].sort();
    for (const id of installationIds) await tx.execute(sql`SELECT id FROM app_installations
      WHERE org_id=${actor.org_id} AND id=${id} FOR SHARE`);
    const activeVersions = new Map<string, string | null>();
    for (const id of installationIds) {
      const [installation] = await tx.select({ version_id: appInstallations.active_version_id }).from(appInstallations)
        .where(and(eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, id)));
      activeVersions.set(id, installation?.version_id ?? null);
    }
    for (const id of [...new Set([...activeVersions.values()].filter((id): id is string => id !== null))].sort())
      await tx.execute(sql`SELECT id FROM app_versions WHERE org_id=${actor.org_id} AND id=${id} FOR SHARE`);
    for (const id of [...new Set(page.map(row => row.registration_id))].sort()) await tx.execute(sql`SELECT id
      FROM app_runtime_registrations WHERE org_id=${actor.org_id} AND id=${id} FOR SHARE`);
    for (const id of page.map(row => row.binding_id).sort()) await tx.execute(sql`SELECT id
      FROM app_resource_bindings WHERE org_id=${actor.org_id} AND id=${id} FOR SHARE`);
    const live = [];
    for (const row of page) {
      // A locator changed while its locks were acquired: skip it rather than
      // follow a new participant/App edge after locking this page's bindings.
      const [current] = await tx.select({ owner_id: appResourceBindings.owner_user_id,
        installation_id: appResourceBindings.app_installation_id, version_id: appResourceBindings.app_version_id,
        registration_id: appResourceBindings.runtime_registration_id, operator_id: appRuntimeRegistrations.operator_user_id,
        registration_installation_id: appRuntimeRegistrations.app_installation_id })
        .from(appResourceBindings).innerJoin(appRuntimeRegistrations, and(
          eq(appRuntimeRegistrations.org_id, appResourceBindings.org_id),
          eq(appRuntimeRegistrations.id, appResourceBindings.runtime_registration_id)))
        .where(and(eq(appResourceBindings.org_id, actor.org_id), eq(appResourceBindings.id, row.binding_id)));
      if (!current || current.owner_id !== row.owner_user_id || current.installation_id !== row.installation_id
        || current.version_id !== row.version_id || current.registration_id !== row.registration_id
        || current.operator_id !== actor.actor_id || current.registration_installation_id !== row.installation_id
        || activeVersions.get(row.installation_id) !== row.version_id) continue;
      const authority = await loadLiveResourceSyncBindingAuthority(tx, { org_id: actor.org_id,
        resource_binding_id: row.binding_id, clock: () => new Date() });
      if (authority?.registration.operator_user_id === actor.actor_id) live.push({ row, authority });
    }
    await guard?.(tx);
    await currentActor(tx, actor);
    const assignments = [];
    for (const { row, authority } of live) {
      if (!authority.binding.consent_expires_at || authority.binding.consent_expires_at <= new Date()
        || !await resourceSyncParticipantsAreHuman(tx, row.owner_user_id, actor.actor_id)) continue;
      assignments.push({ binding_id: row.binding_id, installation_id: authority.installation.id,
        resource_key: authority.binding.resource_key, owner_user_id: row.owner_user_id,
        owner_name: name(row.owner_name), consent_expires_at: authority.binding.consent_expires_at.toISOString() });
    }
    return Assignments.parse({ schema_version: 'deft.app_resource_sync_assignments.v1', assignments,
      next_after: rows.length > query.limit ? page.at(-1)!.binding_id : null });
  });
}

export async function listOwnResourceSyncSessions(actor: ModuleActor, bindingId: string, raw: unknown,
  guard?: ResourceSyncManagementGuard) {
  bindingId = Id.parse(bindingId);
  const input = z.strictObject({ session_id: Id.optional(), after: Id.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional() }).superRefine((value, context) => {
    if (value.session_id && (value.after !== undefined || value.limit !== undefined))
      context.addIssue({ code: 'custom', message: 'Exact session filter cannot be paginated' });
  }).parse(raw);
  const query = ResourceSyncListQuery.parse({ after: input.after, limit: input.limit });
  return db.transaction(async tx => {
    const live = await loadLiveResourceSyncBindingAuthority(tx, { org_id: actor.org_id,
      resource_binding_id: bindingId, clock: () => new Date() });
    await currentActor(tx, actor);
    if (!live || live.registration.operator_user_id !== actor.actor_id) throw denied();
    const rows = await tx.select({ session_id: appRuntimeSessions.id, created_at: appRuntimeSessions.created_at,
      expires_at: appRuntimeSessions.expires_at, revoked_at: appRuntimeSessions.revoked_at })
      .from(appRuntimeSessions).where(and(eq(appRuntimeSessions.org_id, actor.org_id),
        eq(appRuntimeSessions.resource_binding_id, bindingId),
        eq(appRuntimeSessions.runtime_registration_id, live.registration.id),
        eq(appRuntimeSessions.operator_user_id, actor.actor_id), eq(appRuntimeSessions.audience, 'app_resource_sync'),
        input.session_id ? eq(appRuntimeSessions.id, input.session_id) : undefined,
        query.after ? gt(appRuntimeSessions.id, query.after) : undefined))
      .orderBy(asc(appRuntimeSessions.id)).limit(input.session_id ? 1 : query.limit + 1).for('share');
    await guard?.(tx);
    await currentActor(tx, actor);
    if (!await resourceSyncParticipantsAreHuman(tx, live.binding.owner_user_id, actor.actor_id)
      || !live.binding.consent_expires_at || live.binding.consent_expires_at <= new Date()) throw denied();
    const page = rows.slice(0, query.limit).map(row => ({ session_id: row.session_id,
      created_at: row.created_at.toISOString(), expires_at: row.expires_at.toISOString(),
      revoked_at: row.revoked_at?.toISOString() ?? null }));
    return Sessions.parse({ schema_version: 'deft.app_resource_sync_sessions.v1', sessions: page,
      next_after: rows.length > query.limit ? page.at(-1)!.session_id : null });
  });
}
