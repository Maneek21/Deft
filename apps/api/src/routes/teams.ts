import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { and, count, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  agentActions,
  agentEmployees,
  icsSubscriptions,
  notes,
  orgMembers,
  projects,
  spaces,
  taskTemplates,
  teamDashboardSnapshots,
  teamMembers,
  teamResources,
  teams,
  tasks,
  users,
  wikiPages,
} from '@deft/db/schema';
import { db } from '../lib/db.js';
import { OrgMembershipError, requireOrgAdminOrOwner } from '../lib/org-membership.js';
import type { AuthUser } from '../middleware/auth.js';

export const teamRoutes = new Hono();

const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const TEAM_ROLES = ['lead', 'member', 'viewer'] as const;
const TEAM_VISIBILITIES = ['private', 'org'] as const;
const RESOURCE_TYPES = [
  'space',
  'project',
  'wiki_page',
  'note',
  'calendar_feed',
  'task_template',
  'agent_employee',
] as const;

const teamRoleSchema = z.enum(TEAM_ROLES);
const teamVisibilitySchema = z.enum(TEAM_VISIBILITIES);
const resourceTypeSchema = z.enum(RESOURCE_TYPES);

const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(120),
  handle: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  type: z.string().trim().min(1).max(64).default('functional'),
  visibility: teamVisibilitySchema.default('org'),
  avatar_url: z.string().trim().max(2048).nullable().optional(),
  color: z.string().trim().max(64).nullable().optional(),
  lead_user_id: z.string().trim().nullable().optional(),
  default_space_id: z.string().trim().nullable().optional(),
  member_ids: z.array(z.string().trim().min(1)).max(100).optional(),
});

const updateTeamSchema = createTeamSchema.omit({ member_ids: true }).partial().extend({
  is_archived: z.boolean().optional(),
}).strict();

const memberSchema = z.object({
  user_id: z.string().trim().min(1),
  role: teamRoleSchema.default('member'),
});

const memberRoleSchema = z.object({
  role: teamRoleSchema,
});

const resourceSchema = z.object({
  resource_type: resourceTypeSchema,
  resource_id: z.string().trim().min(1),
  label: z.string().trim().max(160).nullable().optional(),
});

type TeamRow = typeof teams.$inferSelect;
type ResourceType = (typeof RESOURCE_TYPES)[number];

function forbidden(c: Context, err: unknown) {
  if (err instanceof OrgMembershipError) {
    return c.json({ error: err.message, code: err.code }, err.status as 403);
  }
  return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
}

function normalizeHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function isAdminOrOwner(user: AuthUser) {
  return user.role === 'owner' || user.role === 'admin';
}

async function requireOrgManager(user: AuthUser) {
  return requireOrgAdminOrOwner(user.org_id, user.id);
}

async function getTeamForOrg(orgId: string, teamId: string): Promise<TeamRow | null> {
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.org_id, orgId), eq(teams.id, teamId)))
    .limit(1);
  return team ?? null;
}

async function getCurrentTeamRole(orgId: string, teamId: string, userId: string) {
  const [membership] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.org_id, orgId), eq(teamMembers.team_id, teamId), eq(teamMembers.user_id, userId)))
    .limit(1);
  return membership?.role ?? null;
}

async function canSeeTeam(user: AuthUser, team: TeamRow) {
  if (isAdminOrOwner(user)) return true;
  if (team.visibility === 'org') return true;
  if (team.lead_user_id === user.id) return true;
  return Boolean(await getCurrentTeamRole(user.org_id, team.id, user.id));
}

async function requireVisibleTeam(c: Context, user: AuthUser, teamId: string) {
  const team = await getTeamForOrg(user.org_id, teamId);
  if (!team || !(await canSeeTeam(user, team))) {
    return { response: c.json({ error: 'Team not found', code: 'NOT_FOUND' }, 404) };
  }
  return { team };
}

async function requireTeamManager(c: Context, user: AuthUser, teamId: string) {
  const visible = await requireVisibleTeam(c, user, teamId);
  if ('response' in visible) return visible;
  if (isAdminOrOwner(user)) return visible;
  if (visible.team.lead_user_id === user.id) return visible;
  const role = await getCurrentTeamRole(user.org_id, teamId, user.id);
  if (role === 'lead') return visible;
  return { response: c.json({ error: 'Team lead or org admin role required', code: 'FORBIDDEN' }, 403) };
}

async function getActiveOrgUserIds(orgId: string, userIds: string[]) {
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return [];
  const rows = await db
    .select({ user_id: orgMembers.user_id })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true), inArray(orgMembers.user_id, unique)));
  return rows.map((row) => row.user_id);
}

async function validateActiveOrgUsers(orgId: string, userIds: string[]) {
  const active = new Set(await getActiveOrgUserIds(orgId, userIds));
  return userIds.every((id) => active.has(id));
}

async function resourceBelongsToOrg(orgId: string, type: ResourceType, id: string) {
  switch (type) {
    case 'space': {
      const [row] = await db.select({ id: spaces.id }).from(spaces).where(and(eq(spaces.org_id, orgId), eq(spaces.id, id))).limit(1);
      return Boolean(row);
    }
    case 'project': {
      const [row] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.org_id, orgId), eq(projects.id, id), eq(projects.is_deleted, false)))
        .limit(1);
      return Boolean(row);
    }
    case 'wiki_page': {
      const [row] = await db
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.id, id), eq(wikiPages.is_deleted, false)))
        .limit(1);
      return Boolean(row);
    }
    case 'note': {
      const [row] = await db
        .select({ id: notes.id })
        .from(notes)
        .where(and(eq(notes.org_id, orgId), eq(notes.id, id), eq(notes.is_deleted, false)))
        .limit(1);
      return Boolean(row);
    }
    case 'calendar_feed': {
      const [row] = await db
        .select({ id: icsSubscriptions.id })
        .from(icsSubscriptions)
        .where(and(eq(icsSubscriptions.org_id, orgId), eq(icsSubscriptions.id, id)))
        .limit(1);
      return Boolean(row);
    }
    case 'task_template': {
      const [row] = await db
        .select({ id: taskTemplates.id })
        .from(taskTemplates)
        .where(and(eq(taskTemplates.id, id), eq(taskTemplates.is_deleted, false), or(eq(taskTemplates.org_id, orgId), isNull(taskTemplates.org_id))))
        .limit(1);
      return Boolean(row);
    }
    case 'agent_employee': {
      const [row] = await db
        .select({ id: agentEmployees.id })
        .from(agentEmployees)
        .where(and(eq(agentEmployees.org_id, orgId), eq(agentEmployees.id, id), eq(agentEmployees.is_deleted, false)))
        .limit(1);
      return Boolean(row);
    }
  }
}

async function buildTeamSummary(orgId: string, teamId: string) {
  const [memberCount] = await db
    .select({ count: count(teamMembers.id) })
    .from(teamMembers)
    .where(and(eq(teamMembers.org_id, orgId), eq(teamMembers.team_id, teamId)));

  const [agentCount] = await db
    .select({ count: count(teamMembers.id) })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.user_id))
    .leftJoin(agentEmployees, and(
      eq(agentEmployees.user_id, teamMembers.user_id),
      eq(agentEmployees.org_id, orgId),
      eq(agentEmployees.is_deleted, false),
    ))
    .where(
      and(
        eq(teamMembers.org_id, orgId),
        eq(teamMembers.team_id, teamId),
        or(eq(users.kind, 'agent'), sql`${agentEmployees.id} is not null`),
      ),
    );

  const resourceRows = await db
    .select({ type: teamResources.resource_type, count: count(teamResources.id) })
    .from(teamResources)
    .where(and(eq(teamResources.org_id, orgId), eq(teamResources.team_id, teamId)))
    .groupBy(teamResources.resource_type);

  const [latestSnapshot] = await db
    .select({
      id: teamDashboardSnapshots.id,
      snapshot_type: teamDashboardSnapshots.snapshot_type,
      payload_json: teamDashboardSnapshots.payload_json,
      generated_at: teamDashboardSnapshots.generated_at,
    })
    .from(teamDashboardSnapshots)
    .where(and(eq(teamDashboardSnapshots.org_id, orgId), eq(teamDashboardSnapshots.team_id, teamId)))
    .orderBy(desc(teamDashboardSnapshots.generated_at))
    .limit(1);

  return {
    member_count: memberCount?.count ?? 0,
    agent_count: agentCount?.count ?? 0,
    resources_by_type: Object.fromEntries(resourceRows.map((row) => [row.type, row.count])),
    latest_snapshot: latestSnapshot ?? null,
  };
}

async function buildTeamDashboard(orgId: string, teamId: string) {
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [members, resources, summary] = await Promise.all([
    db
      .select({
        user_id: teamMembers.user_id,
        role: teamMembers.role,
        name: users.name,
        kind: users.kind,
        agent_employee_id: agentEmployees.id,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.user_id))
      .leftJoin(agentEmployees, and(
        eq(agentEmployees.user_id, teamMembers.user_id),
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_deleted, false),
      ))
      .where(and(eq(teamMembers.org_id, orgId), eq(teamMembers.team_id, teamId))),
    db
      .select()
      .from(teamResources)
      .where(and(eq(teamResources.org_id, orgId), eq(teamResources.team_id, teamId))),
    buildTeamSummary(orgId, teamId),
  ]);

  const projectIds = resources.filter((row) => row.resource_type === 'project').map((row) => row.resource_id);
  const memberIds = members.map((row) => row.user_id);
  const openTaskPredicate = projectIds.length > 0
    ? and(
        eq(tasks.org_id, orgId),
        eq(tasks.is_deleted, false),
        inArray(tasks.project_id, projectIds),
        sql`${tasks.status} not in ('done', 'cancelled')`,
      )
    : null;

  const [
    openTaskCount,
    overdueTaskCount,
    dueSoonTaskCount,
    inReviewTaskCount,
    statusRows,
    ownerRows,
    attentionTasks,
    pendingActions,
  ] = await Promise.all([
    openTaskPredicate
      ? db.select({ count: count(tasks.id) }).from(tasks).where(openTaskPredicate)
      : Promise.resolve([{ count: 0 }]),
    openTaskPredicate
      ? db.select({ count: count(tasks.id) }).from(tasks).where(and(openTaskPredicate, lt(tasks.due_date, now)))
      : Promise.resolve([{ count: 0 }]),
    openTaskPredicate
      ? db.select({ count: count(tasks.id) }).from(tasks).where(and(openTaskPredicate, gte(tasks.due_date, now), lt(tasks.due_date, weekAhead)))
      : Promise.resolve([{ count: 0 }]),
    openTaskPredicate
      ? db.select({ count: count(tasks.id) }).from(tasks).where(and(openTaskPredicate, eq(tasks.status, 'in_review')))
      : Promise.resolve([{ count: 0 }]),
    openTaskPredicate
      ? db.select({ status: tasks.status, count: count(tasks.id) }).from(tasks).where(openTaskPredicate).groupBy(tasks.status)
      : Promise.resolve([]),
    openTaskPredicate
      ? db
          .select({ assignee_id: tasks.assignee_id, assignee_name: users.name, count: count(tasks.id) })
          .from(tasks)
          .leftJoin(users, eq(users.id, tasks.assignee_id))
          .where(openTaskPredicate)
          .groupBy(tasks.assignee_id, users.name)
          .orderBy(desc(sql<number>`count(${tasks.id})`))
          .limit(6)
      : Promise.resolve([]),
    openTaskPredicate
      ? db
          .select({
            id: tasks.id,
            title: tasks.title,
            status: tasks.status,
            priority: tasks.priority,
            due_date: tasks.due_date,
            number: tasks.number,
            project_id: projects.id,
            project_name: projects.name,
            project_prefix: projects.prefix,
            assignee_id: tasks.assignee_id,
            assignee_name: users.name,
          })
          .from(tasks)
          .innerJoin(projects, eq(projects.id, tasks.project_id))
          .leftJoin(users, eq(users.id, tasks.assignee_id))
          .where(openTaskPredicate)
          .orderBy(tasks.due_date, tasks.priority)
          .limit(8)
      : Promise.resolve([]),
    memberIds.length > 0
      ? db
          .select({ count: count(agentActions.id) })
          .from(agentActions)
          .where(and(eq(agentActions.org_id, orgId), eq(agentActions.approval_status, 'pending'), inArray(agentActions.user_id, memberIds)))
      : Promise.resolve([{ count: 0 }]),
  ]);

  return {
    generated_at: now.toISOString(),
    summary,
    attention: {
      overdue_tasks: overdueTaskCount[0]?.count ?? 0,
      due_soon_tasks: dueSoonTaskCount[0]?.count ?? 0,
      in_review_tasks: inReviewTaskCount[0]?.count ?? 0,
      pending_agent_actions: pendingActions[0]?.count ?? 0,
      top_tasks: attentionTasks,
    },
    workload: {
      open_tasks: openTaskCount[0]?.count ?? 0,
      by_status: Object.fromEntries(statusRows.map((row) => [row.status, row.count])),
      by_owner: ownerRows.map((row) => ({
        user_id: row.assignee_id,
        name: row.assignee_name ?? 'Unassigned',
        count: row.count,
      })),
    },
    context: {
      linked_projects: projectIds.length,
      linked_spaces: resources.filter((row) => row.resource_type === 'space').length,
      linked_wiki_pages: resources.filter((row) => row.resource_type === 'wiki_page').length,
      linked_notes: resources.filter((row) => row.resource_type === 'note').length,
      linked_calendar_feeds: resources.filter((row) => row.resource_type === 'calendar_feed').length,
      linked_agents: resources.filter((row) => row.resource_type === 'agent_employee').length,
      human_members: members.filter((row) => row.kind === 'human' && !row.agent_employee_id).length,
      agent_members: members.filter((row) => row.kind === 'agent' || row.agent_employee_id).length,
      latest_snapshot: summary.latest_snapshot,
    },
  };
}

teamRoutes.get('/', async (c) => {
  const user = c.get('user');
  const includeArchived = c.req.query('include_archived') === 'true';
  const admin = isAdminOrOwner(user);

  const conditions = [eq(teams.org_id, user.org_id)];
  if (!includeArchived) conditions.push(eq(teams.is_archived, false));

  const rows = await db
    .select({
      id: teams.id,
      org_id: teams.org_id,
      name: teams.name,
      handle: teams.handle,
      description: teams.description,
      type: teams.type,
      visibility: teams.visibility,
      avatar_url: teams.avatar_url,
      color: teams.color,
      lead_user_id: teams.lead_user_id,
      default_space_id: teams.default_space_id,
      is_archived: teams.is_archived,
      created_by: teams.created_by,
      created_at: teams.created_at,
      updated_at: teams.updated_at,
      member_count: sql<number>`(select count(*)::int from team_members where team_members.team_id = teams.id)`,
      resource_count: sql<number>`(select count(*)::int from team_resources where team_resources.team_id = teams.id)`,
      current_user_role: sql<string | null>`(
        select role::text from team_members
        where team_members.team_id = teams.id
          and team_members.user_id = ${user.id}
        limit 1
      )`,
    })
    .from(teams)
    .where(and(...conditions))
    .orderBy(teams.name);

  const visible = admin
    ? rows
    : rows.filter((row) => row.visibility === 'org' || row.lead_user_id === user.id || Boolean(row.current_user_role));

  return c.json(visible);
});

teamRoutes.post('/', async (c) => {
  const user = c.get('user');
  try {
    await requireOrgManager(user);
  } catch (err) {
    return forbidden(c, err);
  }

  const parsed = createTeamSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'Invalid team payload', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }

  const handle = normalizeHandle(parsed.data.handle ?? parsed.data.name);
  if (!HANDLE_REGEX.test(handle)) {
    return c.json({ error: 'Handle must be lowercase alphanumeric with hyphens only', code: 'VALIDATION_ERROR' }, 400);
  }

  const memberIds = Array.from(new Set([...(parsed.data.member_ids ?? []), parsed.data.lead_user_id].filter(Boolean) as string[]));
  if (!(await validateActiveOrgUsers(user.org_id, memberIds))) {
    return c.json({ error: 'Team members and leads must be active users in this organization', code: 'INVALID_MEMBERS' }, 400);
  }

  if (parsed.data.default_space_id && !(await resourceBelongsToOrg(user.org_id, 'space', parsed.data.default_space_id))) {
    return c.json({ error: 'Default space must belong to this organization', code: 'INVALID_RESOURCE' }, 400);
  }

  const [existing] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.org_id, user.org_id), eq(teams.handle, handle)))
    .limit(1);
  if (existing) return c.json({ error: 'Team handle already taken', code: 'HANDLE_TAKEN' }, 409);

  const [team] = await db
    .insert(teams)
    .values({
      org_id: user.org_id,
      name: parsed.data.name,
      handle,
      description: parsed.data.description ?? null,
      type: parsed.data.type,
      visibility: parsed.data.visibility,
      avatar_url: parsed.data.avatar_url ?? null,
      color: parsed.data.color ?? null,
      lead_user_id: parsed.data.lead_user_id ?? null,
      default_space_id: parsed.data.default_space_id ?? null,
      created_by: user.id,
    })
    .returning();

  if (team && memberIds.length > 0) {
    await db
      .insert(teamMembers)
      .values(memberIds.map((userId) => ({
        org_id: user.org_id,
        team_id: team.id,
        user_id: userId,
        role: userId === parsed.data.lead_user_id ? 'lead' as const : 'member' as const,
      })))
      .onConflictDoNothing();
  }

  return c.json(team, 201);
});

teamRoutes.get('/:id/dashboard', async (c) => {
  const user = c.get('user');
  const visible = await requireVisibleTeam(c, user, c.req.param('id'));
  if ('response' in visible) return visible.response;
  return c.json(await buildTeamDashboard(user.org_id, visible.team.id));
});

teamRoutes.get('/:id/summary', async (c) => {
  const user = c.get('user');
  const visible = await requireVisibleTeam(c, user, c.req.param('id'));
  if ('response' in visible) return visible.response;
  return c.json(await buildTeamSummary(user.org_id, visible.team.id));
});

teamRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const visible = await requireVisibleTeam(c, user, c.req.param('id'));
  if ('response' in visible) return visible.response;

  const [lead] = visible.team.lead_user_id
    ? await db.select({ id: users.id, name: users.name, email: users.email, avatar_url: users.avatar_url }).from(users).where(eq(users.id, visible.team.lead_user_id)).limit(1)
    : [null];

  const members = await db
    .select({
      id: teamMembers.id,
      user_id: teamMembers.user_id,
      role: teamMembers.role,
      joined_at: teamMembers.joined_at,
      name: users.name,
      email: users.email,
      avatar_url: users.avatar_url,
      kind: users.kind,
      agent_employee_id: agentEmployees.id,
      title: users.title,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.user_id))
    .leftJoin(agentEmployees, and(
      eq(agentEmployees.user_id, teamMembers.user_id),
      eq(agentEmployees.org_id, user.org_id),
      eq(agentEmployees.is_deleted, false),
    ))
    .where(and(eq(teamMembers.org_id, user.org_id), eq(teamMembers.team_id, visible.team.id)))
    .orderBy(teamMembers.role, users.name);

  const resources = await db
    .select()
    .from(teamResources)
    .where(and(eq(teamResources.org_id, user.org_id), eq(teamResources.team_id, visible.team.id)))
    .orderBy(teamResources.resource_type, teamResources.created_at);

  return c.json({
    team: visible.team,
    lead,
    members: members.map((member) => ({
      ...member,
      kind: member.kind === 'agent' || member.agent_employee_id ? 'agent' : member.kind,
    })),
    resources,
    summary: await buildTeamSummary(user.org_id, visible.team.id),
  });
});

teamRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const manager = await requireTeamManager(c, user, c.req.param('id'));
  if ('response' in manager) return manager.response;

  const parsed = updateTeamSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'Invalid team payload', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description ?? null;
  if (parsed.data.type !== undefined) updates.type = parsed.data.type;
  if (parsed.data.visibility !== undefined) updates.visibility = parsed.data.visibility;
  if (parsed.data.avatar_url !== undefined) updates.avatar_url = parsed.data.avatar_url ?? null;
  if (parsed.data.color !== undefined) updates.color = parsed.data.color ?? null;
  if (parsed.data.is_archived !== undefined) updates.is_archived = parsed.data.is_archived;

  if (parsed.data.handle !== undefined) {
    const handle = normalizeHandle(parsed.data.handle);
    if (!HANDLE_REGEX.test(handle)) {
      return c.json({ error: 'Handle must be lowercase alphanumeric with hyphens only', code: 'VALIDATION_ERROR' }, 400);
    }
    const [existing] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.org_id, user.org_id), eq(teams.handle, handle)))
      .limit(1);
    if (existing && existing.id !== manager.team.id) {
      return c.json({ error: 'Team handle already taken', code: 'HANDLE_TAKEN' }, 409);
    }
    updates.handle = handle;
  }

  if (parsed.data.lead_user_id !== undefined) {
    const leadId = parsed.data.lead_user_id ?? null;
    if (leadId && !(await validateActiveOrgUsers(user.org_id, [leadId]))) {
      return c.json({ error: 'Team lead must be an active user in this organization', code: 'INVALID_MEMBERS' }, 400);
    }
    updates.lead_user_id = leadId;
  }

  if (parsed.data.default_space_id !== undefined) {
    const spaceId = parsed.data.default_space_id ?? null;
    if (spaceId && !(await resourceBelongsToOrg(user.org_id, 'space', spaceId))) {
      return c.json({ error: 'Default space must belong to this organization', code: 'INVALID_RESOURCE' }, 400);
    }
    updates.default_space_id = spaceId;
  }

  const [updated] = await db
    .update(teams)
    .set(updates)
    .where(and(eq(teams.org_id, user.org_id), eq(teams.id, manager.team.id)))
    .returning();

  if (updated?.lead_user_id) {
    await db
      .insert(teamMembers)
      .values({ org_id: user.org_id, team_id: updated.id, user_id: updated.lead_user_id, role: 'lead' })
      .onConflictDoUpdate({
        target: [teamMembers.team_id, teamMembers.user_id],
        set: { role: 'lead', updated_at: new Date() },
      });
  }

  return c.json(updated);
});

teamRoutes.post('/:id/archive', async (c) => {
  const user = c.get('user');
  const manager = await requireTeamManager(c, user, c.req.param('id'));
  if ('response' in manager) return manager.response;

  const [updated] = await db
    .update(teams)
    .set({ is_archived: true, updated_at: new Date() })
    .where(and(eq(teams.org_id, user.org_id), eq(teams.id, manager.team.id)))
    .returning();
  return c.json(updated);
});

teamRoutes.post('/:id/members', async (c) => {
  const user = c.get('user');
  const manager = await requireTeamManager(c, user, c.req.param('id'));
  if ('response' in manager) return manager.response;

  const parsed = memberSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'Invalid member payload', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }
  if (!(await validateActiveOrgUsers(user.org_id, [parsed.data.user_id]))) {
    return c.json({ error: 'Team member must be an active user in this organization', code: 'INVALID_MEMBERS' }, 400);
  }

  const [member] = await db
    .insert(teamMembers)
    .values({
      org_id: user.org_id,
      team_id: manager.team.id,
      user_id: parsed.data.user_id,
      role: parsed.data.role,
    })
    .onConflictDoUpdate({
      target: [teamMembers.team_id, teamMembers.user_id],
      set: { role: parsed.data.role, updated_at: new Date() },
    })
    .returning();

  if (parsed.data.role === 'lead') {
    await db.update(teams).set({ lead_user_id: parsed.data.user_id, updated_at: new Date() }).where(eq(teams.id, manager.team.id));
  }

  return c.json(member, 201);
});

teamRoutes.patch('/:id/members/:userId', async (c) => {
  const user = c.get('user');
  const manager = await requireTeamManager(c, user, c.req.param('id'));
  if ('response' in manager) return manager.response;

  const parsed = memberRoleSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'Invalid member role payload', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }
  const userId = c.req.param('userId');
  const [updated] = await db
    .update(teamMembers)
    .set({ role: parsed.data.role, updated_at: new Date() })
    .where(and(eq(teamMembers.org_id, user.org_id), eq(teamMembers.team_id, manager.team.id), eq(teamMembers.user_id, userId)))
    .returning();
  if (!updated) return c.json({ error: 'Team member not found', code: 'NOT_FOUND' }, 404);

  if (parsed.data.role === 'lead') {
    await db.update(teams).set({ lead_user_id: userId, updated_at: new Date() }).where(eq(teams.id, manager.team.id));
  } else if (manager.team.lead_user_id === userId) {
    await db.update(teams).set({ lead_user_id: null, updated_at: new Date() }).where(eq(teams.id, manager.team.id));
  }

  return c.json(updated);
});

teamRoutes.delete('/:id/members/:userId', async (c) => {
  const user = c.get('user');
  const manager = await requireTeamManager(c, user, c.req.param('id'));
  if ('response' in manager) return manager.response;

  const userId = c.req.param('userId');
  const [deleted] = await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.org_id, user.org_id), eq(teamMembers.team_id, manager.team.id), eq(teamMembers.user_id, userId)))
    .returning({ id: teamMembers.id });
  if (!deleted) return c.json({ error: 'Team member not found', code: 'NOT_FOUND' }, 404);

  if (manager.team.lead_user_id === userId) {
    await db.update(teams).set({ lead_user_id: null, updated_at: new Date() }).where(eq(teams.id, manager.team.id));
  }

  return c.json({ success: true });
});

teamRoutes.post('/:id/resources', async (c) => {
  const user = c.get('user');
  const manager = await requireTeamManager(c, user, c.req.param('id'));
  if ('response' in manager) return manager.response;

  const parsed = resourceSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'Invalid resource payload', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }
  if (!(await resourceBelongsToOrg(user.org_id, parsed.data.resource_type, parsed.data.resource_id))) {
    return c.json({ error: 'Resource must belong to this organization', code: 'INVALID_RESOURCE' }, 400);
  }

  const [created] = await db
    .insert(teamResources)
    .values({
      org_id: user.org_id,
      team_id: manager.team.id,
      resource_type: parsed.data.resource_type,
      resource_id: parsed.data.resource_id,
      label: parsed.data.label ?? null,
      created_by: user.id,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return c.json(created, 201);

  const [existing] = await db
    .select()
    .from(teamResources)
    .where(
      and(
        eq(teamResources.org_id, user.org_id),
        eq(teamResources.team_id, manager.team.id),
        eq(teamResources.resource_type, parsed.data.resource_type),
        eq(teamResources.resource_id, parsed.data.resource_id),
      ),
    )
    .limit(1);
  return c.json(existing, 200);
});

teamRoutes.delete('/:id/resources/:resourceType/:resourceId', async (c) => {
  const user = c.get('user');
  const manager = await requireTeamManager(c, user, c.req.param('id'));
  if ('response' in manager) return manager.response;

  const resourceType = resourceTypeSchema.safeParse(c.req.param('resourceType'));
  if (!resourceType.success) return c.json({ error: 'Invalid resource type', code: 'VALIDATION_ERROR' }, 400);

  const [deleted] = await db
    .delete(teamResources)
    .where(
      and(
        eq(teamResources.org_id, user.org_id),
        eq(teamResources.team_id, manager.team.id),
        eq(teamResources.resource_type, resourceType.data),
        eq(teamResources.resource_id, c.req.param('resourceId')),
      ),
    )
    .returning({ id: teamResources.id });

  if (!deleted) return c.json({ error: 'Team resource not found', code: 'NOT_FOUND' }, 404);
  return c.json({ success: true });
});
