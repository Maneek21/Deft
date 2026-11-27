import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { DEFTY_EMAIL } from '../lib/defty-identity.js';
import {
  users,
  orgMembers,
  spaces,
  spaceMembers,
  agentEmployees,
  agentChannelTokens,
  mcpTokens,
  invites,
  apiKeys,
  oauthGrants,
  oauthAccessTokens,
  oauthRefreshTokens,
  projects,
  tasks,
  taskAssignees,
  teamMembers,
  teams,
  userGroupMembers,
  userGroups,
  wikiPages,
  webSessions,
} from '@deft/db/schema';
import { env } from '../lib/env.js';
import { visibleLiveMemberForOrg } from '../lib/member-visibility.js';
import { emailFor, peopleViewer, personVisibleSql } from '../lib/people-visibility.js';
import { OrgMembershipError, requireOrgAdminOrOwner } from '../lib/org-membership.js';
import { evictActiveHuddleParticipants } from '../socket.js';
import { emitWebSessionRevocations } from '../lib/web-sessions.js';
import { buySeatsUrlFor, getSeatStatus, reserveSeat, withSeatRetry, type SeatReservation } from '../lib/seat-limit.js';
import { buildInviteUrl as buildSecretInviteUrl, buildRecoveryUrl as buildSecretRecoveryUrl } from '../lib/secret-links.js';
import { roleMustHaveSecondStep } from '../lib/two-step-policy.js';
import { userTwoStep } from '@deft/db/two-step';
import { closeLostRoomActionsInTx, finishLostRoomCancellations } from '../lib/lost-room-action-cancellation.js';
import { lockRoomAccessChange } from '../lib/room-access-lock.js';
import { visibleTaskSql } from '../lib/task-visibility.js';
import {
  authorizeMembershipOperation, checkMembershipOperation, isProtectedMembership, lockMembership, MembershipGuardError, recordMembershipChange, recordPrivilege, type MembershipActor,
} from '../lib/membership-guard.js';

const INVITE_TTL = '7d';
const RECOVERY_TTL = '24h';

const offboardingPayloadSchema = z.object({
  replacement_user_id: z.string().min(1).optional().nullable(),
});

function buildInviteUrl(token: string): string {
  return buildSecretInviteUrl(env.NEXT_PUBLIC_APP_URL, token);
}

function buildRecoveryUrl(token: string): string {
  return buildSecretRecoveryUrl(env.NEXT_PUBLIC_APP_URL, token);
}

export const memberRoutes = new Hono();

function adminForbidden(c: Context, err: unknown) {
  if (err instanceof OrgMembershipError) {
    return c.json({ error: err.message, code: err.code }, err.status as 403);
  }
  return c.json({ error: 'Only admins can perform this action', code: 'FORBIDDEN' }, 403);
}

/** A refusal for want of seats carries the purchase page for an owner (buySeatsUrlFor). */
function seatRefused(c: Context, refusal: Exclude<SeatReservation, { ok: true }>, callerRole: string) {
  const buySeatsUrl = refusal.code === 'SEAT_LIMIT_REACHED' ? buySeatsUrlFor(callerRole) : null;
  return c.json({
    error: refusal.error,
    code: refusal.code,
    seat_limit: refusal.seat_limit,
    seats_in_use: refusal.seats_in_use,
    frozen_reason: refusal.frozen_reason,
    ...(buySeatsUrl ? { buy_seats_url: buySeatsUrl } : {}),
  }, 409);
}

// GET /api/members — list all members of current org
type InviteClaims = {
  purpose?: string;
  user_id?: string;
  org_id?: string;
  email?: string;
  inviter_id?: string;
  role?: string;
  exp?: number;
};

function decodeInviteClaims(token: string): InviteClaims | null {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded === 'string') return null;
  return decoded as InviteClaims;
}

function inviteStatus(row: { accepted_at: Date | string | null; expires_at: Date | string | null }) {
  if (row.accepted_at) return 'accepted';
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  return 'pending';
}

function compactDate(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

async function getCurrentMembership(orgId: string, userId: string) {
  const [membership] = await db.select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId), eq(orgMembers.is_active, true)))
    .limit(1);
  return membership ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Everything that ends a person's access to the workspace: sessions, spaces,
 * teams, groups, task assignments, personal and API keys, connected apps.
 * Runs inside the caller's transaction, which holds the person's account and
 * membership locks (lib/membership-guard.ts), so it can never act on a
 * membership that was restored after the removal was authorized.
 */
async function endWorkspaceAccess(tx: Tx, orgId: string, memberId: string, revokedAt: Date, closedActions: string[] = []): Promise<string[]> {
  const sessions = await tx.select({ id: webSessions.id })
    .from(webSessions)
    .where(and(eq(webSessions.org_id, orgId), eq(webSessions.user_id, memberId), sql`${webSessions.revoked_at} IS NULL`))
    .for('update');
  if (sessions.length) {
    await tx.update(webSessions).set({ revoked_at: revokedAt }).where(inArray(webSessions.id, sessions.map(session => session.id)));
  }

  await tx.execute(sql`
    DELETE FROM ${spaceMembers}
    WHERE ${spaceMembers.user_id} = ${memberId}
      AND ${spaceMembers.space_id} IN (
        SELECT ${spaces.id}
        FROM ${spaces}
        WHERE ${spaces.org_id} = ${orgId}
      )
  `);
  await tx.delete(teamMembers)
    .where(and(eq(teamMembers.org_id, orgId), eq(teamMembers.user_id, memberId)));
  await tx.execute(sql`
    DELETE FROM ${userGroupMembers}
    WHERE ${userGroupMembers.user_id} = ${memberId}
      AND ${userGroupMembers.group_id} IN (
        SELECT ${userGroups.id}
        FROM ${userGroups}
        WHERE ${userGroups.org_id} = ${orgId}
      )
  `);
  await tx.execute(sql`
    DELETE FROM ${taskAssignees}
    WHERE ${taskAssignees.user_id} = ${memberId}
      AND ${taskAssignees.task_id} IN (
        SELECT ${tasks.id}
        FROM ${tasks}
        WHERE ${tasks.org_id} = ${orgId}
      )
  `);
  await tx.update(mcpTokens)
    .set({ revoked_at: revokedAt, updated_at: revokedAt })
    .where(and(
      eq(mcpTokens.org_id, orgId),
      eq(mcpTokens.user_id, memberId),
      sql`${mcpTokens.revoked_at} IS NULL`,
    ));
  await tx.update(apiKeys)
    .set({ is_active: false, updated_at: revokedAt })
    .where(and(
      eq(apiKeys.org_id, orgId),
      eq(apiKeys.created_by, memberId),
      eq(apiKeys.is_active, true),
    ));
  await tx.update(oauthGrants)
    .set({ revoked_at: revokedAt, updated_at: revokedAt })
    .where(and(
      eq(oauthGrants.org_id, orgId),
      eq(oauthGrants.user_id, memberId),
      sql`${oauthGrants.revoked_at} IS NULL`,
    ));
  await tx.update(oauthAccessTokens)
    .set({ revoked_at: revokedAt, updated_at: revokedAt })
    .where(and(
      eq(oauthAccessTokens.org_id, orgId),
      eq(oauthAccessTokens.user_id, memberId),
      sql`${oauthAccessTokens.revoked_at} IS NULL`,
    ));
  await tx.execute(sql`
    UPDATE ${oauthRefreshTokens}
    SET revoked_at = ${revokedAt}, updated_at = ${revokedAt}
    WHERE revoked_at IS NULL
      AND grant_id IN (
        SELECT id
        FROM ${oauthGrants}
        WHERE org_id = ${orgId}
          AND user_id = ${memberId}
      )
  `);
  // An agent's own credentials are keyed by the employee, not the user: a
  // removed agent stops working too, and is paused.
  const employees = await tx.select({ id: agentEmployees.id }).from(agentEmployees)
    .where(and(eq(agentEmployees.org_id, orgId), eq(agentEmployees.user_id, memberId)));
  if (employees.length) {
    const employeeIds = employees.map((employee) => employee.id);
    await tx.update(mcpTokens).set({ revoked_at: revokedAt, updated_at: revokedAt })
      .where(and(eq(mcpTokens.org_id, orgId), inArray(mcpTokens.agent_employee_id, employeeIds), sql`${mcpTokens.revoked_at} IS NULL`));
    await tx.update(apiKeys).set({ is_active: false, updated_at: revokedAt })
      .where(and(eq(apiKeys.org_id, orgId), inArray(apiKeys.agent_employee_id, employeeIds), eq(apiKeys.is_active, true)));
    await tx.update(agentChannelTokens).set({ is_active: false, revoked_at: revokedAt })
      .where(and(eq(agentChannelTokens.org_id, orgId), inArray(agentChannelTokens.agent_employee_id, employeeIds), eq(agentChannelTokens.is_active, true)));
    await tx.update(agentEmployees).set({ is_active: false })
      .where(and(eq(agentEmployees.org_id, orgId), inArray(agentEmployees.id, employeeIds)));
  }
  // DFX2: every room went with the workspace; their pending assistant
  // actions from rooms close with a reason, committed with the removal.
  for (const id of await closeLostRoomActionsInTx(tx, { orgId, requesterId: memberId })) closedActions.push(id);
  return sessions.map(session => session.id);
}

/** After commit: live effects of a removal, only if the person is still removed. */
async function afterWorkspaceAccessEnded(orgId: string, memberId: string, sessionIds: string[], closedActions: string[]) {
  emitWebSessionRevocations(sessionIds);
  const [still] = await db.select({ is_active: orgMembers.is_active }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, memberId))).limit(1);
  if (still && !still.is_active) {
    await evictActiveHuddleParticipants({ orgId, userId: memberId, reason: 'org_membership_revoked' });
  }
  // DFX2: receipts and attention items of the actions closed in the removal.
  await finishLostRoomCancellations(orgId, closedActions);
}

type Reassigned = { replacement_user_id: string | null; primary_open_tasks: number; led_projects: number; led_teams: number };

/**
 * Removes a member: the one locked path, the owner-only rule, then (under the
 * same locks) the reassignment of their open work and the end of every
 * access. A refusal changes nothing.
 */
async function revokeMemberWorkspaceAccess(orgId: string, memberId: string, actor: MembershipActor, replacementUserId: string | null = null): Promise<Reassigned> {
  const revokedAt = new Date();
  let reassigned: Reassigned = { replacement_user_id: replacementUserId, primary_open_tasks: 0, led_projects: 0, led_teams: 0 };
  const closedActions: string[] = [];
  const revokedSessionIds = await db.transaction(async (tx) => {
    // DFX2: the person's room-access lock first (lib/room-access-lock.ts).
    await lockRoomAccessChange(tx, orgId, memberId);
    const locked = await lockMembership(tx, { orgId, targetUserId: memberId });
    if (!locked.account || !locked.membership) return null;
    const refusal = await authorizeMembershipOperation(tx, { orgId, actor, locked });
    if (refusal) throw new MembershipGuardError(refusal);
    if (replacementUserId) reassigned = await reassignMemberOwnership(tx, orgId, memberId, replacementUserId);
    await recordMembershipChange(tx, { orgId, targetUserId: memberId, locked, change: { isActive: false } });
    await tx.update(orgMembers).set({ is_active: false, updated_at: revokedAt }).where(eq(orgMembers.id, locked.membership.id));
    return endWorkspaceAccess(tx, orgId, memberId, revokedAt, closedActions);
  });
  if (revokedSessionIds) await afterWorkspaceAccessEnded(orgId, memberId, revokedSessionIds, closedActions);
  return reassigned;
}

class ReassignmentError extends Error {}

/** Moves the person's open work to the replacement, on the caller's locked transaction. */
async function reassignMemberOwnership(tx: Tx, orgId: string, memberId: string, replacementUserId: string) {
  if (memberId === replacementUserId) {
    throw new ReassignmentError('Replacement cannot be the member being removed');
  }

  const [replacement] = await tx.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, replacementUserId), eq(orgMembers.is_active, true)))
    .limit(1);
  if (!replacement) {
    throw new ReassignmentError('Replacement must be an active member of this organization');
  }

  const reassignedAt = new Date();
  const ledTeamRows = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(
      eq(teams.org_id, orgId),
      eq(teams.lead_user_id, memberId),
      eq(teams.is_archived, false),
    ));

  const reassignedTasks = await tx
    .update(tasks)
    .set({ assignee_id: replacementUserId, updated_at: reassignedAt })
    .where(and(
      eq(tasks.org_id, orgId),
      eq(tasks.assignee_id, memberId),
      eq(tasks.is_deleted, false),
      sql`${tasks.status} NOT IN ('done', 'cancelled')`,
    ))
    .returning({ id: tasks.id });

  const reassignedProjects = await tx
    .update(projects)
    .set({ lead_id: replacementUserId, updated_at: reassignedAt })
    .where(and(
      eq(projects.org_id, orgId),
      eq(projects.lead_id, memberId),
      eq(projects.is_deleted, false),
    ))
    .returning({ id: projects.id });

  const reassignedTeams = await tx
    .update(teams)
    .set({ lead_user_id: replacementUserId, updated_at: reassignedAt })
    .where(and(
      eq(teams.org_id, orgId),
      eq(teams.lead_user_id, memberId),
      eq(teams.is_archived, false),
    ))
    .returning({ id: teams.id });

  for (const team of ledTeamRows) {
    await tx
      .insert(teamMembers)
      .values({
        id: crypto.randomUUID(),
        org_id: orgId,
        team_id: team.id,
        user_id: replacementUserId,
        role: 'lead',
      })
      .onConflictDoUpdate({
        target: [teamMembers.team_id, teamMembers.user_id],
        set: { role: 'lead', updated_at: reassignedAt },
      });
  }

  return {
    replacement_user_id: replacementUserId,
    primary_open_tasks: reassignedTasks.length,
    led_projects: reassignedProjects.length,
    led_teams: reassignedTeams.length,
  };
}

async function buildOffboardingPreview(orgId: string, memberId: string) {
  const [
    spaceRows,
    teamRows,
    groupRows,
    primaryTasks,
    secondaryTaskRows,
    ledProjects,
    ledTeams,
    mcpRows,
    apiRows,
    oauthRows,
    spaceCountRows,
    teamCountRows,
    groupCountRows,
    primaryTaskCountRows,
    ledProjectCountRows,
    ledTeamCountRows,
  ] = await Promise.all([
    db.select({
      id: spaces.id,
      name: spaces.name,
      type: spaces.type,
    })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
      .where(and(eq(spaces.org_id, orgId), eq(spaceMembers.user_id, memberId)))
      .orderBy(spaces.name)
      .limit(12),
    db.select({
      id: teams.id,
      name: teams.name,
      handle: teams.handle,
      role: teamMembers.role,
    })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.team_id))
      .where(and(eq(teamMembers.org_id, orgId), eq(teamMembers.user_id, memberId)))
      .orderBy(teams.name)
      .limit(12),
    db.select({
      id: userGroups.id,
      name: userGroups.name,
      handle: userGroups.handle,
    })
      .from(userGroupMembers)
      .innerJoin(userGroups, eq(userGroups.id, userGroupMembers.group_id))
      .where(and(eq(userGroups.org_id, orgId), eq(userGroupMembers.user_id, memberId)))
      .orderBy(userGroups.name)
      .limit(12),
    db.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      project_id: tasks.project_id,
    })
      .from(tasks)
      .where(and(
        eq(tasks.org_id, orgId),
        eq(tasks.assignee_id, memberId),
        eq(tasks.is_deleted, false),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ))
      .orderBy(desc(tasks.updated_at))
      .limit(12),
    db.select({
      count: sql<number>`count(*)::int`,
    })
      .from(taskAssignees)
      .innerJoin(tasks, eq(tasks.id, taskAssignees.task_id))
      .where(and(
        eq(tasks.org_id, orgId),
        eq(taskAssignees.user_id, memberId),
        eq(tasks.is_deleted, false),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      )),
    db.select({
      id: projects.id,
      name: projects.name,
      prefix: projects.prefix,
    })
      .from(projects)
      .where(and(eq(projects.org_id, orgId), eq(projects.lead_id, memberId), eq(projects.is_deleted, false)))
      .orderBy(projects.name)
      .limit(12),
    db.select({
      id: teams.id,
      name: teams.name,
      handle: teams.handle,
    })
      .from(teams)
      .where(and(eq(teams.org_id, orgId), eq(teams.lead_user_id, memberId), eq(teams.is_archived, false)))
      .orderBy(teams.name)
      .limit(12),
    db.select({ count: sql<number>`count(*)::int` })
      .from(mcpTokens)
      .where(and(eq(mcpTokens.org_id, orgId), eq(mcpTokens.user_id, memberId), sql`${mcpTokens.revoked_at} IS NULL`)),
    db.select({ count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(eq(apiKeys.org_id, orgId), eq(apiKeys.created_by, memberId), eq(apiKeys.is_active, true))),
    db.select({ count: sql<number>`count(*)::int` })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.org_id, orgId), eq(oauthGrants.user_id, memberId), sql`${oauthGrants.revoked_at} IS NULL`)),
    db.select({ count: sql<number>`count(*)::int` })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
      .where(and(eq(spaces.org_id, orgId), eq(spaceMembers.user_id, memberId))),
    db.select({ count: sql<number>`count(*)::int` })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.team_id))
      .where(and(eq(teamMembers.org_id, orgId), eq(teamMembers.user_id, memberId))),
    db.select({ count: sql<number>`count(*)::int` })
      .from(userGroupMembers)
      .innerJoin(userGroups, eq(userGroups.id, userGroupMembers.group_id))
      .where(and(eq(userGroups.org_id, orgId), eq(userGroupMembers.user_id, memberId))),
    db.select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(
        eq(tasks.org_id, orgId),
        eq(tasks.assignee_id, memberId),
        eq(tasks.is_deleted, false),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      )),
    db.select({ count: sql<number>`count(*)::int` })
      .from(projects)
      .where(and(eq(projects.org_id, orgId), eq(projects.lead_id, memberId), eq(projects.is_deleted, false))),
    db.select({ count: sql<number>`count(*)::int` })
      .from(teams)
      .where(and(eq(teams.org_id, orgId), eq(teams.lead_user_id, memberId), eq(teams.is_archived, false))),
  ]);

  return {
    revoke_now: {
      spaces: spaceRows,
      teams: teamRows,
      groups: groupRows,
      secondary_task_assignments: Number(secondaryTaskRows[0]?.count ?? 0),
      active_mcp_tokens: Number(mcpRows[0]?.count ?? 0),
      active_api_keys: Number(apiRows[0]?.count ?? 0),
      active_oauth_grants: Number(oauthRows[0]?.count ?? 0),
    },
    needs_reassignment: {
      primary_open_tasks: primaryTasks,
      led_projects: ledProjects,
      led_teams: ledTeams,
    },
    counts: {
      spaces: Number(spaceCountRows[0]?.count ?? 0),
      teams: Number(teamCountRows[0]?.count ?? 0),
      groups: Number(groupCountRows[0]?.count ?? 0),
      primary_open_tasks: Number(primaryTaskCountRows[0]?.count ?? 0),
      secondary_task_assignments: Number(secondaryTaskRows[0]?.count ?? 0),
      led_projects: Number(ledProjectCountRows[0]?.count ?? 0),
      led_teams: Number(ledTeamCountRows[0]?.count ?? 0),
      active_mcp_tokens: Number(mcpRows[0]?.count ?? 0),
      active_api_keys: Number(apiRows[0]?.count ?? 0),
      active_oauth_grants: Number(oauthRows[0]?.count ?? 0),
    },
  };
}

async function listOrgInvites(orgId: string) {
  const rows = await db.select({
    id: invites.id,
    email: invites.email,
    token: invites.token,
    invited_by: invites.invited_by,
    inviter_name: users.name,
    accepted_by: invites.accepted_by,
    accepted_at: invites.accepted_at,
    expires_at: invites.expires_at,
    created_at: invites.created_at,
    updated_at: invites.updated_at,
  })
    .from(invites)
    .leftJoin(users, eq(invites.invited_by, users.id))
    .where(eq(invites.org_id, orgId))
    .orderBy(desc(invites.created_at));

  return rows.map((row) => {
    const claims = decodeInviteClaims(row.token);
    return {
      id: row.id,
      email: row.email ?? claims?.email ?? '',
      role: claims?.role ?? 'member',
      user_id: claims?.user_id ?? null,
      invited_by: row.invited_by,
      inviter_name: row.inviter_name,
      accepted_by: row.accepted_by,
      accepted_at: compactDate(row.accepted_at),
      expires_at: compactDate(row.expires_at),
      created_at: compactDate(row.created_at),
      updated_at: compactDate(row.updated_at),
      status: inviteStatus(row),
    };
  });
}

function mapCountRows(rows: Array<Record<string, unknown>>, key = 'user_id') {
  const out = new Map<string, number>();
  for (const row of rows) {
    const id = row[key];
    const count = row.count;
    if (typeof id === 'string') out.set(id, Number(count ?? 0));
  }
  return out;
}

function mapTaskRows(rows: Array<Record<string, unknown>>) {
  const out = new Map<string, { open: number; total: number }>();
  for (const row of rows) {
    const id = row.user_id;
    if (typeof id === 'string') {
      out.set(id, { open: Number(row.open ?? 0), total: Number(row.total ?? 0) });
    }
  }
  return out;
}

// `viewerId`: who reads the stats. A guest counts only the tasks they may
// see (lib/task-visibility.ts).
async function loadPeopleStats(orgId: string, userIds: string[], viewerId: string) {
  if (userIds.length === 0) {
    return {
      spaces: new Map<string, number>(),
      tasks: new Map<string, { open: number; total: number }>(),
      projects: new Map<string, number>(),
      wiki: new Map<string, number>(),
      mcp: new Map<string, number>(),
      api: new Map<string, number>(),
      oauth: new Map<string, number>(),
    };
  }

  const [
    spaceRows,
    taskRows,
    projectRows,
    wikiRows,
    mcpRows,
    apiRows,
    oauthRows,
  ] = await Promise.all([
    db.select({
      user_id: spaceMembers.user_id,
      count: sql<number>`count(*)::int`,
    })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
      .where(and(eq(spaces.org_id, orgId), inArray(spaceMembers.user_id, userIds)))
      .groupBy(spaceMembers.user_id),
    db.select({
      user_id: tasks.assignee_id,
      open: sql<number>`count(*) filter (where ${tasks.status} not in ('done', 'cancelled') and ${tasks.is_deleted} = false)::int`,
      total: sql<number>`count(*) filter (where ${tasks.is_deleted} = false)::int`,
    })
      .from(tasks)
      .where(and(eq(tasks.org_id, orgId), inArray(tasks.assignee_id, userIds), visibleTaskSql(viewerId)))
      .groupBy(tasks.assignee_id),
    db.select({
      user_id: projects.lead_id,
      count: sql<number>`count(*) filter (where ${projects.is_deleted} = false)::int`,
    })
      .from(projects)
      .where(and(eq(projects.org_id, orgId), inArray(projects.lead_id, userIds)))
      .groupBy(projects.lead_id),
    db.select({
      user_id: wikiPages.user_id,
      count: sql<number>`count(*) filter (where ${wikiPages.is_deleted} = false)::int`,
    })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, orgId), inArray(wikiPages.user_id, userIds)))
      .groupBy(wikiPages.user_id),
    db.select({
      user_id: mcpTokens.user_id,
      count: sql<number>`count(*) filter (where ${mcpTokens.revoked_at} is null)::int`,
    })
      .from(mcpTokens)
      .where(and(eq(mcpTokens.org_id, orgId), inArray(mcpTokens.user_id, userIds)))
      .groupBy(mcpTokens.user_id),
    db.select({
      user_id: apiKeys.created_by,
      count: sql<number>`count(*) filter (where ${apiKeys.is_active} = true)::int`,
    })
      .from(apiKeys)
      .where(and(eq(apiKeys.org_id, orgId), inArray(apiKeys.created_by, userIds)))
      .groupBy(apiKeys.created_by),
    db.select({
      user_id: oauthGrants.user_id,
      count: sql<number>`count(*) filter (where ${oauthGrants.revoked_at} is null)::int`,
    })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.org_id, orgId), inArray(oauthGrants.user_id, userIds)))
      .groupBy(oauthGrants.user_id),
  ]);

  return {
    spaces: mapCountRows(spaceRows as Array<Record<string, unknown>>),
    tasks: mapTaskRows(taskRows as Array<Record<string, unknown>>),
    projects: mapCountRows(projectRows as Array<Record<string, unknown>>),
    wiki: mapCountRows(wikiRows as Array<Record<string, unknown>>),
    mcp: mapCountRows(mcpRows as Array<Record<string, unknown>>),
    api: mapCountRows(apiRows as Array<Record<string, unknown>>),
    oauth: mapCountRows(oauthRows as Array<Record<string, unknown>>),
  };
}

memberRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    // A guest sees only the people who share a space with them, without
    // their email addresses (lib/people-visibility.ts).
    const viewer = await peopleViewer(user.org_id, user.id);

    const members = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      kind: users.kind,
      avatar_url: users.avatar_url,
      status_emoji: users.status_emoji,
      status_text: users.status_text,
      status_expires_at: users.status_expires_at,
      role: orgMembers.role,
    })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.user_id, users.id))
      .where(
        and(
          eq(orgMembers.org_id, user.org_id),
          eq(orgMembers.is_active, true),
          visibleLiveMemberForOrg(orgMembers.org_id),
          personVisibleSql(viewer, users.id),
        )
      );

    // Clear expired statuses
    const now = new Date();
    const result = members.map(member => {
      // is_defty is read before a guest's view hides the email address.
      const m = { ...member, email: emailFor(viewer, member.id, member.email), is_defty: member.email === DEFTY_EMAIL };
      if (m.status_expires_at && new Date(m.status_expires_at) < now) {
        // Auto-clear expired status (fire-and-forget DB update)
        db.update(users).set({ status_emoji: null, status_text: null, status_expires_at: null })
          .where(eq(users.id, m.id)).catch(() => {});
        return { ...m, status_emoji: null, status_text: null, status_expires_at: null };
      }
      return m;
    });

    return c.json(result);
  } catch (err) {
    console.error('Failed to fetch members:');
    return c.json({ error: 'Failed to fetch members', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/members/:id — get single member profile
// GET /api/members/directory - people directory with lifecycle + work stats.
memberRoutes.get('/directory', async (c) => {
  try {
    const user = c.get('user');
    const currentMembership = await getCurrentMembership(user.org_id, user.id);
    const isAdmin = currentMembership?.role === 'owner' || currentMembership?.role === 'admin';
    const viewer = await peopleViewer(user.org_id, user.id);

    const rows = await db.select({
      membership_id: orgMembers.id,
      member_id: users.id,
      name: users.name,
      email: users.email,
      kind: users.kind,
      avatar_url: users.avatar_url,
      title: users.title,
      profile_summary: users.profile_summary,
      expertise_tags: users.expertise_tags,
      timezone: users.timezone,
      status_emoji: users.status_emoji,
      status_text: users.status_text,
      status_expires_at: users.status_expires_at,
      last_seen_at: users.last_seen_at,
      email_verified: users.email_verified,
      password_hash: users.password_hash,
      role: orgMembers.role,
      is_active: orgMembers.is_active,
      joined_at: orgMembers.joined_at,
      agent_employee_id: agentEmployees.id,
      agent_name: agentEmployees.name,
      agent_role: agentEmployees.role,
      trust_level: agentEmployees.trust_level,
      runtime_kind: agentEmployees.runtime_kind,
      certification_status: agentEmployees.certification_status,
      agent_is_active: agentEmployees.is_active,
      unhealthy: agentEmployees.unhealthy,
      last_mcp_call_at: agentEmployees.last_mcp_call_at,
      last_heartbeat_at: agentEmployees.last_heartbeat_at,
    })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.user_id, users.id))
      .leftJoin(agentEmployees, and(
        eq(agentEmployees.user_id, users.id),
        eq(agentEmployees.org_id, orgMembers.org_id),
        eq(agentEmployees.is_deleted, false),
      ))
      .where(and(
        eq(orgMembers.org_id, user.org_id),
        isAdmin ? sql`true` : eq(orgMembers.is_active, true),
        visibleLiveMemberForOrg(orgMembers.org_id),
        personVisibleSql(viewer, users.id),
      ))
      .orderBy(desc(orgMembers.is_active), users.name);

    const userIds = rows.map((row) => row.member_id);
    const [stats, inviteRows] = await Promise.all([
      loadPeopleStats(user.org_id, userIds, user.id),
      isAdmin ? listOrgInvites(user.org_id) : Promise.resolve([]),
    ]);

    const activePendingInvites = new Map<string, (typeof inviteRows)[number]>();
    for (const invite of inviteRows) {
      if (invite.status === 'pending' && invite.email) {
        activePendingInvites.set(invite.email.toLowerCase(), invite);
      }
    }

    const now = new Date();
    const members = rows.map((row) => {
      const invite = row.email ? activePendingInvites.get(row.email.toLowerCase()) : undefined;
      const statusExpired = row.status_expires_at && new Date(row.status_expires_at) < now;
      const taskStats = stats.tasks.get(row.member_id) ?? { open: 0, total: 0 };
      const lifecycle_status = row.is_active
        ? (row.kind === 'agent' ? 'active' : (invite || !row.password_hash ? 'pending' : 'active'))
        : 'inactive';

      return {
        id: row.member_id,
        membership_id: row.membership_id,
        name: row.name,
        email: emailFor(viewer, row.member_id, row.email),
        kind: row.kind,
        avatar_url: row.avatar_url,
        title: row.title,
        profile_summary: row.profile_summary,
        expertise_tags: row.expertise_tags ?? [],
        timezone: row.timezone,
        status_emoji: statusExpired ? null : row.status_emoji,
        status_text: statusExpired ? null : row.status_text,
        status_expires_at: statusExpired ? null : compactDate(row.status_expires_at),
        last_seen_at: compactDate(row.last_seen_at),
        email_verified: row.email_verified,
        role: row.role,
        is_active: row.is_active,
        joined_at: compactDate(row.joined_at),
        lifecycle_status,
        pending_invite_id: invite?.id ?? null,
        pending_invite_expires_at: invite?.expires_at ?? null,
        stats: {
          spaces: stats.spaces.get(row.member_id) ?? 0,
          assigned_tasks_open: taskStats.open,
          assigned_tasks_total: taskStats.total,
          led_projects: stats.projects.get(row.member_id) ?? 0,
          wiki_pages: stats.wiki.get(row.member_id) ?? 0,
          active_mcp_tokens: stats.mcp.get(row.member_id) ?? 0,
          active_api_keys: stats.api.get(row.member_id) ?? 0,
          active_oauth_grants: stats.oauth.get(row.member_id) ?? 0,
        },
        agent: row.agent_employee_id ? {
          id: row.agent_employee_id,
          name: row.agent_name,
          role: row.agent_role,
          trust_level: row.trust_level,
          runtime_kind: row.runtime_kind,
          certification_status: row.certification_status,
          is_active: row.agent_is_active,
          unhealthy: row.unhealthy,
          last_mcp_call_at: compactDate(row.last_mcp_call_at),
          last_heartbeat_at: compactDate(row.last_heartbeat_at),
        } : null,
      };
    });

    return c.json({
      members,
      invites: inviteRows,
      summary: {
        active: members.filter((m) => m.lifecycle_status === 'active').length,
        pending: members.filter((m) => m.lifecycle_status === 'pending').length,
        inactive: members.filter((m) => m.lifecycle_status === 'inactive').length,
        agents: members.filter((m) => m.kind === 'agent').length,
      },
    });
  } catch (err) {
    console.error('Failed to fetch people directory:');
    return c.json({ error: 'Failed to fetch people directory', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/members/seats — seats in use, the paid limit (hosted cells) and
// whether adding people is frozen and why. Read-only; admins and owners.
memberRoutes.get('/seats', async (c) => {
  try {
    const currentUser = c.get('user');
    let callerRole: string;
    try {
      callerRole = (await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id)).role;
    } catch (err) {
      return adminForbidden(c, err);
    }
    const status = await getSeatStatus(currentUser.org_id);
    // Buying seats does not unfreeze growth, so a frozen cell shows no link.
    return c.json({ ...status, buy_seats_url: status.growth_frozen ? null : buySeatsUrlFor(callerRole) });
  } catch (err) {
    console.error('Failed to read seat status:');
    return c.json({ error: 'Failed to read seat status', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/members/invites - admin invite ledger.
memberRoutes.get('/invites', async (c) => {
  try {
    const user = c.get('user');
    try {
      await requireOrgAdminOrOwner(user.org_id, user.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    return c.json({ invites: await listOrgInvites(user.org_id) });
  } catch (err) {
    console.error('Failed to fetch invites:');
    return c.json({ error: 'Failed to fetch invites', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/members/:id/detail - deeper admin/member profile context.
memberRoutes.get('/:id/detail', async (c) => {
  try {
    const user = c.get('user');
    const memberId = c.req.param('id');
    const currentMembership = await getCurrentMembership(user.org_id, user.id);
    const isAdmin = currentMembership?.role === 'owner' || currentMembership?.role === 'admin';
    const viewer = await peopleViewer(user.org_id, user.id);

    const [member] = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      kind: users.kind,
      avatar_url: users.avatar_url,
      title: users.title,
      profile_summary: users.profile_summary,
      expertise_tags: users.expertise_tags,
      timezone: users.timezone,
      status_emoji: users.status_emoji,
      status_text: users.status_text,
      status_expires_at: users.status_expires_at,
      last_seen_at: users.last_seen_at,
      email_verified: users.email_verified,
      password_hash: users.password_hash,
      role: orgMembers.role,
      is_active: orgMembers.is_active,
      joined_at: orgMembers.joined_at,
      agent_employee_id: agentEmployees.id,
      agent_name: agentEmployees.name,
      agent_role: agentEmployees.role,
      trust_level: agentEmployees.trust_level,
      runtime_kind: agentEmployees.runtime_kind,
      certification_status: agentEmployees.certification_status,
      agent_is_active: agentEmployees.is_active,
      unhealthy: agentEmployees.unhealthy,
      last_mcp_call_at: agentEmployees.last_mcp_call_at,
      last_heartbeat_at: agentEmployees.last_heartbeat_at,
    })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.user_id, users.id))
      .leftJoin(agentEmployees, and(
        eq(agentEmployees.user_id, users.id),
        eq(agentEmployees.org_id, orgMembers.org_id),
        eq(agentEmployees.is_deleted, false),
      ))
      .where(and(
        eq(orgMembers.org_id, user.org_id),
        eq(users.id, memberId),
        isAdmin ? sql`true` : eq(orgMembers.is_active, true),
        visibleLiveMemberForOrg(orgMembers.org_id),
        personVisibleSql(viewer, users.id),
      ))
      .limit(1);

    if (!member) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    const [stats, inviteRows, memberSpaces, openTasks, ledProjects, recentMcpTokens, recentOauthGrants] = await Promise.all([
      loadPeopleStats(user.org_id, [memberId], user.id),
      isAdmin ? listOrgInvites(user.org_id) : Promise.resolve([]),
      db.select({
        id: spaces.id,
        name: spaces.name,
        type: spaces.type,
        is_default: spaces.is_default,
        joined_at: spaceMembers.joined_at,
      })
        .from(spaceMembers)
        .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
        .where(and(
          eq(spaces.org_id, user.org_id),
          eq(spaceMembers.user_id, memberId),
          // A guest is shown only the spaces they share with this person.
          viewer.guest
            ? sql`EXISTS (SELECT 1 FROM ${spaceMembers} viewer_membership
                WHERE viewer_membership.space_id = ${spaces.id} AND viewer_membership.user_id = ${user.id})`
            : sql`true`,
        ))
        .orderBy(desc(spaceMembers.joined_at))
        .limit(12),
      db.select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        due_date: tasks.due_date,
        updated_at: tasks.updated_at,
        project_id: tasks.project_id,
      })
        .from(tasks)
        .where(and(
          eq(tasks.org_id, user.org_id),
          eq(tasks.assignee_id, memberId),
          eq(tasks.is_deleted, false),
          sql`${tasks.status} NOT IN ('done', 'cancelled')`,
          visibleTaskSql(user.id),
        ))
        .orderBy(desc(tasks.updated_at))
        .limit(8),
      db.select({
        id: projects.id,
        name: projects.name,
        prefix: projects.prefix,
        is_archived: projects.is_archived,
      })
        .from(projects)
        .where(and(eq(projects.org_id, user.org_id), eq(projects.lead_id, memberId), eq(projects.is_deleted, false)))
        .orderBy(desc(projects.updated_at))
        .limit(8),
      isAdmin ? db.select({
        id: mcpTokens.id,
        name: mcpTokens.name,
        token_prefix: mcpTokens.token_prefix,
        scopes: mcpTokens.scopes,
        last_used_at: mcpTokens.last_used_at,
        created_at: mcpTokens.created_at,
      })
        .from(mcpTokens)
        .where(and(eq(mcpTokens.org_id, user.org_id), eq(mcpTokens.user_id, memberId), sql`${mcpTokens.revoked_at} IS NULL`))
        .orderBy(desc(mcpTokens.created_at))
        .limit(5) : Promise.resolve([]),
      isAdmin ? db.select({
        id: oauthGrants.id,
        app_name: oauthGrants.app_name,
        connector_profile: oauthGrants.connector_profile,
        scopes: oauthGrants.scopes,
        created_at: oauthGrants.created_at,
        updated_at: oauthGrants.updated_at,
      })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.org_id, user.org_id), eq(oauthGrants.user_id, memberId), sql`${oauthGrants.revoked_at} IS NULL`))
        .orderBy(desc(oauthGrants.created_at))
        .limit(5) : Promise.resolve([]),
    ]);

    const taskStats = stats.tasks.get(memberId) ?? { open: 0, total: 0 };
    const pendingInvites = inviteRows.filter((invite) => {
      return invite.status === 'pending' && (
        invite.user_id === memberId ||
        (member.email && invite.email.toLowerCase() === member.email.toLowerCase())
      );
    });

    return c.json({
      member: {
        id: member.id,
        name: member.name,
        email: emailFor(viewer, member.id, member.email),
        kind: member.kind,
        avatar_url: member.avatar_url,
        title: member.title,
        profile_summary: member.profile_summary,
        expertise_tags: member.expertise_tags ?? [],
        timezone: member.timezone,
        status_emoji: member.status_expires_at && new Date(member.status_expires_at) < new Date() ? null : member.status_emoji,
        status_text: member.status_expires_at && new Date(member.status_expires_at) < new Date() ? null : member.status_text,
        last_seen_at: compactDate(member.last_seen_at),
        email_verified: member.email_verified,
        role: member.role,
        // Is or was owner or admin (a person or an agent): only the owner
        // changes, removes or recovers this membership (lib/membership-guard.ts).
        owner_only: await isProtectedMembership(db, user.org_id, member.id, member.role),
        is_active: member.is_active,
        joined_at: compactDate(member.joined_at),
        lifecycle_status: member.is_active
          ? (member.kind === 'agent' ? 'active' : (pendingInvites.length > 0 || !member.password_hash ? 'pending' : 'active'))
          : 'inactive',
        stats: {
          spaces: stats.spaces.get(memberId) ?? 0,
          assigned_tasks_open: taskStats.open,
          assigned_tasks_total: taskStats.total,
          led_projects: stats.projects.get(memberId) ?? 0,
          wiki_pages: stats.wiki.get(memberId) ?? 0,
          active_mcp_tokens: stats.mcp.get(memberId) ?? 0,
          active_api_keys: stats.api.get(memberId) ?? 0,
          active_oauth_grants: stats.oauth.get(memberId) ?? 0,
        },
        agent: member.agent_employee_id ? {
          id: member.agent_employee_id,
          name: member.agent_name,
          role: member.agent_role,
          trust_level: member.trust_level,
          runtime_kind: member.runtime_kind,
          certification_status: member.certification_status,
          is_active: member.agent_is_active,
          unhealthy: member.unhealthy,
          last_mcp_call_at: compactDate(member.last_mcp_call_at),
          last_heartbeat_at: compactDate(member.last_heartbeat_at),
        } : null,
      },
      spaces: memberSpaces.map((space) => ({ ...space, joined_at: compactDate(space.joined_at) })),
      open_tasks: openTasks.map((task) => ({
        ...task,
        due_date: compactDate(task.due_date),
        updated_at: compactDate(task.updated_at),
      })),
      led_projects: ledProjects,
      pending_invites: pendingInvites,
      mcp_tokens: recentMcpTokens.map((token) => ({
        ...token,
        last_used_at: compactDate(token.last_used_at),
        created_at: compactDate(token.created_at),
      })),
      oauth_grants: recentOauthGrants.map((grant) => ({
        ...grant,
        created_at: compactDate(grant.created_at),
        updated_at: compactDate(grant.updated_at),
      })),
    });
  } catch (err) {
    console.error('Failed to fetch member detail:');
    return c.json({ error: 'Failed to fetch member detail', code: 'INTERNAL_ERROR' }, 500);
  }
});

memberRoutes.get('/:id/offboarding-preview', async (c) => {
  try {
    const currentUser = c.get('user');
    const memberId = c.req.param('id');

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    const [targetMembership] = await db.select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(
        eq(orgMembers.org_id, currentUser.org_id),
        eq(orgMembers.user_id, memberId),
        eq(orgMembers.is_active, true),
      ))
      .limit(1);

    if (!targetMembership) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    if (targetMembership.role === 'owner') {
      return c.json({ error: 'Cannot remove the org owner', code: 'FORBIDDEN' }, 403);
    }

    return c.json(await buildOffboardingPreview(currentUser.org_id, memberId));
  } catch (err) {
    console.error('Failed to build offboarding preview:');
    return c.json({ error: 'Failed to build offboarding preview', code: 'INTERNAL_ERROR' }, 500);
  }
});

memberRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const memberId = c.req.param('id');
    const viewer = await peopleViewer(user.org_id, user.id);

    const [member] = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      kind: users.kind,
      avatar_url: users.avatar_url,
      title: users.title,
      profile_summary: users.profile_summary,
      expertise_tags: users.expertise_tags,
      timezone: users.timezone,
      status_emoji: users.status_emoji,
      status_text: users.status_text,
      last_seen_at: users.last_seen_at,
      role: orgMembers.role,
    })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.user_id, users.id))
      .where(and(
        eq(orgMembers.org_id, user.org_id),
        eq(orgMembers.is_active, true),
        eq(users.id, memberId),
        visibleLiveMemberForOrg(orgMembers.org_id),
        personVisibleSql(viewer, users.id),
      ))
      .limit(1);

    if (!member) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json({ ...member, email: emailFor(viewer, member.id, member.email) });
  } catch (err) {
    console.error('Failed to fetch member:');
    return c.json({ error: 'Failed to fetch member', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/members/invite — invite a new member to the org
const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'guest']).default('member'),
});

memberRoutes.post('/invite', async (c) => {
  try {
    const currentUser = c.get('user');

    let callerRole: string;
    try {
      callerRole = (await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id)).role;
    } catch (err) {
      return adminForbidden(c, err);
    }

    const body = await c.req.json();
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const { email, role } = parsed.data;

    // The seat check and the membership write share one transaction (and, on
    // a hosted cell, one seat lock), so two invites cannot both take the last seat.
    const added = await withSeatRetry(() => db.transaction(async (tx) => {
      // The one locked path (lib/membership-guard.ts): account, membership,
      // the owner-only rule (a person who is or was an owner or admin is the
      // owner's; an admin may grant admin to someone never privileged), then
      // the writes, the record of the grant and the link, all under the same
      // locks. Membership row before the seat lock.
      const [byEmail] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      const locked = byEmail ? await lockMembership(tx, { orgId: currentUser.org_id, targetUserId: byEmail.id }) : null;
      if (locked?.membership?.is_active) return { alreadyMember: true as const };
      const refusal = await authorizeMembershipOperation(tx, {
        orgId: currentUser.org_id, actor: { userId: currentUser.id }, locked: { protected: locked?.protected ?? false }, resultingRole: role,
      });
      if (refusal) return { guardRefusal: refusal };

      // A guest, or an existing non-human account, takes no seat.
      if (role !== 'guest' && (!locked?.account || locked.account.kind === 'human')) {
        const seat = await reserveSeat(tx, currentUser.org_id);
        if (!seat.ok) return { seatRefusal: seat };
      }

      let userId = locked?.account?.id ?? null;
      let generation = locked?.account?.password_version ?? 0;
      if (locked?.account && locked.membership) {
        generation = await recordMembershipChange(tx, { orgId: currentUser.org_id, targetUserId: locked.account.id, locked, change: { isActive: true, role } });
        await tx.update(orgMembers)
          .set({ is_active: true, role })
          .where(eq(orgMembers.id, locked.membership.id));
      }
      if (!userId) {
        // Create the user with no password — they'll set one when accepting.
        const [newUser] = await tx.insert(users).values({
          name: email.split('@')[0]!,
          email,
          password_hash: null,
        }).returning();
        userId = newUser!.id;
        generation = newUser!.password_version;
      }

      // Add to org
      if (!locked?.membership) {
        await tx.insert(orgMembers).values({
          org_id: currentUser.org_id,
          user_id: userId,
          role,
        });
        // A first grant of admin is recorded with the generation its link carries.
        if (role === 'admin') await recordPrivilege(tx, { orgId: currentUser.org_id, userId, generation });
      }

      // The invite link, made under the same locks: it carries the account's
      // generation, so any later role or active-state change makes it stale.
      // The `member.joined` trigger fires on accept, not here.
      const inviteToken = jwt.sign(
        {
          purpose: 'invite-accept',
          password_version: generation,
          user_id: userId,
          org_id: currentUser.org_id,
          email,
          inviter_id: currentUser.id,
          role,
          nonce: crypto.randomUUID(),
        },
        env.JWT_SECRET,
        { expiresIn: INVITE_TTL },
      );
      const decoded = jwt.decode(inviteToken) as { exp?: number } | null;
      const expiresAtDate = decoded?.exp ? new Date(decoded.exp * 1000) : null;
      await tx.insert(invites).values({
        org_id: currentUser.org_id,
        email,
        token: inviteToken,
        type: 'email',
        invited_by: currentUser.id,
        expires_at: expiresAtDate ?? undefined,
      });
      return { userId, inviteToken, expiresAtDate };
    }), (result) => ('seatRefusal' in result && result.seatRefusal ? result.seatRefusal : null));

    if ('alreadyMember' in added) {
      return c.json({ error: 'User is already a member', code: 'ALREADY_MEMBER' }, 409);
    }
    if ('guardRefusal' in added) {
      return c.json({ error: added.guardRefusal, code: 'FORBIDDEN' }, 403);
    }
    if ('seatRefusal' in added && added.seatRefusal) {
      return seatRefused(c, added.seatRefusal, callerRole);
    }
    // Add to all default (public) spaces
    const defaultSpaces = await db.select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.org_id, currentUser.org_id), eq(spaces.is_default, true)));

    for (const space of defaultSpaces) {
      await db.insert(spaceMembers).values({
        space_id: space.id,
        user_id: added.userId,
      }).onConflictDoNothing();
    }

    return c.json(
      {
        success: true,
        message: 'Invitation created',
        user_id: added.userId,
        invite_url: buildInviteUrl(added.inviteToken),
        expires_at: added.expiresAtDate?.toISOString() ?? null,
      },
      201,
    );
  } catch (err) {
    // Two invites for the same new address at once: the second finds the
    // first's account (unique email) and is told so.
    const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === '23505') return c.json({ error: 'User is already a member', code: 'ALREADY_MEMBER' }, 409);
    console.error('Failed to invite member:');
    return c.json({ error: 'Failed to invite member', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/members/:id/recovery-url — admin-only password recovery URL.
// Returns a short-lived password-reset link the admin shares out of band.
// Self-hosted Deft has no email; admin recovery is the supported path.
// POST /api/members/invites/:id/reissue - refresh a pending invite link.
memberRoutes.post('/invites/:id/reissue', async (c) => {
  try {
    const currentUser = c.get('user');
    const inviteId = c.req.param('id');

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    const result = await db.transaction(async (tx) => {
      // Find the person, then the one locked path (lib/membership-guard.ts):
      // account, membership, invite; the owner-only rule; then the new link,
      // made from the generation and role read under those locks.
      const [found] = await tx.select().from(invites)
        .where(and(eq(invites.org_id, currentUser.org_id), eq(invites.id, inviteId)))
        .limit(1);
      if (!found) return { failure: 'NOT_FOUND' as const };
      const claims = decodeInviteClaims(found.token);
      let userId = claims?.user_id ?? null;
      const email = found.email ?? claims?.email;
      if (!userId && email) {
        const [byEmail] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
        userId = byEmail?.id ?? null;
      }
      if (!userId || !email) return { failure: 'INVITE_INVALID' as const };
      const locked = await lockMembership(tx, { orgId: currentUser.org_id, targetUserId: userId });
      const [invite] = await tx.select().from(invites)
        .where(and(eq(invites.org_id, currentUser.org_id), eq(invites.id, inviteId)))
        .for('update');
      if (!invite) return { failure: 'NOT_FOUND' as const };
      if (invite.accepted_at) return { failure: 'INVITE_ACCEPTED' as const };
      if (!locked.account || !locked.membership) return { failure: 'INVITE_INVALID' as const };
      const refusal = await authorizeMembershipOperation(tx, {
        orgId: currentUser.org_id, actor: { userId: currentUser.id }, locked, resultingRole: locked.membership.role,
      });
      if (refusal) return { failure: 'GUARD' as const, error: refusal };

      const inviteToken = jwt.sign({
        purpose: 'invite-accept', password_version: locked.account.password_version, user_id: userId, org_id: currentUser.org_id, email,
        inviter_id: currentUser.id, role: locked.membership.role, nonce: crypto.randomUUID(),
      }, env.JWT_SECRET, { expiresIn: INVITE_TTL });
      const decoded = jwt.decode(inviteToken) as { exp?: number } | null;
      const expiresAtDate = decoded?.exp ? new Date(decoded.exp * 1000) : null;
      await tx.update(invites).set({ token: inviteToken, invited_by: currentUser.id, expires_at: expiresAtDate ?? undefined, updated_at: new Date() })
        .where(eq(invites.id, inviteId));
      return { inviteToken, expiresAtDate };
    });
    if ('failure' in result) {
      if (result.failure === 'NOT_FOUND') return c.json({ error: 'Invite not found', code: 'NOT_FOUND' }, 404);
      if (result.failure === 'INVITE_ACCEPTED') return c.json({ error: 'Accepted invites cannot be reissued', code: 'INVITE_ACCEPTED' }, 409);
      if (result.failure === 'GUARD') return c.json({ error: result.error, code: 'FORBIDDEN' }, 403);
      return c.json({ error: 'Invite payload is incomplete', code: 'INVITE_INVALID' }, 409);
    }

    return c.json({
      success: true,
      invite_url: buildInviteUrl(result.inviteToken),
      expires_at: result.expiresAtDate?.toISOString() ?? null,
    });
  } catch (err) {
    console.error('Failed to reissue invite:');
    return c.json({ error: 'Failed to reissue invite', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/members/invites/:id - revoke a pending invite.
memberRoutes.delete('/invites/:id', async (c) => {
  try {
    const currentUser = c.get('user');
    const inviteId = c.req.param('id');

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    const revokedAt = new Date();
    const result = await db.transaction(async (tx) => {
      // Find the person first, then lock account -> invite -> membership ->
      // sessions: the membership guard's order (account, membership, invites).
      const [found] = await tx.select().from(invites)
        .where(and(eq(invites.org_id, currentUser.org_id), eq(invites.id, inviteId)))
        .limit(1);
      if (!found) return { failure: 'NOT_FOUND' as const };
      const claims = decodeInviteClaims(found.token);
      let userId = claims?.user_id ?? null;
      const email = found.email ?? claims?.email;
      if (!userId && email) {
        const [byEmail] = await tx.select({ id: users.id }).from(users)
          .where(eq(users.email, email)).limit(1);
        userId = byEmail?.id ?? null;
      }
      // DFX2: the person's room-access lock first (lib/room-access-lock.ts).
      if (userId) await lockRoomAccessChange(tx, currentUser.org_id, userId);
      // The one locked path: account, membership, invite; the owner-only rule.
      const locked = userId ? await lockMembership(tx, { orgId: currentUser.org_id, targetUserId: userId }) : null;
      const [invite] = await tx.select().from(invites)
        .where(and(eq(invites.org_id, currentUser.org_id), eq(invites.id, inviteId)))
        .for('update');
      if (!invite) return { failure: 'NOT_FOUND' as const };
      if (invite.accepted_at) return { failure: 'INVITE_ACCEPTED' as const };
      if (locked?.membership) {
        const refusal = await authorizeMembershipOperation(tx, { orgId: currentUser.org_id, actor: { userId: currentUser.id }, locked });
        if (refusal) return { failure: 'GUARD' as const, error: refusal };
      }

      const revokedSessionIds: string[] = [];
      const closedActions: string[] = [];
      let deactivatedUserId: string | null = null;
      if (userId && locked) {
        const user = locked.account;
        const membership = locked.membership;
        if (user && membership?.is_active && !user.password_hash && membership.role !== 'owner') {
          await recordMembershipChange(tx, { orgId: currentUser.org_id, targetUserId: userId, locked, change: { isActive: false } });
          await tx.update(orgMembers).set({ is_active: false, updated_at: revokedAt }).where(eq(orgMembers.id, membership.id));
          // Every access ends here, under the same locks: nothing runs later
          // that could reach a membership the owner restored in between.
          revokedSessionIds.push(...await endWorkspaceAccess(tx, currentUser.org_id, userId, revokedAt, closedActions));
          deactivatedUserId = userId;
        }
      }
      await tx.delete(invites).where(eq(invites.id, inviteId));
      return { revokedSessionIds, deactivatedUserId, closedActions };
    });
    if ('failure' in result) {
      if (result.failure === 'NOT_FOUND') return c.json({ error: 'Invite not found', code: 'NOT_FOUND' }, 404);
      if (result.failure === 'GUARD') return c.json({ error: result.error, code: 'FORBIDDEN' }, 403);
      return c.json({ error: 'Accepted invites cannot be revoked here', code: 'INVITE_ACCEPTED' }, 409);
    }
    if (result.deactivatedUserId) await afterWorkspaceAccessEnded(currentUser.org_id, result.deactivatedUserId, result.revokedSessionIds, result.closedActions);
    else emitWebSessionRevocations(result.revokedSessionIds);

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to revoke invite:');
    return c.json({ error: 'Failed to revoke invite', code: 'INTERNAL_ERROR' }, 500);
  }
});

memberRoutes.post('/:id/recovery-url', async (c) => {
  try {
    const currentUser = c.get('user');
    const memberId = c.req.param('id');

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    // A recovery link sets a new password, so it follows the owner-only rule:
    // for a person who is or was an owner or admin, only the owner makes one.
    // It is made under the one locked path and carries the generation read
    // there. It never removes two-step verification: a code is still needed.
    const made = await db.transaction(async (tx) => {
      const locked = await lockMembership(tx, { orgId: currentUser.org_id, targetUserId: memberId });
      if (!locked.account || !locked.membership?.is_active) return { failure: 'NOT_FOUND' as const };
      const refusal = await authorizeMembershipOperation(tx, { orgId: currentUser.org_id, actor: { userId: currentUser.id }, locked });
      if (refusal) return { failure: 'GUARD' as const, error: refusal };
      return {
        token: jwt.sign(
          // issued_by: redemption checks again that someone who is or was an
          // owner or admin is recovered only with the owner's link.
          { id: locked.account.id, email: locked.account.email, org_id: currentUser.org_id, purpose: 'password-reset', password_version: locked.account.password_version, issued_by: currentUser.id },
          env.JWT_SECRET,
          { expiresIn: RECOVERY_TTL },
        ),
      };
    });
    if ('failure' in made) {
      if (made.failure === 'NOT_FOUND') return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
      return c.json({ error: made.error, code: 'FORBIDDEN' }, 403);
    }
    const resetToken = made.token;

    const decoded = jwt.decode(resetToken) as { exp?: number } | null;
    const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null;

    return c.json({
      recovery_url: buildRecoveryUrl(resetToken),
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('Failed to generate recovery URL:');
    return c.json({ error: 'Failed to generate recovery URL', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/members/:id — update member role
const roleUpdateSchema = z.object({
  role: z.enum(['admin', 'member', 'guest']),
});

memberRoutes.patch('/:id', async (c) => {
  try {
    const currentUser = c.get('user');
    const memberId = c.req.param('id');

    let callerRole: string;
    try {
      callerRole = (await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id)).role;
    } catch (err) {
      return adminForbidden(c, err);
    }

    const body = await c.req.json();
    const parsed = roleUpdateSchema.safeParse(body);

    // Read, seat check and role change share one transaction (and, on a
    // hosted cell, one seat lock): a guest becoming a member takes a seat.
    let closedOnRoleChange: string[] = [];
    const changed = await withSeatRetry(() => db.transaction(async (tx) => {
      // DFX2: the person's room-access lock first (lib/room-access-lock.ts);
      // a demotion to guest ends their unjoined public rooms.
      await lockRoomAccessChange(tx, currentUser.org_id, memberId);
      // The one locked path (lib/membership-guard.ts): account, membership.
      const locked = await lockMembership(tx, { orgId: currentUser.org_id, targetUserId: memberId });
      // Can't change owner role
      const [targetMembership] = await tx.select({ role: orgMembers.role, id: orgMembers.id, kind: users.kind })
        .from(orgMembers)
        .innerJoin(users, eq(users.id, orgMembers.user_id))
        .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, memberId), eq(orgMembers.is_active, true)))
        .limit(1)
        .for('update', { of: orgMembers });

      if (!targetMembership) return { failure: 'NOT_FOUND' as const };
      if (targetMembership.role === 'owner') return { failure: 'OWNER' as const };
      if (!parsed.success) return { failure: 'INVALID' as const };
      // Owner-only for a person who is or was an owner or admin; an admin may promote a member or guest.
      const refusal = await authorizeMembershipOperation(tx, {
        orgId: currentUser.org_id, actor: { userId: currentUser.id }, locked, resultingRole: parsed.data.role,
      });
      if (refusal) return { failure: 'ADMIN' as const, error: refusal };

      // Hosted mode: the admin role takes effect only for someone who already
      // has two-step verification on, so no credential they hold (a web
      // session or a connected app's token) ever carries the role without it.
      // The row lock is the one disableTwoStep takes: either this sees
      // two-step still on, or turning it off sees the new role and is refused.
      if (roleMustHaveSecondStep(parsed.data.role)) {
        const [twoStep] = await tx.select({ confirmed_at: userTwoStep.confirmed_at })
          .from(userTwoStep)
          .where(eq(userTwoStep.user_id, memberId))
          .for('share');
        if (!twoStep?.confirmed_at) return { failure: 'TWO_STEP' as const };
      }

      if (targetMembership.role === 'guest' && parsed.data.role !== 'guest' && targetMembership.kind === 'human') {
        const seat = await reserveSeat(tx, currentUser.org_id);
        if (!seat.ok) return { seatRefusal: seat };
      }

      await recordMembershipChange(tx, { orgId: currentUser.org_id, targetUserId: memberId, locked, change: { role: parsed.data.role } });
      await tx.update(orgMembers)
        .set({ role: parsed.data.role })
        .where(eq(orgMembers.id, targetMembership.id));
      // DFX2: a guest reads no public room it has not joined; those pending
      // assistant actions close with the role change.
      closedOnRoleChange = parsed.data.role === 'guest' && targetMembership.role !== 'guest'
        ? await closeLostRoomActionsInTx(tx, { orgId: currentUser.org_id, requesterId: memberId })
        : [];
      return { previousRole: targetMembership.role, role: parsed.data.role };
    }), (result) => ('seatRefusal' in result && result.seatRefusal ? result.seatRefusal : null));

    if ('failure' in changed) {
      if (changed.failure === 'NOT_FOUND') return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
      if (changed.failure === 'OWNER') return c.json({ error: 'Cannot change owner role', code: 'FORBIDDEN' }, 403);
      if (changed.failure === 'ADMIN') return c.json({ error: changed.error, code: 'FORBIDDEN' }, 403);
      if (changed.failure === 'TWO_STEP') {
        return c.json({
          error: 'This person must turn on two-step verification (Settings, Profile) before they can be made an admin',
          code: 'TWO_STEP_NOT_ENROLLED',
        }, 409);
      }
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }
    if ('seatRefusal' in changed && changed.seatRefusal) {
      return seatRefused(c, changed.seatRefusal, callerRole);
    }
    if (changed.role !== changed.previousRole) {
      await evictActiveHuddleParticipants({
        orgId: currentUser.org_id,
        userId: memberId,
        reason: 'org_role_changed',
      });
    }
    await finishLostRoomCancellations(currentUser.org_id, closedOnRoleChange);

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to update member role:');
    return c.json({ error: 'Failed to update role', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/members/:id — remove member from org (soft deactivate)
memberRoutes.delete('/:id', async (c) => {
  try {
    const currentUser = c.get('user');
    const memberId = c.req.param('id');
    const rawBody = await c.req.json().catch(() => ({}));
    const parsedBody = offboardingPayloadSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: 'Invalid offboarding payload', code: 'VALIDATION_ERROR' }, 400);
    }
    const replacementUserId = parsedBody.data.replacement_user_id?.trim() || null;

    // Can't remove yourself
    if (memberId === currentUser.id) {
      return c.json({ error: 'Cannot remove yourself', code: 'FORBIDDEN' }, 403);
    }

    if (replacementUserId === memberId) {
      return c.json({ error: 'Replacement cannot be the removed member', code: 'VALIDATION_ERROR' }, 400);
    }

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    // Can't remove owner
    const [targetMembership] = await db.select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, memberId), eq(orgMembers.is_active, true)))
      .limit(1);

    if (!targetMembership) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    if (targetMembership.role === 'owner') {
      return c.json({ error: 'Cannot remove the org owner', code: 'FORBIDDEN' }, 403);
    }
    // Only the owner removes an admin (lib/membership-guard.ts), checked here
    // before any work is reassigned and again, under lock, at the write.
    const notRemovable = await checkMembershipOperation(db, { orgId: currentUser.org_id, targetUserId: memberId, actor: { userId: currentUser.id } });
    if (notRemovable) return c.json({ error: notRemovable, code: 'FORBIDDEN' }, 403);

    const preview = await buildOffboardingPreview(currentUser.org_id, memberId);
    let reassigned: Reassigned;
    try {
      reassigned = await revokeMemberWorkspaceAccess(currentUser.org_id, memberId, { userId: currentUser.id }, replacementUserId);
    } catch (err) {
      if (err instanceof MembershipGuardError) return c.json({ error: err.message, code: 'FORBIDDEN' }, 403);
      if (err instanceof ReassignmentError) return c.json({ error: err.message, code: 'VALIDATION_ERROR' }, 400);
      throw err;
    }
    const remaining = await buildOffboardingPreview(currentUser.org_id, memberId);

    return c.json({
      success: true,
      receipt: {
        revoked_at: new Date().toISOString(),
        revoked: preview.revoke_now,
        reassigned,
        remaining_reassignment: remaining.needs_reassignment,
        remaining_counts: {
          primary_open_tasks: remaining.counts.primary_open_tasks,
          led_projects: remaining.counts.led_projects,
          led_teams: remaining.counts.led_teams,
        },
      },
    });
  } catch (err) {
    console.error('Failed to remove member:');
    return c.json({ error: 'Failed to remove member', code: 'INTERNAL_ERROR' }, 500);
  }
});
