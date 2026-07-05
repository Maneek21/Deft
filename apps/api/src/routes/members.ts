import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { db } from '../lib/db.js';
import {
  users,
  orgMembers,
  spaces,
  spaceMembers,
  agentEmployees,
  mcpTokens,
  invites,
  apiKeys,
  oauthGrants,
  oauthAccessTokens,
  oauthRefreshTokens,
  projects,
  tasks,
  wikiPages,
} from '@deft/db/schema';
import { env } from '../lib/env.js';
import { DEFTY_EMAIL } from '../lib/ensure-defty-membership.js';
import { OrgMembershipError, requireOrgAdminOrOwner } from '../lib/org-membership.js';

const INVITE_TTL = '7d';
const RECOVERY_TTL = '24h';

function buildInviteUrl(token: string): string {
  return `${env.NEXT_PUBLIC_APP_URL}/invite/${token}`;
}

function buildRecoveryUrl(token: string): string {
  return `${env.NEXT_PUBLIC_APP_URL}/reset-password?token=${token}`;
}

export const memberRoutes = new Hono();

function adminForbidden(c: Context, err: unknown) {
  if (err instanceof OrgMembershipError) {
    return c.json({ error: err.message, code: err.code }, err.status as 403);
  }
  return c.json({ error: 'Only admins can perform this action', code: 'FORBIDDEN' }, 403);
}

function visibleLiveMemberForOrg(orgIdRef: unknown) {
  return sql`
    (
      ${users.kind} <> 'agent'
      OR ${users.email} = ${DEFTY_EMAIL}
      OR EXISTS (
        SELECT 1
        FROM ${agentEmployees}
        WHERE ${agentEmployees.user_id} = ${users.id}
          AND ${agentEmployees.org_id} = ${orgIdRef}
          AND ${agentEmployees.is_active} = true
          AND ${agentEmployees.is_deleted} = false
      )
    )
  `;
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

async function revokeMemberWorkspaceAccess(orgId: string, memberId: string, deactivateMembership = true) {
  const revokedAt = new Date();

  if (deactivateMembership) {
    await db.update(orgMembers)
      .set({ is_active: false, updated_at: revokedAt })
      .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, memberId)));
  }

  await db.execute(sql`
    DELETE FROM ${spaceMembers}
    WHERE ${spaceMembers.user_id} = ${memberId}
      AND ${spaceMembers.space_id} IN (
        SELECT ${spaces.id}
        FROM ${spaces}
        WHERE ${spaces.org_id} = ${orgId}
      )
  `);

  await db.update(mcpTokens)
    .set({ revoked_at: revokedAt, updated_at: revokedAt })
    .where(and(
      eq(mcpTokens.org_id, orgId),
      eq(mcpTokens.user_id, memberId),
      sql`${mcpTokens.revoked_at} IS NULL`,
    ));

  await db.update(apiKeys)
    .set({ is_active: false, updated_at: revokedAt })
    .where(and(
      eq(apiKeys.org_id, orgId),
      eq(apiKeys.created_by, memberId),
      eq(apiKeys.is_active, true),
    ));

  await db.update(oauthGrants)
    .set({ revoked_at: revokedAt, updated_at: revokedAt })
    .where(and(
      eq(oauthGrants.org_id, orgId),
      eq(oauthGrants.user_id, memberId),
      sql`${oauthGrants.revoked_at} IS NULL`,
    ));
  await db.update(oauthAccessTokens)
    .set({ revoked_at: revokedAt, updated_at: revokedAt })
    .where(and(
      eq(oauthAccessTokens.org_id, orgId),
      eq(oauthAccessTokens.user_id, memberId),
      sql`${oauthAccessTokens.revoked_at} IS NULL`,
    ));
  await db.execute(sql`
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

async function loadPeopleStats(orgId: string, userIds: string[]) {
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
      .where(and(eq(tasks.org_id, orgId), inArray(tasks.assignee_id, userIds)))
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
        )
      );

    // Clear expired statuses
    const now = new Date();
    const result = members.map(m => {
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
    console.error('Failed to fetch members:', err);
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
      ))
      .orderBy(desc(orgMembers.is_active), users.name);

    const userIds = rows.map((row) => row.member_id);
    const [stats, inviteRows] = await Promise.all([
      loadPeopleStats(user.org_id, userIds),
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
        email: row.email,
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
    console.error('Failed to fetch people directory:', err);
    return c.json({ error: 'Failed to fetch people directory', code: 'INTERNAL_ERROR' }, 500);
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
    console.error('Failed to fetch invites:', err);
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
      ))
      .limit(1);

    if (!member) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    const [stats, inviteRows, memberSpaces, openTasks, ledProjects, recentMcpTokens, recentOauthGrants] = await Promise.all([
      loadPeopleStats(user.org_id, [memberId]),
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
        .where(and(eq(spaces.org_id, user.org_id), eq(spaceMembers.user_id, memberId)))
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
        email: member.email,
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
    console.error('Failed to fetch member detail:', err);
    return c.json({ error: 'Failed to fetch member detail', code: 'INTERNAL_ERROR' }, 500);
  }
});

memberRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const memberId = c.req.param('id');

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
      ))
      .limit(1);

    if (!member) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json(member);
  } catch (err) {
    console.error('Failed to fetch member:', err);
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

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    const body = await c.req.json();
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const { email, role } = parsed.data;

    // Check if user already exists
    let [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    let membershipExists = false;
    if (existingUser) {
      const [existingMembership] = await db.select()
        .from(orgMembers)
        .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, existingUser.id)))
        .limit(1);

      if (existingMembership) {
        membershipExists = true;
        if (existingMembership.is_active) {
          return c.json({ error: 'User is already a member', code: 'ALREADY_MEMBER' }, 409);
        }
        await db.update(orgMembers)
          .set({ is_active: true, role })
          .where(eq(orgMembers.id, existingMembership.id));
      }
    } else {
      // Create the user with no password — they'll set one when accepting.
      const [newUser] = await db.insert(users).values({
        name: email.split('@')[0]!,
        email,
        password_hash: null,
      }).returning();
      existingUser = newUser!;
    }

    // Add to org
    if (!membershipExists) {
      await db.insert(orgMembers).values({
        org_id: currentUser.org_id,
        user_id: existingUser.id,
        role,
      });
    }

    // Add to all default (public) spaces
    const defaultSpaces = await db.select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.org_id, currentUser.org_id), eq(spaces.is_default, true)));

    for (const space of defaultSpaces) {
      await db.insert(spaceMembers).values({
        space_id: space.id,
        user_id: existingUser.id,
      }).onConflictDoNothing();
    }

    // Generate an invite URL the admin shares out-of-band (chat, in person,
    // whatever). The `member.joined` trigger fires on accept, not here, so
    // agents only react when the user actually shows up.
    const inviteToken = jwt.sign(
      {
        purpose: 'invite-accept',
        user_id: existingUser.id,
        org_id: currentUser.org_id,
        email,
        inviter_id: currentUser.id,
        role,
      },
      env.JWT_SECRET,
      { expiresIn: INVITE_TTL },
    );

    const decoded = jwt.decode(inviteToken) as { exp?: number } | null;
    const expiresAtDate = decoded?.exp ? new Date(decoded.exp * 1000) : null;
    const expiresAt = expiresAtDate?.toISOString() ?? null;

    await db.insert(invites).values({
      org_id: currentUser.org_id,
      email,
      token: inviteToken,
      type: 'email',
      invited_by: currentUser.id,
      expires_at: expiresAtDate ?? undefined,
    });

    return c.json(
      {
        success: true,
        message: 'Invitation created',
        user_id: existingUser.id,
        invite_url: buildInviteUrl(inviteToken),
        expires_at: expiresAt,
      },
      201,
    );
  } catch (err) {
    console.error('Failed to invite member:', err);
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

    const [invite] = await db.select()
      .from(invites)
      .where(and(eq(invites.org_id, currentUser.org_id), eq(invites.id, inviteId)))
      .limit(1);

    if (!invite) {
      return c.json({ error: 'Invite not found', code: 'NOT_FOUND' }, 404);
    }
    if (invite.accepted_at) {
      return c.json({ error: 'Accepted invites cannot be reissued', code: 'INVITE_ACCEPTED' }, 409);
    }

    const claims = decodeInviteClaims(invite.token);
    let userId = claims?.user_id ?? null;
    let role = claims?.role as 'admin' | 'member' | 'guest' | undefined;
    const email = invite.email ?? claims?.email;

    if ((!userId || !role) && email) {
      const [target] = await db.select({
        id: users.id,
        role: orgMembers.role,
      })
        .from(users)
        .innerJoin(orgMembers, eq(orgMembers.user_id, users.id))
        .where(and(eq(users.email, email), eq(orgMembers.org_id, currentUser.org_id)))
        .limit(1);
      userId = userId ?? target?.id ?? null;
      role = role ?? (target?.role as 'admin' | 'member' | 'guest' | undefined);
    }

    if (!userId || !email) {
      return c.json({ error: 'Invite payload is incomplete', code: 'INVITE_INVALID' }, 409);
    }

    const inviteToken = jwt.sign(
      {
        purpose: 'invite-accept',
        user_id: userId,
        org_id: currentUser.org_id,
        email,
        inviter_id: currentUser.id,
        role: role ?? 'member',
      },
      env.JWT_SECRET,
      { expiresIn: INVITE_TTL },
    );

    const decoded = jwt.decode(inviteToken) as { exp?: number } | null;
    const expiresAtDate = decoded?.exp ? new Date(decoded.exp * 1000) : null;
    await db.update(invites)
      .set({
        token: inviteToken,
        invited_by: currentUser.id,
        expires_at: expiresAtDate ?? undefined,
        updated_at: new Date(),
      })
      .where(eq(invites.id, inviteId));

    return c.json({
      success: true,
      invite_url: buildInviteUrl(inviteToken),
      expires_at: expiresAtDate?.toISOString() ?? null,
    });
  } catch (err) {
    console.error('Failed to reissue invite:', err);
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

    const [invite] = await db.select()
      .from(invites)
      .where(and(eq(invites.org_id, currentUser.org_id), eq(invites.id, inviteId)))
      .limit(1);

    if (!invite) {
      return c.json({ error: 'Invite not found', code: 'NOT_FOUND' }, 404);
    }
    if (invite.accepted_at) {
      return c.json({ error: 'Accepted invites cannot be revoked here', code: 'INVITE_ACCEPTED' }, 409);
    }

    const claims = decodeInviteClaims(invite.token);
    let userId = claims?.user_id ?? null;
    const email = invite.email ?? claims?.email;

    if (!userId && email) {
      const [target] = await db.select({ id: users.id })
        .from(users)
        .innerJoin(orgMembers, eq(orgMembers.user_id, users.id))
        .where(and(eq(users.email, email), eq(orgMembers.org_id, currentUser.org_id)))
        .limit(1);
      userId = target?.id ?? null;
    }

    await db.delete(invites).where(eq(invites.id, inviteId));

    if (userId) {
      const [target] = await db.select({
        password_hash: users.password_hash,
        role: orgMembers.role,
        is_active: orgMembers.is_active,
      })
        .from(users)
        .innerJoin(orgMembers, eq(orgMembers.user_id, users.id))
        .where(and(eq(users.id, userId), eq(orgMembers.org_id, currentUser.org_id)))
        .limit(1);

      if (target?.is_active && !target.password_hash && target.role !== 'owner') {
        await revokeMemberWorkspaceAccess(currentUser.org_id, userId, true);
      }
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to revoke invite:', err);
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

    const [target] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .innerJoin(orgMembers, eq(orgMembers.user_id, users.id))
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(users.id, memberId), eq(orgMembers.is_active, true)))
      .limit(1);

    if (!target) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    const resetToken = jwt.sign(
      { id: target.id, email: target.email, purpose: 'password-reset' },
      env.JWT_SECRET,
      { expiresIn: RECOVERY_TTL },
    );

    const decoded = jwt.decode(resetToken) as { exp?: number } | null;
    const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null;

    return c.json({
      recovery_url: buildRecoveryUrl(resetToken),
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('Failed to generate recovery URL:', err);
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

    try {
      await requireOrgAdminOrOwner(currentUser.org_id, currentUser.id);
    } catch (err) {
      return adminForbidden(c, err);
    }

    // Can't change owner role
    const [targetMembership] = await db.select({ role: orgMembers.role, id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, currentUser.org_id), eq(orgMembers.user_id, memberId), eq(orgMembers.is_active, true)))
      .limit(1);

    if (!targetMembership) {
      return c.json({ error: 'Member not found', code: 'NOT_FOUND' }, 404);
    }

    if (targetMembership.role === 'owner') {
      return c.json({ error: 'Cannot change owner role', code: 'FORBIDDEN' }, 403);
    }

    const body = await c.req.json();
    const parsed = roleUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    await db.update(orgMembers)
      .set({ role: parsed.data.role })
      .where(eq(orgMembers.id, targetMembership.id));

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to update member role:', err);
    return c.json({ error: 'Failed to update role', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/members/:id — remove member from org (soft deactivate)
memberRoutes.delete('/:id', async (c) => {
  try {
    const currentUser = c.get('user');
    const memberId = c.req.param('id');

    // Can't remove yourself
    if (memberId === currentUser.id) {
      return c.json({ error: 'Cannot remove yourself', code: 'FORBIDDEN' }, 403);
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

    await revokeMemberWorkspaceAccess(currentUser.org_id, memberId, true);

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to remove member:', err);
    return c.json({ error: 'Failed to remove member', code: 'INTERNAL_ERROR' }, 500);
  }
});
