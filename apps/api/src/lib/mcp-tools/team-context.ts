import { and, count, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import {
  agentEmployees,
  icsSubscriptions,
  messages,
  notes,
  projects,
  spaceMembers,
  spaces,
  taskTemplates,
  tasks,
  teamMembers,
  teamResources,
  teams,
  users,
  wikiPages,
} from '@deft/db/schema';
import { db } from '../db.js';
import { visibleTaskCondition } from '../task-visibility.js';
import { visibleWikiPageCondition } from '../wiki-visibility.js';
import { errorResult, textResult, type ToolContext, type ToolResult } from './types.js';
import {
  loadEmployeeProjectAccess,
  type EmployeeProjectAccess,
} from './employee-project-access.js';

export type TeamAccessContext = {
  org_id: string;
  user_id?: string | null;
  role?: 'owner' | 'admin' | 'member' | 'guest' | null;
  can_read_tasks?: boolean;
  can_read_messages?: boolean;
  can_read_wiki?: boolean;
  employee_project_access?: EmployeeProjectAccess;
};

type TeamToolArgs = {
  caller_employee_slug?: string;
  team_id?: string;
  handle?: string;
  query?: string;
  include_archived?: boolean;
  include_tasks?: boolean;
  include_recent_messages?: boolean;
  limit?: number;
};

type TeamListRow = {
  id: string;
  name: string;
  handle: string;
  description: string | null;
  type: string;
  visibility: 'private' | 'org';
  avatar_url: string | null;
  color: string | null;
  lead_user_id: string | null;
  lead_name: string | null;
  default_space_id: string | null;
  is_archived: boolean;
  member_count: number;
  agent_count: number;
  resource_count: number;
  current_user_role: string | null;
  resources_by_type: Record<string, number>;
};

function isAdmin(access: TeamAccessContext): boolean {
  return access.role === 'owner' || access.role === 'admin';
}

function normalizeHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function canSeeTeam(access: TeamAccessContext, row: Omit<TeamListRow, 'resources_by_type'>): boolean {
  if (isAdmin(access)) return true;
  if (row.visibility === 'org') return true;
  if (access.user_id && row.lead_user_id === access.user_id) return true;
  return Boolean(row.current_user_role);
}

function clampLimit(value: unknown, fallback = 20, max = 100): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(1, Math.floor(raw)), max);
}

export async function teamAccessForEmployee(
  ctx: ToolContext,
  employeeProjectAccess?: EmployeeProjectAccess,
): Promise<TeamAccessContext> {
  const access = employeeProjectAccess ?? await loadEmployeeProjectAccess(ctx);
  return {
    org_id: ctx.org_id,
    user_id: access.userId,
    role: 'member',
    employee_project_access: access,
  };
}

function allowedProjectIds(access: TeamAccessContext, projectIds: string[]): string[] {
  const employeeAccess = access.employee_project_access;
  if (!employeeAccess) return projectIds;
  if (!employeeAccess.resolved) return [];
  if (employeeAccess.unrestricted) return projectIds;
  const allowed = new Set(employeeAccess.projectIds);
  return projectIds.filter((projectId) => allowed.has(projectId));
}

async function resourceCounts(
  access: TeamAccessContext,
  teamIds: string[],
): Promise<Map<string, Record<string, number>>> {
  const countsByTeam = new Map<string, Record<string, number>>();
  if (teamIds.length === 0) return countsByTeam;
  const employeeAccess = access.employee_project_access;
  const projectScopeCondition = !employeeAccess || (employeeAccess.resolved && employeeAccess.unrestricted)
    ? undefined
    : employeeAccess.resolved && employeeAccess.projectIds.length > 0
      ? or(
          ne(teamResources.resource_type, 'project'),
          inArray(teamResources.resource_id, employeeAccess.projectIds),
        )
      : ne(teamResources.resource_type, 'project');
  const activeProjectCondition = or(
    ne(teamResources.resource_type, 'project'),
    sql`exists (
      select 1 from ${projects}
      where ${projects.id} = ${teamResources.resource_id}
        and ${projects.org_id} = ${access.org_id}
        and ${projects.is_deleted} = false
    )`,
  );
  const rows = await db
    .select({ team_id: teamResources.team_id, type: teamResources.resource_type, count: count(teamResources.id) })
    .from(teamResources)
    .where(and(
      inArray(teamResources.team_id, teamIds),
      projectScopeCondition,
      activeProjectCondition,
    ))
    .groupBy(teamResources.team_id, teamResources.resource_type);
  for (const row of rows) {
    const existing = countsByTeam.get(row.team_id) ?? {};
    existing[row.type] = row.count;
    countsByTeam.set(row.team_id, existing);
  }
  return countsByTeam;
}

export async function listTeamSummaries(
  access: TeamAccessContext,
  args: Pick<TeamToolArgs, 'query' | 'include_archived' | 'limit'> = {},
): Promise<TeamListRow[]> {
  const limit = clampLimit(args.limit, 50, 100);
  const userId = access.user_id ?? '__no_user__';
  const conditions = [eq(teams.org_id, access.org_id)];
  if (!args.include_archived) conditions.push(eq(teams.is_archived, false));
  const query = args.query?.trim();
  if (query) {
    const like = `%${query.toLowerCase()}%`;
    conditions.push(sql<boolean>`(
      lower(${teams.name}) like ${like}
      OR lower(${teams.handle}) like ${like}
      OR lower(coalesce(${teams.description}, '')) like ${like}
    )`);
  }

  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      handle: teams.handle,
      description: teams.description,
      type: teams.type,
      visibility: teams.visibility,
      avatar_url: teams.avatar_url,
      color: teams.color,
      lead_user_id: teams.lead_user_id,
      lead_name: users.name,
      default_space_id: teams.default_space_id,
      is_archived: teams.is_archived,
      member_count: sql<number>`(select count(*)::int from team_members tm where tm.team_id = ${teams.id})`,
      agent_count: sql<number>`(
        select count(*)::int
        from team_members tm
        join users u on u.id = tm.user_id
        left join agent_employees ae
          on ae.user_id = tm.user_id
         and ae.org_id = tm.org_id
         and ae.is_deleted = false
        where tm.team_id = ${teams.id}
          and (u.kind = 'agent' or ae.id is not null)
      )`,
      resource_count: sql<number>`(select count(*)::int from team_resources tr where tr.team_id = ${teams.id})`,
      current_user_role: sql<string | null>`(
        select tm.role::text
        from team_members tm
        where tm.team_id = ${teams.id}
          and tm.user_id = ${userId}
        limit 1
      )`,
    })
    .from(teams)
    .leftJoin(users, eq(users.id, teams.lead_user_id))
    .where(and(...conditions))
    .orderBy(teams.name)
    .limit(limit * 2);

  const visible = rows.filter((row) => canSeeTeam(access, row)).slice(0, limit);
  const counts = await resourceCounts(access, visible.map((row) => row.id));
  return visible.map((row) => {
    const resourcesByType = counts.get(row.id) ?? {};
    return {
      ...row,
      resource_count: Object.values(resourcesByType).reduce((sum, value) => sum + value, 0),
      resources_by_type: resourcesByType,
    };
  });
}

async function resolveTeam(
  access: TeamAccessContext,
  args: Pick<TeamToolArgs, 'team_id' | 'handle' | 'query' | 'include_archived' | 'limit'>,
): Promise<
  | { status: 'resolved'; team: TeamListRow }
  | { status: 'ambiguous' | 'not_found'; query: string | null; candidates: TeamListRow[] }
> {
  const teamId = args.team_id?.trim();
  const handle = args.handle ? normalizeHandle(args.handle) : null;
  const query = args.query?.trim() || handle || teamId || null;
  const candidates = await listTeamSummaries(access, {
    query: handle ?? query ?? undefined,
    include_archived: args.include_archived,
    limit: args.limit ?? 10,
  });

  if (teamId) {
    const exact = candidates.find((row) => row.id === teamId)
      ?? (await listTeamSummaries(access, { include_archived: true, limit: 100 })).find((row) => row.id === teamId);
    return exact ? { status: 'resolved', team: exact } : { status: 'not_found', query: teamId, candidates: [] };
  }
  if (handle) {
    const exact = candidates.find((row) => row.handle === handle);
    return exact ? { status: 'resolved', team: exact } : { status: 'not_found', query: handle, candidates };
  }
  if (!query) {
    return { status: 'ambiguous', query: null, candidates: candidates.slice(0, 10) };
  }

  const normalized = query.toLowerCase();
  const exact = candidates.find((row) => row.handle === normalizeHandle(query) || row.name.toLowerCase() === normalized);
  if (exact) return { status: 'resolved', team: exact };
  if (candidates.length === 1) return { status: 'resolved', team: candidates[0]! };
  return candidates.length > 1
    ? { status: 'ambiguous', query, candidates }
    : { status: 'not_found', query, candidates: [] };
}

async function teamMemberRows(access: TeamAccessContext, teamId: string) {
  const rows = await db
    .select({
      user_id: teamMembers.user_id,
      role: teamMembers.role,
      joined_at: teamMembers.joined_at,
      name: users.name,
      email: users.email,
      avatar_url: users.avatar_url,
      title: users.title,
      kind: users.kind,
      agent_employee_id: agentEmployees.id,
      agent_slug: agentEmployees.slug,
      agent_runtime_kind: agentEmployees.runtime_kind,
      agent_trust_level: agentEmployees.trust_level,
      agent_active: agentEmployees.is_active,
      agent_unhealthy: agentEmployees.unhealthy,
      agent_last_mcp_call_at: agentEmployees.last_mcp_call_at,
      agent_last_heartbeat_at: agentEmployees.last_heartbeat_at,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.user_id))
    .leftJoin(agentEmployees, and(
      eq(agentEmployees.user_id, teamMembers.user_id),
      eq(agentEmployees.org_id, access.org_id),
      eq(agentEmployees.is_deleted, false),
    ))
    .where(and(eq(teamMembers.org_id, access.org_id), eq(teamMembers.team_id, teamId)))
    .orderBy(teamMembers.role, users.name);
  return rows.map((row) => ({
    user_id: row.user_id,
    role: row.role,
    joined_at: row.joined_at,
    name: row.name,
    email: row.email,
    avatar_url: row.avatar_url,
    title: row.title,
    kind: row.kind === 'agent' || row.agent_employee_id ? 'agent' : row.kind,
    agent: row.agent_employee_id
      ? {
          id: row.agent_employee_id,
          slug: row.agent_slug,
          runtime_kind: row.agent_runtime_kind,
          trust_level: row.agent_trust_level,
          is_active: row.agent_active,
          unhealthy: row.agent_unhealthy,
          last_mcp_call_at: row.agent_last_mcp_call_at,
          last_heartbeat_at: row.agent_last_heartbeat_at,
        }
      : null,
  }));
}

async function enrichResources(access: TeamAccessContext, teamId: string) {
  const linkedResources = await db
    .select()
    .from(teamResources)
    .where(and(eq(teamResources.org_id, access.org_id), eq(teamResources.team_id, teamId)))
    .orderBy(teamResources.resource_type, teamResources.created_at);

  const linkedProjectIds = linkedResources
    .filter((row) => row.resource_type === 'project')
    .map((row) => row.resource_id);
  const scopedProjectIds = allowedProjectIds(access, linkedProjectIds);
  const activeProjectRows = scopedProjectIds.length > 0
    ? await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(
        eq(projects.org_id, access.org_id),
        inArray(projects.id, scopedProjectIds),
        eq(projects.is_deleted, false),
      ))
    : [];
  const visibleProjectIds = new Set(activeProjectRows.map((project) => project.id));
  const resources = linkedResources.filter(
    (row) => row.resource_type !== 'project' || visibleProjectIds.has(row.resource_id),
  );

  const idsByType = new Map<string, string[]>();
  for (const row of resources) {
    idsByType.set(row.resource_type, [...(idsByType.get(row.resource_type) ?? []), row.resource_id]);
  }

  const metadata = new Map<string, Record<string, unknown>>();
  const put = (type: string, id: string, value: Record<string, unknown>) => metadata.set(`${type}:${id}`, value);

  const spaceIds = idsByType.get('space') ?? [];
  if (spaceIds.length) {
    const rows = await db.select({
      id: spaces.id,
      name: spaces.name,
      description: spaces.description,
      topic: spaces.topic,
      type: spaces.type,
      is_archived: spaces.is_archived,
      membership_id: spaceMembers.id,
    })
      .from(spaces)
      .leftJoin(
        spaceMembers,
        and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, access.user_id ?? '__no_user__')),
      )
      .where(and(eq(spaces.org_id, access.org_id), inArray(spaces.id, spaceIds)));
    rows.forEach((row) => {
      const canRead = row.type === 'public' || Boolean(row.membership_id);
      if (canRead) {
        put('space', row.id, {
          id: row.id,
          name: row.name,
          description: row.description,
          topic: row.topic,
          type: row.type,
          is_archived: row.is_archived,
          access: 'visible',
        });
        return;
      }
      put('space', row.id, {
        id: row.id,
        type: row.type,
        is_archived: row.is_archived,
        access: 'restricted',
        restricted_reason: 'space_membership_required',
      });
    });
  }

  const projectIds = idsByType.get('project') ?? [];
  if (projectIds.length) {
    const rows = await db.select({
      id: projects.id,
      name: projects.name,
      prefix: projects.prefix,
      description: projects.description,
      is_archived: projects.is_archived,
      is_deleted: projects.is_deleted,
    }).from(projects).where(and(eq(projects.org_id, access.org_id), inArray(projects.id, projectIds), eq(projects.is_deleted, false)));
    rows.forEach((row) => put('project', row.id, row));
  }

  const wikiIds = access.can_read_wiki === false ? [] : idsByType.get('wiki_page') ?? [];
  if (wikiIds.length) {
    const visibility = access.user_id ? visibleWikiPageCondition(access.user_id) : sql<boolean>`true`;
    const rows = await db.select({
      id: wikiPages.id,
      title: wikiPages.title,
      slug: wikiPages.slug,
      summary: wikiPages.summary,
      type: wikiPages.type,
      scope: wikiPages.scope,
      confidence: wikiPages.confidence,
      updated_at: wikiPages.updated_at,
    }).from(wikiPages).where(and(eq(wikiPages.org_id, access.org_id), inArray(wikiPages.id, wikiIds), eq(wikiPages.is_deleted, false), visibility));
    rows.forEach((row) => put('wiki_page', row.id, row));
  }

  const noteIds = idsByType.get('note') ?? [];
  if (noteIds.length) {
    const rows = await db.select({
      id: notes.id,
      title: notes.title,
      icon: notes.icon,
      visibility: notes.visibility,
      is_pinned: notes.is_pinned,
      updated_at: notes.updated_at,
    }).from(notes).where(and(eq(notes.org_id, access.org_id), inArray(notes.id, noteIds), eq(notes.is_deleted, false)));
    rows.forEach((row) => put('note', row.id, row));
  }

  const feedIds = idsByType.get('calendar_feed') ?? [];
  if (feedIds.length) {
    const rows = await db.select({
      id: icsSubscriptions.id,
      label: icsSubscriptions.label,
      is_active: icsSubscriptions.is_active,
      sync_interval_min: icsSubscriptions.sync_interval_min,
      last_synced_at: icsSubscriptions.last_synced_at,
      last_error: icsSubscriptions.last_error,
      last_event_count: icsSubscriptions.last_event_count,
    }).from(icsSubscriptions).where(and(eq(icsSubscriptions.org_id, access.org_id), inArray(icsSubscriptions.id, feedIds)));
    rows.forEach((row) => put('calendar_feed', row.id, row));
  }

  const templateIds = idsByType.get('task_template') ?? [];
  if (templateIds.length) {
    const rows = await db.select({
      id: taskTemplates.id,
      name: taskTemplates.name,
      slug: taskTemplates.slug,
      description: taskTemplates.description,
      source: taskTemplates.source,
      icon: taskTemplates.icon,
    }).from(taskTemplates).where(and(inArray(taskTemplates.id, templateIds), eq(taskTemplates.is_deleted, false)));
    rows.forEach((row) => put('task_template', row.id, row));
  }

  const agentIds = idsByType.get('agent_employee') ?? [];
  if (agentIds.length) {
    const rows = await db.select({
      id: agentEmployees.id,
      name: agentEmployees.name,
      slug: agentEmployees.slug,
      role: agentEmployees.role,
      job_title: agentEmployees.job_title,
      runtime_kind: agentEmployees.runtime_kind,
      trust_level: agentEmployees.trust_level,
      is_active: agentEmployees.is_active,
      unhealthy: agentEmployees.unhealthy,
      last_mcp_call_at: agentEmployees.last_mcp_call_at,
      last_heartbeat_at: agentEmployees.last_heartbeat_at,
    }).from(agentEmployees).where(and(eq(agentEmployees.org_id, access.org_id), inArray(agentEmployees.id, agentIds), eq(agentEmployees.is_deleted, false)));
    rows.forEach((row) => put('agent_employee', row.id, row));
  }

  return resources.map((row) => {
    const rowMetadata = metadata.get(`${row.resource_type}:${row.resource_id}`) ?? null;
    const restricted = row.resource_type === 'space' && rowMetadata?.access === 'restricted';
    return {
      id: row.id,
      type: row.resource_type,
      resource_id: row.resource_id,
      label: restricted ? null : row.label,
      access: restricted ? 'restricted' : 'visible',
      restricted_reason: restricted ? 'space_membership_required' : null,
      created_at: row.created_at,
      metadata: rowMetadata,
    };
  });
}

async function allowedSpaceIds(access: TeamAccessContext, spaceIds: string[]): Promise<string[]> {
  if (spaceIds.length === 0) return [];
  const rows = await db
    .select({ id: spaces.id })
    .from(spaces)
    .leftJoin(spaceMembers, and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, access.user_id ?? '__no_user__')))
    .where(and(
      eq(spaces.org_id, access.org_id),
      inArray(spaces.id, spaceIds),
      eq(spaces.is_archived, false),
      or(eq(spaces.type, 'public'), sql`${spaceMembers.id} is not null`),
    ));
  return rows.map((row) => row.id);
}

async function buildTeamWorkContext(access: TeamAccessContext, resources: Array<{ type: string; resource_id: string }>, limit: number) {
  const projectIds = allowedProjectIds(
    access,
    resources.filter((row) => row.type === 'project').map((row) => row.resource_id),
  );
  const rawSpaceIds = resources.filter((row) => row.type === 'space').map((row) => row.resource_id);
  const spaceIds = access.can_read_messages === false ? [] : await allowedSpaceIds(access, rawSpaceIds);
  const taskVisibility = access.user_id ? visibleTaskCondition(access.user_id) : sql<boolean>`true`;

  const taskPredicate = access.can_read_tasks !== false && projectIds.length > 0
    ? and(
        eq(tasks.org_id, access.org_id),
        eq(tasks.is_deleted, false),
        eq(projects.is_deleted, false),
        inArray(tasks.project_id, projectIds),
        sql`${tasks.status} not in ('done', 'cancelled')`,
        taskVisibility,
      )
    : null;

  const [openRows, statusRows, ownerRows, topTasks, recentMessages] = await Promise.all([
    taskPredicate
      ? db.select({ count: count(tasks.id) }).from(tasks).innerJoin(projects, eq(projects.id, tasks.project_id)).where(taskPredicate)
      : Promise.resolve([{ count: 0 }]),
    taskPredicate
      ? db.select({ status: tasks.status, count: count(tasks.id) }).from(tasks).innerJoin(projects, eq(projects.id, tasks.project_id)).where(taskPredicate).groupBy(tasks.status)
      : Promise.resolve([]),
    taskPredicate
      ? db
          .select({ assignee_id: tasks.assignee_id, assignee_name: users.name, count: count(tasks.id) })
          .from(tasks)
          .innerJoin(projects, eq(projects.id, tasks.project_id))
          .leftJoin(users, eq(users.id, tasks.assignee_id))
          .where(taskPredicate)
          .groupBy(tasks.assignee_id, users.name)
          .orderBy(desc(sql<number>`count(${tasks.id})`))
          .limit(8)
      : Promise.resolve([]),
    taskPredicate
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
          .where(taskPredicate)
          .orderBy(tasks.due_date, desc(tasks.updated_at))
          .limit(limit)
      : Promise.resolve([]),
    spaceIds.length > 0
      ? db
          .select({
            id: messages.id,
            space_id: messages.space_id,
            space_name: spaces.name,
            author_id: messages.user_id,
            author_name: users.name,
            content: messages.content,
            created_at: messages.created_at,
          })
          .from(messages)
          .innerJoin(spaces, eq(spaces.id, messages.space_id))
          .innerJoin(users, eq(users.id, messages.user_id))
          .where(and(eq(messages.org_id, access.org_id), inArray(messages.space_id, spaceIds), eq(messages.is_deleted, false)))
          .orderBy(desc(messages.created_at))
          .limit(Math.min(limit, 20))
      : Promise.resolve([]),
  ]);

  return {
    tasks: {
      linked_project_count: projectIds.length,
      open_count: openRows[0]?.count ?? 0,
      by_status: Object.fromEntries(statusRows.map((row) => [row.status, row.count])),
      by_owner: ownerRows.map((row) => ({
        user_id: row.assignee_id,
        name: row.assignee_name ?? 'Unassigned',
        count: row.count,
      })),
      top_open: topTasks.map((task) => ({
        ...task,
        key: task.project_prefix && task.number ? `${task.project_prefix}-${task.number}` : null,
      })),
    },
    recent_messages: recentMessages.map((message) => ({
      id: message.id,
      space_id: message.space_id,
      space_name: message.space_name,
      author_id: message.author_id,
      author_name: message.author_name,
      preview: message.content.length > 360 ? `${message.content.slice(0, 357)}...` : message.content,
      created_at: message.created_at,
    })),
  };
}

export async function getTeamProfile(access: TeamAccessContext, args: TeamToolArgs) {
  const resolution = await resolveTeam(access, args);
  if (resolution.status !== 'resolved') return resolution;
  const [members, resources] = await Promise.all([
    teamMemberRows(access, resolution.team.id),
    enrichResources(access, resolution.team.id),
  ]);
  return {
    status: 'resolved' as const,
    team: resolution.team,
    members,
    resources,
    context_hints: [
      {
        intent: 'understand current team work and attached knowledge',
        tool: 'team_context',
        arguments: { team_id: resolution.team.id },
      },
      {
        intent: 'post an update to the default or linked team space',
        tool: 'send_message',
        arguments_template: { space_id: resolution.team.default_space_id ?? '<linked-space-id>', content: '<message>' },
      },
    ],
  };
}

export async function getTeamContext(access: TeamAccessContext, args: TeamToolArgs) {
  const profile = await getTeamProfile(access, args);
  if (profile.status !== 'resolved') return profile;
  const limit = clampLimit(args.limit, 12, 50);
  const work = await buildTeamWorkContext(access, profile.resources, limit);
  return {
    ...profile,
    work,
    recommended_tool_paths: [
      {
        intent: 'answer a team-specific question',
        first_tool: 'team_context',
        next_tool: 'memory_recall',
        why: 'team_context gives linked spaces/projects/wiki; memory_recall can then search the right channel or org knowledge',
      },
      {
        intent: 'create team follow-up work',
        first_tool: 'team_context',
        next_tool: 'task_create',
        why: 'team_context exposes linked projects and members so task_create can use ids instead of guessing',
      },
    ],
  };
}

export async function teamList(args: TeamToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const access = await teamAccessForEmployee(ctx);
  if (!access.employee_project_access?.resolved) {
    return errorResult('team_list: caller employee not found');
  }
  const rows = await listTeamSummaries(access, args);
  return textResult({ teams: rows, count: rows.length });
}

export async function teamGet(args: TeamToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const access = await teamAccessForEmployee(ctx);
  if (!access.employee_project_access?.resolved) {
    return errorResult('team_get: caller employee not found');
  }
  return textResult(await getTeamProfile(access, args));
}

export async function teamContext(args: TeamToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const access = await teamAccessForEmployee(ctx);
  if (!access.employee_project_access?.resolved) {
    return errorResult('team_context: caller employee not found');
  }
  const result = await getTeamContext(access, args);
  if (result.status === 'not_found') return errorResult(`team_context: team not found for ${result.query ?? 'empty query'}`);
  return textResult(result);
}
