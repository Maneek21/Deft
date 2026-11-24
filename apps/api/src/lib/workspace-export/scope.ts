import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { readableSpaceSql } from '../space-visibility.js';
import { visibleLiveMemberForOrg } from '../member-visibility.js';
import { isGuestRole, personVisibleSql, type PeopleViewer } from '../people-visibility-sql.js';
import type { ExportScope, ResolvedScope } from './format.js';
import type { Snapshot } from './snapshot.js';

export type ExportContext = Readonly<{ orgId: string; scope: ResolvedScope }>;

export type ResolvedWorkspace = Readonly<{ id: string; slug: string; name: string; timezone: string; created_at: Date }>;

/** Exactly one workspace, by id or slug. Anything else is refused. */
export async function resolveWorkspace(snapshot: Snapshot, workspace: string): Promise<ResolvedWorkspace> {
  if (!workspace.trim()) throw new Error('A workspace id or slug is required');
  const rows = await snapshot.all<ResolvedWorkspace>(sql`
    SELECT id, slug, name, timezone, created_at FROM orgs WHERE id = ${workspace} OR slug = ${workspace}`);
  if (rows.length !== 1) throw new Error(rows.length === 0 ? 'No such workspace' : 'Workspace reference is ambiguous; use its id');
  return rows[0]!;
}

/**
 * The member-limited scope is for one active human member of this workspace,
 * named by user id or email. A user of another workspace, an agent or a
 * removed member is refused.
 */
export async function resolveScope(snapshot: Snapshot, orgId: string, scope: ExportScope): Promise<ResolvedScope> {
  if (scope.kind === 'workspace') return scope;
  const member = scope.member.trim();
  if (!member) throw new Error('A member id or email is required');
  const rows = await snapshot.all<{ user_id: string; role: 'owner' | 'admin' | 'member' | 'guest' }>(sql`
    SELECT u.id AS user_id, om.role
    FROM org_members om JOIN users u ON u.id = om.user_id
    WHERE om.org_id = ${orgId} AND om.is_active = true AND u.kind = 'human'
      AND (u.id = ${member} OR lower(u.email) = lower(${member}))`);
  if (rows.length !== 1) throw new Error('The member must be one active person in this workspace');
  return { kind: 'member', user_id: rows[0]!.user_id, role: rows[0]!.role };
}

export function memberId(ctx: ExportContext): string | null {
  return ctx.scope.kind === 'member' ? ctx.scope.user_id : null;
}

/**
 * The member scope sees people as GET /api/members shows them to that member:
 * a guest only the people who share a space with them, and no email address
 * but their own (lib/people-visibility-sql.ts). Null for the whole workspace.
 */
export function exportPeopleViewer(ctx: ExportContext): PeopleViewer | null {
  return ctx.scope.kind === 'member'
    ? { orgId: ctx.orgId, userId: ctx.scope.user_id, guest: isGuestRole(ctx.scope.role) }
    : null;
}

/** The product's space read rule (`canReadSpace`) for the member scope; every space for the whole workspace. */
export function spaceReadable(ctx: ExportContext, spaceId: SQLWrapper, spaceOrgId: SQLWrapper): SQL {
  const userId = memberId(ctx);
  return userId ? readableSpaceSql(userId, spaceId, spaceOrgId) : sql`true`;
}

/**
 * A user id from a row of this workspace, kept only when that user belongs to
 * the workspace (and, for the member scope, is one the member can see in the
 * member list). Otherwise null, so no other workspace's id reaches the archive.
 */
export function workspaceUser(ctx: ExportContext, userIdColumn: SQL): SQL {
  return sql`CASE WHEN ${userKnown(ctx, userIdColumn)} THEN ${userIdColumn} END`;
}

/** True when `userIdColumn` names a user the export may mention (see `workspaceUser`). */
export function userKnown(ctx: ExportContext, userIdColumn: SQL): SQL {
  if (ctx.scope.kind === 'workspace') {
    return sql`EXISTS (SELECT 1 FROM org_members known_member
      WHERE known_member.org_id = ${ctx.orgId} AND known_member.user_id = ${userIdColumn})`;
  }
  return sql`EXISTS (SELECT 1 FROM org_members JOIN users ON users.id = org_members.user_id
    WHERE org_members.org_id = ${ctx.orgId} AND org_members.user_id = ${userIdColumn}
      AND org_members.is_active = true AND ${visibleLiveMemberForOrg(sql`org_members.org_id`)}
      AND ${personVisibleSql(exportPeopleViewer(ctx)!, userIdColumn)})`;
}

/**
 * The author of content that is itself in the export (a message, a comment, a
 * reaction): named when they belong to this workspace, including people who
 * have since left, as the product shows them on that content.
 */
export function workspaceAuthor(ctx: ExportContext, userIdColumn: SQL): SQL {
  return sql`CASE WHEN EXISTS (SELECT 1 FROM org_members author_member
    WHERE author_member.org_id = ${ctx.orgId} AND author_member.user_id = ${userIdColumn}) THEN ${userIdColumn} END`;
}
