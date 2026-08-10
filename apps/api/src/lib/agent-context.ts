import { db } from './db.js';
import {
  messages,
  users,
  tasks,
  taskAssignees,
  projects,
  taskComments,
  taskActivity,
  taskRelationships,
  spaces,
  spaceMembers,
  orgMembers,
  events,
  agentMemory,

  peopleExpertise,
  peopleInteractions,
  peoplePatterns,
  peopleRelationships,
  burnoutAlerts,
  wikiPages,
  wikiLinks,
  wikiCitations,
  wikiOpsLog,
  agentEmployees,
  agentActions,
} from '@deft/db/schema';
import { getExecutableMcpConnection, mcpResultPayload, parseMCPToolName, toConnectionConfig } from './mcp-tools.js';
import { mcpClientManager } from '@deft/mcp';
import { eq, and, ilike, desc, sql, lt, gte, inArray, or } from 'drizzle-orm';
import { retrieveContext } from './retrieve-context.js';
import { isManager } from '../middleware/privacy-guard.js';
import { velocityCalculator, workloadAnalyzer, skillsGapAnalyzer } from '../services/team-analytics.js';
import { generateOneOnePrep } from '../services/oneone-prep.js';
import { createPlanRow } from './agent-plans.js';
import { resolveAssignee } from './resolve-assignee.js';
import { visibleTaskCondition } from './task-visibility.js';
import { agentToolPolicyError } from './agent-tool-policy.js';

type Citation = { type: string; id: string; title: string };

export async function executeToolCall(
  toolName: string,
  params: Record<string, any>,
  orgId: string,
  _userId: string,
  conversationId?: string,
  agentEmployeeId?: string,
): Promise<{ result: any; citations: Citation[] }> {
  const policyError = await agentToolPolicyError(orgId, agentEmployeeId, toolName);
  if (policyError) return { result: { error: policyError }, citations: [] };

  // Check daily action limit for agent employees
  if (agentEmployeeId) {
    const [emp] = await db.select().from(agentEmployees)
      .where(and(
        eq(agentEmployees.id, agentEmployeeId),
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);
    if (emp && emp.daily_action_count >= emp.max_daily_actions) {
      return {
        result: { error: `Daily action limit reached (${emp.daily_action_count}/${emp.max_daily_actions}). Please ask an admin to increase the limit or wait until tomorrow.` },
        citations: [],
      };
    }
  }

  const citations: Citation[] = [];

  // Route MCP tool calls to the MCP client manager
  if (toolName.startsWith('mcp__')) {
    const { connectionSlug, toolName: actualToolName } = parseMCPToolName(toolName);
    const resolved = await getExecutableMcpConnection(orgId, connectionSlug, actualToolName, agentEmployeeId);
    if (!resolved.connection) return { result: { error: resolved.error }, citations: [] };

    const config = toConnectionConfig(resolved.connection);
    const mcpResult = await mcpClientManager.executeTool(config, actualToolName, params);

    return {
      result: mcpResultPayload(mcpResult),
      citations: [{ type: 'mcp', id: resolved.connection.id, title: `${resolved.connection.name}: ${actualToolName}` }],
    };
  }

  switch (toolName) {
    case 'search_messages': {
      const limit = params.limit || 10;
      const conditions: any[] = [
        eq(messages.org_id, orgId),
        eq(messages.is_deleted, false),
        ilike(messages.content, `%${params.query}%`),
        or(
          eq(spaces.type, 'public'),
          sql`${spaceMembers.id} IS NOT NULL`,
        ),
      ];

      // Filter by space name
      if (params.space_name) {
        const [space] = await db
          .select({ id: spaces.id })
          .from(spaces)
          .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, params.space_name)))
          .limit(1);
        if (!space) return { result: [], citations: [] };
        conditions.push(eq(messages.space_id, space.id));
      }

      // Filter by author name
      if (params.author_name) {
        const [author] = await db
          .select({ id: users.id })
          .from(users)
          .innerJoin(orgMembers, eq(users.id, orgMembers.user_id))
          .where(
            and(eq(orgMembers.org_id, orgId), ilike(users.name, `%${params.author_name}%`)),
          )
          .limit(1);
        if (!author) return { result: [], citations: [] };
        conditions.push(eq(messages.user_id, author.id));
      }

      const results = await db
        .select({
          id: messages.id,
          content: messages.content,
          user_name: users.name,
          space_id: messages.space_id,
          created_at: messages.created_at,
        })
        .from(messages)
        .innerJoin(users, eq(messages.user_id, users.id))
        .innerJoin(
          spaces,
          and(eq(spaces.id, messages.space_id), eq(spaces.org_id, orgId)),
        )
        .leftJoin(
          spaceMembers,
          and(
            eq(spaceMembers.space_id, spaces.id),
            eq(spaceMembers.user_id, _userId),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(messages.created_at))
        .limit(limit);

      // Resolve space names
      const spaceIds = [...new Set(results.map((r) => r.space_id))];
      const spaceMap = new Map<string, string>();
      if (spaceIds.length > 0) {
        const spaceRows = await db
          .select({ id: spaces.id, name: spaces.name })
          .from(spaces)
          .where(inArray(spaces.id, spaceIds));
        spaceRows.forEach((s) => spaceMap.set(s.id, s.name));
      }

      const formatted = results.map((r) => ({
        ...r,
        space_name: spaceMap.get(r.space_id) || 'unknown',
      }));

      formatted.forEach((m) => {
        citations.push({
          type: 'message',
          id: m.id,
          title: `#${m.space_name} - ${m.user_name}`,
        });
      });

      return { result: formatted, citations };
    }

    case 'search_tasks': {
      // Task 3.8 — consult retrieveContext for fuzzy/semantic hits first, then
      // merge with SQL-filtered (status/priority/assignee/etc.) results by id.
      // Semantic pass only runs when a query string is provided; structural-only
      // filters fall straight through to the SQL path below.
      const semanticIds: string[] = [];
      if (typeof params.query === 'string' && params.query.trim().length >= 2) {
        try {
          const ctx = await retrieveContext({
            query: params.query,
            org_id: orgId,
            user_id: _userId,
            conversation_id: conversationId,
            agent_employee_id: agentEmployeeId,
            types: ['tasks'],
            limit: 10,
          });
          for (const row of ctx) {
            if (row.source_type === 'task') semanticIds.push(row.source_id);
          }
        } catch (err) {
          // Non-fatal: semantic search is a best-effort enhancement.
          console.warn('[search_tasks] retrieveContext failed, falling back to SQL-only:', (err as Error).message);
        }
      }

      const conditions: any[] = [
        eq(tasks.org_id, orgId),
        eq(tasks.is_deleted, false),
        visibleTaskCondition(_userId),
      ];

      if (params.query) {
        // Union: literal-title ILIKE OR semantic id match. When semantic had no
        // hits this collapses to the old behaviour (title ILIKE only).
        if (semanticIds.length) {
          conditions.push(
            or(
              ilike(tasks.title, `%${params.query}%`),
              inArray(tasks.id, semanticIds),
            ),
          );
        } else {
          conditions.push(ilike(tasks.title, `%${params.query}%`));
        }
      }
      if (params.status) {
        conditions.push(eq(tasks.status, params.status));
      }
      if (params.priority) {
        conditions.push(eq(tasks.priority, params.priority));
      }
      if (params.overdue) {
        conditions.push(lt(tasks.due_date, new Date()));
        conditions.push(sql`${tasks.status} NOT IN ('done', 'cancelled')`);
      }
      if (params.assignee_name) {
        const resolved = await resolveAssignee(params.assignee_name, orgId);
        if (resolved) conditions.push(eq(tasks.assignee_id, resolved.id));
      }
      if (params.project_name) {
        const [proj] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(eq(projects.org_id, orgId), ilike(projects.name, `%${params.project_name}%`)),
          )
          .limit(1);
        if (proj) conditions.push(eq(tasks.project_id, proj.id));
      }

      const results = await db
        .select({
          id: tasks.id,
          number: tasks.number,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          due_date: tasks.due_date,
          assignee_name: users.name,
          project_name: projects.name,
          project_prefix: projects.prefix,
        })
        .from(tasks)
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .leftJoin(users, eq(tasks.assignee_id, users.id))
        .where(and(...conditions))
        .orderBy(desc(tasks.updated_at))
        .limit(20);

      results.forEach((t) => {
        citations.push({
          type: 'task',
          id: t.id,
          title: `${t.project_prefix}-${t.number}: ${t.title}`,
        });
      });

      return { result: results, citations };
    }

    case 'list_my_tasks': {
      // Task 3.7 — caller-scoped task list. Matches search_tasks shape but
      // fixes assignee to ctx.userId and pulls in additional assignees
      // via task_assignees so tasks that are only shared (not primary)
      // still surface.
      const statusFilter = typeof params.status === 'string' ? params.status : null;
      const conditions: any[] = [
        eq(tasks.org_id, orgId),
        eq(tasks.is_deleted, false),
        or(
          eq(tasks.assignee_id, _userId),
          sql`EXISTS (SELECT 1 FROM ${taskAssignees} WHERE ${taskAssignees.task_id} = ${tasks.id} AND ${taskAssignees.user_id} = ${_userId})`,
        ),
      ];
      if (statusFilter) {
        conditions.push(eq(tasks.status, statusFilter as any));
      } else {
        // Default: exclude done + cancelled.
        conditions.push(sql`${tasks.status} NOT IN ('done', 'cancelled')`);
      }

      const myResults = await db
        .select({
          id: tasks.id,
          number: tasks.number,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          due_date: tasks.due_date,
          assignee_name: users.name,
          project_name: projects.name,
          project_prefix: projects.prefix,
        })
        .from(tasks)
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .leftJoin(users, eq(tasks.assignee_id, users.id))
        .where(and(...conditions))
        .orderBy(desc(tasks.updated_at))
        .limit(50);

      myResults.forEach((t) => {
        citations.push({
          type: 'task',
          id: t.id,
          title: `${t.project_prefix}-${t.number}: ${t.title}`,
        });
      });

      return { result: myResults, citations };
    }

    case 'get_task_detail': {
      let taskId = params.task_identifier as string;
      const match = taskId.match(/^([A-Z]+)-(\d+)$/);

      if (match) {
        const [proj] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.org_id, orgId), eq(projects.prefix, match[1]!)))
          .limit(1);
        if (proj) {
          const [found] = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.project_id, proj.id), eq(tasks.number, parseInt(match[2]!))))
            .limit(1);
          if (found) taskId = found.id;
        }
      }

      const [task] = await db
        .select({
          id: tasks.id,
          number: tasks.number,
          title: tasks.title,
          description: tasks.description,
          status: tasks.status,
          priority: tasks.priority,
          due_date: tasks.due_date,
          created_at: tasks.created_at,
          assignee_name: users.name,
          project_name: projects.name,
          project_prefix: projects.prefix,
        })
        .from(tasks)
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .leftJoin(users, eq(tasks.assignee_id, users.id))
        .where(and(eq(tasks.id, taskId), eq(tasks.org_id, orgId), visibleTaskCondition(_userId)))
        .limit(1);

      if (!task) return { result: { error: 'Task not found' }, citations: [] };

      // Recent comments
      const comments = await db
        .select({
          content: taskComments.content,
          user_name: users.name,
          created_at: taskComments.created_at,
        })
        .from(taskComments)
        .innerJoin(users, eq(taskComments.user_id, users.id))
        .where(eq(taskComments.task_id, taskId))
        .orderBy(desc(taskComments.created_at))
        .limit(5);

      // Recent activity
      const activity = await db
        .select({
          action: taskActivity.action,
          field: taskActivity.field,
          old_value: taskActivity.old_value,
          new_value: taskActivity.new_value,
          created_at: taskActivity.created_at,
        })
        .from(taskActivity)
        .where(eq(taskActivity.task_id, taskId))
        .orderBy(desc(taskActivity.created_at))
        .limit(5);

      citations.push({
        type: 'task',
        id: task.id,
        title: `${task.project_prefix}-${task.number}: ${task.title}`,
      });

      return { result: { ...task, comments, activity }, citations };
    }

    case 'check_calendar': {
      const dateStr = params.date || new Date().toISOString().split('T')[0];
      const dayStart = new Date(dateStr + 'T00:00:00');
      const dayEnd = new Date(dateStr + 'T23:59:59');

      const conditions: any[] = [
        inArray(events.source, ['google_calendar', 'ics', 'native']),
        eq(events.event_type, 'calendar_event'),
        gte(events.timestamp, dayStart),
        lt(events.timestamp, dayEnd),
        eq(events.org_id, orgId),
      ];

      if (params.query) {
        conditions.push(ilike(events.title, `%${params.query}%`));
      }

      const results = await db.select({
        title: events.title, url: events.url, timestamp: events.timestamp, source: events.source, metadata: events.metadata,
      }).from(events).where(and(...conditions)).orderBy(events.timestamp).limit(20);

      results.forEach(e => citations.push({ type: 'event', id: e.url || '', title: e.title || 'Calendar event' }));
      return { result: results, citations };
    }

    case 'check_github_prs': {
      const conditions: any[] = [eq(events.source, 'github'), eq(events.org_id, orgId)];
      if (params.state === 'open') conditions.push(eq(events.event_type, 'pr_opened'));
      if (params.state === 'merged') conditions.push(eq(events.event_type, 'pr_merged'));
      if (params.state === 'closed') conditions.push(eq(events.event_type, 'pr_closed'));
      if (params.repo) conditions.push(ilike(sql`${events.metadata}->>'repo'`, `%${params.repo}%`));

      const results = await db.select({
        title: events.title, url: events.url, actor: events.actor,
        event_type: events.event_type, timestamp: events.timestamp, metadata: events.metadata,
      }).from(events).where(and(...conditions)).orderBy(desc(events.timestamp)).limit(20);

      results.forEach(e => citations.push({ type: 'github', id: e.url || '', title: e.title || 'GitHub activity' }));
      return { result: results, citations };
    }

    case 'get_workspace_stats': {
      const timeRange = params.time_range as string;
      const metric = (params.metric as string) || 'all';
      const daysMap: Record<string, number> = { '7d': 7, '14d': 14, '30d': 30, '90d': 90 };
      const days = daysMap[timeRange] || 30;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const stats: Record<string, any> = { time_range: timeRange };

      if (metric === 'tasks_completed' || metric === 'all') {
        const [row] = await db
          .select({ count: sql<number>`count(*)` })
          .from(tasks)
          .where(
            and(
              eq(tasks.org_id, orgId),
              eq(tasks.is_deleted, false),
              eq(tasks.status, 'done'),
              gte(tasks.updated_at, since),
            ),
          );
        stats.tasks_completed = Number(row?.count ?? 0);
      }

      if (metric === 'tasks_created' || metric === 'all') {
        const [row] = await db
          .select({ count: sql<number>`count(*)` })
          .from(tasks)
          .where(
            and(
              eq(tasks.org_id, orgId),
              eq(tasks.is_deleted, false),
              gte(tasks.created_at, since),
            ),
          );
        stats.tasks_created = Number(row?.count ?? 0);
      }

      if (metric === 'messages_sent' || metric === 'all') {
        const [row] = await db
          .select({ count: sql<number>`count(*)` })
          .from(messages)
          .where(
            and(
              eq(messages.org_id, orgId),
              eq(messages.is_deleted, false),
              gte(messages.created_at, since),
            ),
          );
        stats.messages_sent = Number(row?.count ?? 0);
      }

      if (metric === 'active_users' || metric === 'all') {
        const [row] = await db
          .select({ count: sql<number>`count(distinct ${messages.user_id})` })
          .from(messages)
          .where(
            and(
              eq(messages.org_id, orgId),
              eq(messages.is_deleted, false),
              gte(messages.created_at, since),
            ),
          );
        stats.active_users = Number(row?.count ?? 0);
      }

      if (metric === 'all') {
        const tasksByStatus = await db
          .select({
            status: tasks.status,
            count: sql<number>`count(*)`,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.org_id, orgId),
              eq(tasks.is_deleted, false),
              gte(tasks.created_at, since),
            ),
          )
          .groupBy(tasks.status);

        stats.tasks_by_status = Object.fromEntries(
          tasksByStatus.map((r) => [r.status, Number(r.count)]),
        );
      }

      return { result: stats, citations };
    }

    case 'get_team_workload': {
      const conditions: any[] = [eq(tasks.org_id, orgId), eq(tasks.is_deleted, false)];

      if (params.project_name) {
        const [proj] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(eq(projects.org_id, orgId), ilike(projects.name, `%${params.project_name}%`)),
          )
          .limit(1);
        if (proj) conditions.push(eq(tasks.project_id, proj.id));
      }

      // Only include tasks that have an assignee
      conditions.push(sql`${tasks.assignee_id} IS NOT NULL`);

      const rows = await db
        .select({
          assignee_id: tasks.assignee_id,
          user_name: users.name,
          status: tasks.status,
          count: sql<number>`count(*)`,
        })
        .from(tasks)
        .innerJoin(users, eq(tasks.assignee_id, users.id))
        .where(and(...conditions))
        .groupBy(tasks.assignee_id, users.name, tasks.status);

      // Aggregate by user into flat { user_name, todo, in_progress, in_review, done, total }
      const workloadMap = new Map<
        string,
        { user_name: string; todo: number; in_progress: number; in_review: number; done: number; total: number }
      >();

      for (const row of rows) {
        const key = row.assignee_id!;
        if (!workloadMap.has(key)) {
          workloadMap.set(key, {
            user_name: row.user_name,
            todo: 0,
            in_progress: 0,
            in_review: 0,
            done: 0,
            total: 0,
          });
        }
        const entry = workloadMap.get(key)!;
        const cnt = Number(row.count);
        entry.total += cnt;
        if (row.status === 'todo' || row.status === 'backlog') entry.todo += cnt;
        else if (row.status === 'in_progress') entry.in_progress += cnt;
        else if (row.status === 'in_review') entry.in_review += cnt;
        else if (row.status === 'done') entry.done += cnt;
      }

      const result = [...workloadMap.values()].sort((a, b) => b.total - a.total);
      return { result, citations };
    }

    case 'list_projects': {
      const includeArchived = params.include_archived === true;
      const conditions = [eq(projects.org_id, orgId)];
      if (!includeArchived) {
        conditions.push(eq(projects.is_archived, false));
        conditions.push(eq(projects.is_deleted, false));
      }
      const rows = await db
        .select({
          id: projects.id,
          name: projects.name,
          prefix: projects.prefix,
          is_archived: projects.is_archived,
        })
        .from(projects)
        .where(and(...conditions))
        .orderBy(projects.name);
      return { result: rows, citations: [] };
    }

    case 'get_project_progress': {
      const [project] = await db
        .select({ id: projects.id, name: projects.name, prefix: projects.prefix })
        .from(projects)
        .where(
          and(
            eq(projects.org_id, orgId),
            ilike(projects.name, `%${params.project_name}%`),
          ),
        )
        .limit(1);

      if (!project) {
        return { result: { error: `Project "${params.project_name}" not found` }, citations: [] };
      }

      const tasksByStatus = await db
        .select({
          status: tasks.status,
          count: sql<number>`count(*)`,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.org_id, orgId),
            eq(tasks.project_id, project.id),
            eq(tasks.is_deleted, false),
          ),
        )
        .groupBy(tasks.status);

      const byStatus = Object.fromEntries(
        tasksByStatus.map((r) => [r.status, Number(r.count)]),
      );
      const totalTasks = Object.values(byStatus).reduce((sum, c) => sum + c, 0);
      const doneTasks = byStatus['done'] || 0;
      const completionPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

      // Count overdue tasks
      const [overdueRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.org_id, orgId),
            eq(tasks.project_id, project.id),
            eq(tasks.is_deleted, false),
            sql`${tasks.due_date} < now()`,
            sql`${tasks.status} NOT IN ('done', 'cancelled')`,
          ),
        );
      const overdueCount = Number(overdueRow?.count ?? 0);

      // Recent activity for this project's tasks
      const recentActivity = await db
        .select({
          action: taskActivity.action,
          field: taskActivity.field,
          old_value: taskActivity.old_value,
          new_value: taskActivity.new_value,
          task_title: tasks.title,
          task_number: tasks.number,
          created_at: taskActivity.created_at,
        })
        .from(taskActivity)
        .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
        .where(
          and(
            eq(tasks.project_id, project.id),
            eq(tasks.org_id, orgId),
          ),
        )
        .orderBy(desc(taskActivity.created_at))
        .limit(5);

      citations.push({
        type: 'project',
        id: project.id,
        title: project.name,
      });

      return {
        result: {
          project_name: project.name,
          total_tasks: totalTasks,
          completed: doneTasks,
          in_progress: byStatus['in_progress'] || 0,
          completion_pct: completionPct,
          overdue_count: overdueCount,
          by_status: byStatus,
          recent_activity: recentActivity.map((a) => ({
            task: `${project.prefix}-${a.task_number}: ${a.task_title}`,
            action: a.action,
            field: a.field,
            old_value: a.old_value,
            new_value: a.new_value,
            at: a.created_at,
          })),
        },
        citations,
      };
    }

    case 'remember': {
      const { key, value, scope } = params;
      if (!key || !value || !scope) {
        return { result: { error: 'key, value, and scope are required' }, citations: [] };
      }

      const convId = scope === 'conversation' ? conversationId || null : null;

      // Upsert: use ON CONFLICT on the unique index (user_id, conversation_id, key)
      await db
        .insert(agentMemory)
        .values({
          org_id: orgId,
          user_id: _userId,
          conversation_id: convId,
          scope,
          key,
          value,
        })
        .onConflictDoUpdate({
          target: [agentMemory.user_id, agentMemory.conversation_id, agentMemory.key],
          set: { value, updated_at: new Date() },
        });

      return {
        result: { stored: true, key, scope },
        citations: [],
      };
    }

    case 'recall': {
      const conditions: any[] = [eq(agentMemory.user_id, _userId)];

      if (params.scope === 'conversation') {
        if (conversationId) {
          conditions.push(eq(agentMemory.conversation_id, conversationId));
        }
        conditions.push(eq(agentMemory.scope, 'conversation'));
      } else if (params.scope === 'user') {
        conditions.push(eq(agentMemory.scope, 'user'));
      } else if (params.scope === 'org') {
        // Org-scoped memories: match by org_id, not user_id
        const orgMemories = await db
          .select({ key: agentMemory.key, value: agentMemory.value, scope: agentMemory.scope })
          .from(agentMemory)
          .where(and(
            eq(agentMemory.org_id, orgId),
            eq(agentMemory.scope, 'org'),
            ...(params.key ? [eq(agentMemory.key, params.key)] : []),
          ));
        return { result: orgMemories, citations: [] };
      } else {
        // No scope filter — return user-scope + conversation-scope + org-scope
      }

      if (params.key) {
        conditions.push(eq(agentMemory.key, params.key));
      }

      let memories;
      if (!params.scope && conversationId) {
        // Get user-scoped, conversation-scoped, and org-scoped memories
        const userMemories = await db
          .select({ key: agentMemory.key, value: agentMemory.value, scope: agentMemory.scope })
          .from(agentMemory)
          .where(and(
            eq(agentMemory.user_id, _userId),
            eq(agentMemory.scope, 'user'),
            ...(params.key ? [eq(agentMemory.key, params.key)] : []),
          ));

        const convoMemories = await db
          .select({ key: agentMemory.key, value: agentMemory.value, scope: agentMemory.scope })
          .from(agentMemory)
          .where(and(
            eq(agentMemory.user_id, _userId),
            eq(agentMemory.conversation_id, conversationId),
            eq(agentMemory.scope, 'conversation'),
            ...(params.key ? [eq(agentMemory.key, params.key)] : []),
          ));

        const orgMemories = await db
          .select({ key: agentMemory.key, value: agentMemory.value, scope: agentMemory.scope })
          .from(agentMemory)
          .where(and(
            eq(agentMemory.org_id, orgId),
            eq(agentMemory.scope, 'org'),
            ...(params.key ? [eq(agentMemory.key, params.key)] : []),
          ));

        memories = [...userMemories, ...convoMemories, ...orgMemories];
      } else if (!params.scope) {
        // No conversationId — get user-scoped + org-scoped
        const userMemories = await db
          .select({ key: agentMemory.key, value: agentMemory.value, scope: agentMemory.scope })
          .from(agentMemory)
          .where(and(
            eq(agentMemory.user_id, _userId),
            eq(agentMemory.scope, 'user'),
            ...(params.key ? [eq(agentMemory.key, params.key)] : []),
          ));

        const orgMemories = await db
          .select({ key: agentMemory.key, value: agentMemory.value, scope: agentMemory.scope })
          .from(agentMemory)
          .where(and(
            eq(agentMemory.org_id, orgId),
            eq(agentMemory.scope, 'org'),
            ...(params.key ? [eq(agentMemory.key, params.key)] : []),
          ));

        memories = [...userMemories, ...orgMemories];
      } else {
        memories = await db
          .select({ key: agentMemory.key, value: agentMemory.value, scope: agentMemory.scope })
          .from(agentMemory)
          .where(and(...conditions));
      }

      return {
        result: memories,
        citations: [],
      };
    }

    case 'search_decisions': {
      // If no query, fall back to listing all org decisions ordered by created_at DESC.
      if (!params.query) {
        const decisionConditions: any[] = [
          eq(wikiPages.org_id, orgId),
          eq(wikiPages.type, 'decision'),
          eq(wikiPages.is_deleted, false),
        ];

        // space_name filter for empty-query path
        if (params.space_name) {
          const [space] = await db
            .select({ id: spaces.id })
            .from(spaces)
            .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, params.space_name)))
            .limit(1);
          if (space) decisionConditions.push(eq(wikiPages.space_id, space.id));
        }

        const allDecisions = await db
          .select({
            id: wikiPages.id,
            title: wikiPages.title,
            content: wikiPages.content,
            confidence: wikiPages.confidence,
            tags: wikiPages.tags,
            space_id: wikiPages.space_id,
            created_at: wikiPages.created_at,
          })
          .from(wikiPages)
          .where(and(...decisionConditions))
          .orderBy(desc(wikiPages.created_at))
          .limit(20);

        allDecisions.forEach((d) => {
          citations.push({ type: 'decision', id: d.id, title: d.title.slice(0, 80) });
        });

        const formatted = allDecisions.map((d) => ({
          id: d.id,
          decision: d.title,
          context: d.content,
          is_reversed: d.confidence < 0.5 || (d.tags ?? []).includes('reversed'),
          tags: d.tags,
          when: d.created_at,
        }));

        return { result: formatted, citations };
      }

      // Query provided — use retrieveContext for hybrid FTS + vector ranking.
      const contextResults = await retrieveContext({
        query: params.query,
        org_id: orgId,
        agent_employee_id: agentEmployeeId,
        types: ['decisions'],
        limit: 20,
      });

      // Post-filter by space_name if provided.
      let filteredResults = contextResults;
      if (params.space_name) {
        const [space] = await db
          .select({ id: spaces.id })
          .from(spaces)
          .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, params.space_name)))
          .limit(1);
        if (space) {
          filteredResults = contextResults.filter(
            (r) => (r as any).space_id === space.id,
          );
        }
      }

      // Re-fetch full fields (tags, confidence, created_at) for matched IDs.
      const matchedIds = filteredResults.map((r) => r.source_id);
      let fullRows: Array<{ id: string; title: string; content: string; confidence: number; tags: string[] | null; created_at: Date }> = [];
      if (matchedIds.length > 0) {
        fullRows = await db
          .select({
            id: wikiPages.id,
            title: wikiPages.title,
            content: wikiPages.content,
            confidence: wikiPages.confidence,
            tags: wikiPages.tags,
            created_at: wikiPages.created_at,
          })
          .from(wikiPages)
          .where(inArray(wikiPages.id, matchedIds));
      }

      // Preserve the ranking order from retrieveContext.
      const rowMap = new Map(fullRows.map((r) => [r.id, r]));
      const orderedRows = matchedIds
        .map((id) => rowMap.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined);

      orderedRows.forEach((d) => {
        citations.push({ type: 'decision', id: d.id, title: d.title.slice(0, 80) });
      });

      const formatted = orderedRows.map((d) => ({
        id: d.id,
        decision: d.title,
        context: d.content,
        // A decision is "reversed" if confidence < 0.5 OR the 'reversed' tag is present
        is_reversed: d.confidence < 0.5 || (d.tags ?? []).includes('reversed'),
        tags: d.tags,
        when: d.created_at,
      }));

      return { result: formatted, citations };
    }

    case 'get_user_activity': {
      const days = params.days || 7;
      const since = new Date();
      since.setDate(since.getDate() - days);

      // Resolve user by name (case-insensitive)
      const [targetUser] = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .innerJoin(orgMembers, eq(users.id, orgMembers.user_id))
        .where(
          and(eq(orgMembers.org_id, orgId), ilike(users.name, `%${params.user_name}%`)),
        )
        .limit(1);

      if (!targetUser) {
        return { result: { error: `User "${params.user_name}" not found` }, citations: [] };
      }

      // Recent task activity
      const recentTaskChanges = await db
        .select({
          action: taskActivity.action,
          field: taskActivity.field,
          old_value: taskActivity.old_value,
          new_value: taskActivity.new_value,
          task_title: tasks.title,
          task_number: tasks.number,
          project_prefix: projects.prefix,
          created_at: taskActivity.created_at,
        })
        .from(taskActivity)
        .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .where(
          and(
            eq(taskActivity.user_id, targetUser.id),
            gte(taskActivity.created_at, since),
          ),
        )
        .orderBy(desc(taskActivity.created_at))
        .limit(20);

      // Message counts by space
      const messageCounts = await db
        .select({
          space_name: spaces.name,
          count: sql<number>`count(*)`,
        })
        .from(messages)
        .innerJoin(spaces, eq(messages.space_id, spaces.id))
        .where(
          and(
            eq(messages.user_id, targetUser.id),
            eq(messages.org_id, orgId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, since),
          ),
        )
        .groupBy(spaces.name);

      const messageCountsBySpace = Object.fromEntries(
        messageCounts.map((r) => [r.space_name, Number(r.count)]),
      );

      // Current tasks by status
      const currentTasksByStatus = await db
        .select({
          status: tasks.status,
          count: sql<number>`count(*)`,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.org_id, orgId),
            eq(tasks.assignee_id, targetUser.id),
            eq(tasks.is_deleted, false),
          ),
        )
        .groupBy(tasks.status);

      const currentTasks = Object.fromEntries(
        currentTasksByStatus.map((r) => [r.status, Number(r.count)]),
      );

      citations.push({
        type: 'user',
        id: targetUser.id,
        title: targetUser.name,
      });

      return {
        result: {
          user_name: targetUser.name,
          recent_task_changes: recentTaskChanges.map((a) => ({
            task: `${a.project_prefix}-${a.task_number}: ${a.task_title}`,
            action: a.action,
            field: a.field,
            old_value: a.old_value,
            new_value: a.new_value,
            at: a.created_at,
          })),
          message_counts_by_space: messageCountsBySpace,
          current_tasks: currentTasks,
        },
        citations,
      };
    }

    case 'get_task_dependencies': {
      let taskId = params.task_identifier as string;
      const match = taskId.match(/^([A-Z]+)-(\d+)$/);

      if (match) {
        const [proj] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.org_id, orgId), eq(projects.prefix, match[1]!)))
          .limit(1);
        if (proj) {
          const [found] = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.project_id, proj.id), eq(tasks.number, parseInt(match[2]!))))
            .limit(1);
          if (found) taskId = found.id;
        }
      }

      // Get relationships where this task is source (it blocks others)
      const blocksRels = await db
        .select({
          rel_type: taskRelationships.type,
          target_task_id: taskRelationships.target_task_id,
          target_title: tasks.title,
          target_number: tasks.number,
          target_status: tasks.status,
          target_assignee: users.name,
          project_prefix: projects.prefix,
        })
        .from(taskRelationships)
        .innerJoin(tasks, eq(taskRelationships.target_task_id, tasks.id))
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .leftJoin(users, eq(tasks.assignee_id, users.id))
        .where(eq(taskRelationships.source_task_id, taskId));

      // Get relationships where this task is target (it's blocked by others)
      const blockedByRels = await db
        .select({
          rel_type: taskRelationships.type,
          source_task_id: taskRelationships.source_task_id,
          source_title: tasks.title,
          source_number: tasks.number,
          source_status: tasks.status,
          source_assignee: users.name,
          project_prefix: projects.prefix,
        })
        .from(taskRelationships)
        .innerJoin(tasks, eq(taskRelationships.source_task_id, tasks.id))
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .leftJoin(users, eq(tasks.assignee_id, users.id))
        .where(eq(taskRelationships.target_task_id, taskId));

      const blocks = blocksRels
        .filter((r) => r.rel_type === 'blocks')
        .map((r) => ({
          task: `${r.project_prefix}-${r.target_number}: ${r.target_title}`,
          status: r.target_status,
          assignee: r.target_assignee,
        }));

      const blocked_by = blockedByRels
        .filter((r) => r.rel_type === 'blocks')
        .map((r) => ({
          task: `${r.project_prefix}-${r.source_number}: ${r.source_title}`,
          status: r.source_status,
          assignee: r.source_assignee,
        }));

      const relates_to = [
        ...blocksRels
          .filter((r) => r.rel_type === 'relates_to')
          .map((r) => ({
            task: `${r.project_prefix}-${r.target_number}: ${r.target_title}`,
            status: r.target_status,
            assignee: r.target_assignee,
          })),
        ...blockedByRels
          .filter((r) => r.rel_type === 'relates_to')
          .map((r) => ({
            task: `${r.project_prefix}-${r.source_number}: ${r.source_title}`,
            status: r.source_status,
            assignee: r.source_assignee,
          })),
      ];

      // Add citations for related tasks
      for (const r of blocksRels) {
        citations.push({
          type: 'task',
          id: r.target_task_id,
          title: `${r.project_prefix}-${r.target_number}: ${r.target_title}`,
        });
      }
      for (const r of blockedByRels) {
        citations.push({
          type: 'task',
          id: r.source_task_id,
          title: `${r.project_prefix}-${r.source_number}: ${r.source_title}`,
        });
      }

      return {
        result: { blocks, blocked_by, relates_to },
        citations,
      };
    }

    case 'search_blockers': {
      const days = params.days || 7;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const query = params.query as string;

      // Build search conditions — search for the query PLUS blocker-related keywords
      const blockerKeywords = ['blocked', 'stuck', 'waiting', "can't", 'blocker', 'dependency'];
      const keywordPatterns = [query, ...blockerKeywords];

      // Use OR logic: message matches the query or contains blocker keywords
      const searchConditions = keywordPatterns.map((kw) =>
        ilike(messages.content, `%${kw}%`),
      );

      const results = await db
        .select({
          id: messages.id,
          content: messages.content,
          user_name: users.name,
          space_id: messages.space_id,
          created_at: messages.created_at,
        })
        .from(messages)
        .innerJoin(users, eq(messages.user_id, users.id))
        .where(
          and(
            eq(messages.org_id, orgId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, since),
            or(...searchConditions),
          ),
        )
        .orderBy(desc(messages.created_at))
        .limit(15);

      // Resolve space names
      const spaceIds = [...new Set(results.map((r) => r.space_id))];
      const spaceMap = new Map<string, string>();
      if (spaceIds.length > 0) {
        const spaceRows = await db
          .select({ id: spaces.id, name: spaces.name })
          .from(spaces)
          .where(inArray(spaces.id, spaceIds));
        spaceRows.forEach((s) => spaceMap.set(s.id, s.name));
      }

      const formatted = results.map((r) => ({
        id: r.id,
        content: r.content,
        author: r.user_name,
        space: spaceMap.get(r.space_id) || 'unknown',
        timestamp: r.created_at,
      }));

      formatted.forEach((m) => {
        citations.push({
          type: 'message',
          id: m.id,
          title: `#${m.space} - ${m.author}`,
        });
      });

      return { result: formatted, citations };
    }

    // ─── Knowledge Tools ───

    case 'search_knowledge': {
      const query = params.query as string;
      const limit = (params.limit as number) || 10;

      // Determine which wiki types to query based on params.type filter.
      // 'decision' → types:['decisions'], others → types:['wiki'] with optional
      // post-filter on metadata.type for resource / action_item / note.
      let retrieveTypes: Array<'wiki' | 'decisions'> = ['wiki', 'decisions'];
      let metadataTypeFilter: string | null = null;

      if (params.type) {
        switch (params.type) {
          case 'decision':
            retrieveTypes = ['decisions'];
            break;
          case 'resource':
            retrieveTypes = ['wiki'];
            metadataTypeFilter = 'resource';
            break;
          case 'action_item':
            // Closest wiki equivalent is 'procedure'
            retrieveTypes = ['wiki'];
            metadataTypeFilter = 'procedure';
            break;
          case 'note':
            retrieveTypes = ['wiki'];
            metadataTypeFilter = 'fact';
            break;
          default:
            retrieveTypes = ['wiki', 'decisions'];
        }
      }

      // Use retrieveContext for FTS + hybrid ranking.
      const contextResults = await retrieveContext({
        query,
        org_id: orgId,
        agent_employee_id: agentEmployeeId,
        types: retrieveTypes,
        limit,
      });

      // Post-filter by metadata.type if a type mapping requires it.
      let filteredResults = contextResults;
      if (metadataTypeFilter) {
        filteredResults = contextResults.filter(
          (r) => r.metadata?.type === metadataTypeFilter,
        );
      }

      // Post-filter by space_name if provided.
      if (params.space_name) {
        const [space] = await db
          .select({ id: spaces.id })
          .from(spaces)
          .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, `%${params.space_name}%`)))
          .limit(1);
        if (space) {
          filteredResults = filteredResults.filter(
            (r) => (r as any).space_id === space.id,
          );
        }
      }

      // Re-fetch full wiki_pages fields (space_id, user_id, created_at, tags) for
      // matched IDs so we can return the expected response shape.
      const matchedIds = filteredResults.map((r) => r.source_id);
      let wikiRows: Array<{
        id: string;
        type: string;
        title: string;
        content: string;
        tags: string[] | null;
        space_id: string | null;
        user_id: string | null;
        created_at: Date;
      }> = [];
      if (matchedIds.length > 0) {
        wikiRows = await db
          .select({
            id: wikiPages.id,
            type: wikiPages.type,
            title: wikiPages.title,
            content: wikiPages.content,
            tags: wikiPages.tags,
            space_id: wikiPages.space_id,
            user_id: wikiPages.user_id,
            created_at: wikiPages.created_at,
          })
          .from(wikiPages)
          .where(inArray(wikiPages.id, matchedIds));
      }

      // Resolve space names for wiki rows that have a space_id.
      const wikiSpaceIds = [...new Set(wikiRows.map((r) => r.space_id).filter(Boolean))] as string[];
      const wikiSpaceMap = new Map<string, string>();
      if (wikiSpaceIds.length > 0) {
        const spaceRows = await db
          .select({ id: spaces.id, name: spaces.name })
          .from(spaces)
          .where(inArray(spaces.id, wikiSpaceIds));
        spaceRows.forEach((s) => wikiSpaceMap.set(s.id, s.name));
      }

      // Preserve ranking order from retrieveContext.
      const wikiRowMap = new Map(wikiRows.map((r) => [r.id, r]));
      const orderedRows = matchedIds
        .map((id) => wikiRowMap.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined);

      const formatted = orderedRows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: r.content,
        // metadata: expose tags as metadata for consistency; wiki pages don't have
        // a separate metadata JSON column, so we synthesize a minimal object.
        metadata: { tags: r.tags ?? [] },
        space: r.space_id ? (wikiSpaceMap.get(r.space_id) ?? null) : null,
        // author_name is not stored on wiki_pages directly; return null honestly
        // rather than synthesizing a false value.
        author: null as string | null,
        created_at: r.created_at,
      }));

      formatted.forEach((k) => {
        citations.push({ type: 'knowledge', id: k.id, title: `${k.type}: ${k.title}` });
      });

      return { result: formatted, citations };
    }

    case 'add_knowledge': {
      const spaceName = params.space_name as string;
      const [space] = await db.select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, `%${spaceName}%`)))
        .limit(1);

      if (!space) {
        return { result: { error: `Space "${spaceName}" not found` }, citations };
      }

      // Map legacy 4-type knowledge to wiki's 7-type taxonomy.
      const legacyToWiki: Record<string, string> = {
        decision: 'decision',
        resource: 'resource',
        action_item: 'procedure',
        note: 'fact',
      };
      const wikiType = (legacyToWiki[params.type as string] || 'fact') as
        'concept' | 'entity' | 'decision' | 'resource' | 'procedure' | 'preference' | 'fact';

      const title = params.title as string;
      const baseSlug = title.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'knowledge';

      // Ensure unique slug within org (append timestamp suffix on collision).
      const [existingSlug] = await db.select({ id: wikiPages.id })
        .from(wikiPages)
        .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, baseSlug)))
        .limit(1);
      const slug = existingSlug ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;

      const [entry] = await db.insert(wikiPages).values({
        org_id: orgId,
        scope: 'space',
        space_id: space.id,
        user_id: _userId,
        type: wikiType,
        title,
        slug,
        content: (params.content as string) || title,
        confidence: 1.0,
      }).returning();

      citations.push({ type: 'knowledge', id: entry!.id, title: `${wikiType}: ${title}` });

      return {
        result: { success: true, id: entry!.id, message: `Added "${title}" to #${spaceName} knowledge` },
        citations,
      };
    }

    // ─── Manager / Team Tools ───

    case 'get_team_health': {
      const userIsManager = await isManager(_userId, orgId);

      // Get all org members
      const members = await db
        .select({ userId: orgMembers.user_id, name: users.name })
        .from(orgMembers)
        .innerJoin(users, eq(orgMembers.user_id, users.id))
        .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true)));

      // If not a manager, only return the requesting user's own data
      const targetMembers = userIsManager
        ? (params.user_name
            ? members.filter((m) => m.name.toLowerCase().includes((params.user_name as string).toLowerCase()))
            : members)
        : members.filter((m) => m.userId === _userId);

      const now = new Date();
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const healthCards: any[] = [];

      for (const member of targetMembers) {
        // Active tasks
        const [activeRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(tasks)
          .where(and(
            eq(tasks.org_id, orgId),
            eq(tasks.assignee_id, member.userId),
            eq(tasks.is_deleted, false),
            sql`${tasks.status} NOT IN ('done', 'cancelled')`,
          ));
        const activeTasks = Number(activeRow?.count ?? 0);

        // Overdue tasks
        const [overdueRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(tasks)
          .where(and(
            eq(tasks.org_id, orgId),
            eq(tasks.assignee_id, member.userId),
            eq(tasks.is_deleted, false),
            sql`${tasks.status} NOT IN ('done', 'cancelled')`,
            lt(tasks.due_date, now),
          ));
        const overdueTasks = Number(overdueRow?.count ?? 0);

        // Recent messages
        const [msgRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(messages)
          .where(and(
            eq(messages.org_id, orgId),
            eq(messages.user_id, member.userId),
            eq(messages.is_deleted, false),
            gte(messages.created_at, oneWeekAgo),
          ));
        const messageCount = Number(msgRow?.count ?? 0);

        // Activity trend from peoplePatterns
        const [activityTrend] = await db
          .select({ pattern_data: peoplePatterns.pattern_data })
          .from(peoplePatterns)
          .where(and(
            eq(peoplePatterns.org_id, orgId),
            eq(peoplePatterns.user_id, member.userId),
            eq(peoplePatterns.pattern_type, 'activity_trend'),
          ))
          .limit(1);

        // Determine health status
        let status: 'green' | 'yellow' | 'red' = 'green';
        let insight = 'On track';

        if (overdueTasks >= 3 || (activeTasks > 8 && overdueTasks > 0)) {
          status = 'red';
          insight = `${overdueTasks} overdue tasks, ${activeTasks} active — needs support`;
        } else if (overdueTasks > 0 || activeTasks > 6 || messageCount === 0) {
          status = 'yellow';
          if (overdueTasks > 0) insight = `${overdueTasks} overdue task(s)`;
          else if (activeTasks > 6) insight = `Heavy workload: ${activeTasks} active tasks`;
          else insight = 'Low engagement this week';
        } else {
          insight = `${activeTasks} active tasks, ${messageCount} messages this week`;
        }

        healthCards.push({
          user_id: member.userId,
          name: member.name,
          status,
          insight,
          active_tasks: activeTasks,
          overdue_tasks: overdueTasks,
          messages_7d: messageCount,
          activity_trend: activityTrend?.pattern_data ?? null,
        });
      }

      if (!userIsManager) {
        return {
          result: { note: 'Showing your own health data only (manager access required for team view)', cards: healthCards },
          citations: [],
        };
      }

      return { result: { cards: healthCards }, citations: [] };
    }

    case 'get_team_performance': {
      const projectName = params.project_name as string | undefined;
      let projectId: string | undefined;

      if (projectName) {
        const [proj] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.org_id, orgId), ilike(projects.name, `%${projectName}%`)))
          .limit(1);
        if (proj) projectId = proj.id;
      }

      const velocity = await velocityCalculator(orgId, projectId);
      return { result: velocity, citations: [] };
    }

    case 'get_workload_balance': {
      const workload = await workloadAnalyzer(orgId);
      return { result: workload, citations: [] };
    }

    case 'prep_oneone': {
      // Check manager access
      const canPrep = await isManager(_userId, orgId);
      if (!canPrep) {
        return {
          result: { error: 'Manager role required. Only org owners and admins can generate 1:1 preps.' },
          citations: [],
        };
      }

      // Resolve person by name
      const personName = params.person as string;
      const [targetUser] = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .innerJoin(orgMembers, eq(users.id, orgMembers.user_id))
        .where(and(eq(orgMembers.org_id, orgId), ilike(users.name, `%${personName}%`)))
        .limit(1);

      if (!targetUser) {
        return { result: { error: `User "${personName}" not found in this organization` }, citations: [] };
      }

      const prep = await generateOneOnePrep(_userId, targetUser.id, orgId);
      citations.push({ type: 'user', id: targetUser.id, title: targetUser.name });
      return { result: prep, citations };
    }

    case 'find_expert': {
      const topic = params.topic as string;
      const experts = await db
        .select({
          user_name: users.name,
          topic: peopleExpertise.topic,
          score: peopleExpertise.expertise_score,
          message_count: peopleExpertise.message_count,
          tasks_completed: peopleExpertise.tasks_completed_count,
        })
        .from(peopleExpertise)
        .innerJoin(users, eq(peopleExpertise.user_id, users.id))
        .where(and(
          eq(peopleExpertise.org_id, orgId),
          ilike(peopleExpertise.topic, `%${topic}%`),
        ))
        .orderBy(desc(peopleExpertise.expertise_score))
        .limit(5);

      if (experts.length === 0) {
        return { result: { message: `No experts found for "${topic}"`, experts: [] }, citations: [] };
      }

      experts.forEach((e) => {
        citations.push({ type: 'expertise', id: e.user_name, title: `${e.user_name} — ${e.topic}` });
      });

      return { result: { experts }, citations };
    }

    case 'get_team_dynamics': {
      // Get relationships
      const relationships = await db
        .select({
          user_a_id: peopleRelationships.user_a_id,
          user_b_id: peopleRelationships.user_b_id,
          relationship_type: peopleRelationships.relationship_type,
          strength: peopleRelationships.strength,
          direction: peopleRelationships.direction,
        })
        .from(peopleRelationships)
        .where(eq(peopleRelationships.org_id, orgId));

      // Get top interaction pairs
      const topPairs = await db
        .select({
          user_a_id: peopleInteractions.user_a_id,
          user_b_id: peopleInteractions.user_b_id,
          score: peopleInteractions.recency_weighted_score,
          interaction_count: peopleInteractions.interaction_count,
        })
        .from(peopleInteractions)
        .where(eq(peopleInteractions.org_id, orgId))
        .orderBy(desc(peopleInteractions.recency_weighted_score))
        .limit(10);

      // Resolve user names for all IDs
      const allUserIds = new Set<string>();
      relationships.forEach((r) => { allUserIds.add(r.user_a_id); allUserIds.add(r.user_b_id); });
      topPairs.forEach((p) => { allUserIds.add(p.user_a_id); allUserIds.add(p.user_b_id); });

      const nameMap = new Map<string, string>();
      if (allUserIds.size > 0) {
        const userRows = await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, [...allUserIds]));
        userRows.forEach((u) => nameMap.set(u.id, u.name));
      }

      const collaborationClusters = topPairs.map((p) => ({
        person_a: nameMap.get(p.user_a_id) || p.user_a_id,
        person_b: nameMap.get(p.user_b_id) || p.user_b_id,
        score: p.score,
        interactions: Number(p.interaction_count),
      }));

      const tensions = relationships
        .filter((r) => r.relationship_type === 'tension')
        .map((r) => ({
          person_a: nameMap.get(r.user_a_id) || r.user_a_id,
          person_b: nameMap.get(r.user_b_id) || r.user_b_id,
          strength: r.strength,
        }));

      const mentoringPairs = relationships
        .filter((r) => r.relationship_type === 'mentor_mentee')
        .map((r) => ({
          mentor: r.direction === 'a_to_b' ? (nameMap.get(r.user_a_id) || r.user_a_id) : (nameMap.get(r.user_b_id) || r.user_b_id),
          mentee: r.direction === 'a_to_b' ? (nameMap.get(r.user_b_id) || r.user_b_id) : (nameMap.get(r.user_a_id) || r.user_a_id),
          strength: r.strength,
        }));

      const closeCollaborators = relationships
        .filter((r) => r.relationship_type === 'close_collaborator')
        .map((r) => ({
          person_a: nameMap.get(r.user_a_id) || r.user_a_id,
          person_b: nameMap.get(r.user_b_id) || r.user_b_id,
          strength: r.strength,
        }));

      return {
        result: {
          collaboration_clusters: collaborationClusters,
          close_collaborators: closeCollaborators,
          tensions,
          mentoring_pairs: mentoringPairs,
        },
        citations: [],
      };
    }

    case 'analyze_skills_gap': {
      const gaps = await skillsGapAnalyzer(orgId);
      return { result: gaps, citations: [] };
    }

    case 'get_burnout_risks': {
      // PRIVACY: Only return if user is admin/owner
      const canView = await isManager(_userId, orgId);
      if (!canView) {
        return {
          result: { error: 'Manager role required. Only org owners and admins can view burnout risk data.' },
          citations: [],
        };
      }

      const alerts = await db
        .select({
          user_name: users.name,
          confidence: burnoutAlerts.confidence,
          status: burnoutAlerts.status,
          created_at: burnoutAlerts.created_at,
        })
        .from(burnoutAlerts)
        .innerJoin(users, eq(burnoutAlerts.user_id, users.id))
        .where(and(
          eq(burnoutAlerts.org_id, orgId),
          eq(burnoutAlerts.status, 'active'),
        ));

      // Return alerts WITHOUT message content or detailed signals — only patterns
      const result = alerts.map((a) => ({
        person: a.user_name,
        confidence: a.confidence,
        status: a.status,
        detected_at: a.created_at,
      }));

      return {
        result: { alerts: result, count: result.length },
        citations: [],
      };
    }

    // ─── Wiki Tools ───

    case 'wiki_search': {
      // Block 0.6 — semantic wiki search. Routes through retrieveContext
      // which runs hybrid FTS (search_vector @@ plainto_tsquery) + pgvector
      // cosine (embedding <=> queryVector) weighted 0.4 / 0.6 * confidence.
      // Falls back to FTS-only when OPENAI_API_KEY is missing or the
      // pgvector <=> operator is unavailable.
      const { query, type: pageType, scope: pageScope, limit: maxResults = 5 } = params;
      const { retrieveContext } = await import('./retrieve-context.js');
      const hits = await retrieveContext({
        query,
        org_id: orgId,
        types: ['wiki'],
        limit: Math.min(maxResults, 10),
      });

      // Fetch the full wiki_pages row + linked pages for each hit so the
      // tool output keeps the shape callers expect (title/slug/summary/
      // type/scope/confidence/updated_at + linked_pages[]).
      const hitIds = hits.map((h) => h.source_id);
      const pages =
        hitIds.length > 0
          ? await db
              .select({
                id: wikiPages.id,
                title: wikiPages.title,
                slug: wikiPages.slug,
                summary: wikiPages.summary,
                type: wikiPages.type,
                scope: wikiPages.scope,
                confidence: wikiPages.confidence,
                updated_at: wikiPages.updated_at,
              })
              .from(wikiPages)
              .where(
                and(
                  eq(wikiPages.org_id, orgId),
                  eq(wikiPages.is_deleted, false),
                  inArray(wikiPages.id, hitIds),
                  ...(pageType ? [eq(wikiPages.type, pageType)] : []),
                  ...(pageScope ? [eq(wikiPages.scope, pageScope)] : []),
                ),
              )
          : [];

      // Preserve retrieveContext's ranking order.
      const byId = new Map(pages.map((p) => [p.id, p]));
      const ordered = hitIds
        .map((id) => byId.get(id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p));

      const enriched = await Promise.all(
        ordered.map(async (page) => {
          const links = await db
            .select({ title: wikiPages.title, slug: wikiPages.slug })
            .from(wikiLinks)
            .innerJoin(wikiPages, eq(wikiLinks.target_page_id, wikiPages.id))
            .where(eq(wikiLinks.source_page_id, page.id))
            .limit(5);
          return { ...page, linked_pages: links };
        }),
      );

      const citations: Citation[] = ordered.map((p) => ({
        type: 'wiki',
        id: p.id,
        title: p.title,
      }));

      return { result: { pages: enriched, count: enriched.length }, citations };
    }

    case 'wiki_read': {
      const { slug } = params;

      const [page] = await db.select()
        .from(wikiPages)
        .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, slug), eq(wikiPages.is_deleted, false)))
        .limit(1);

      if (!page) {
        return { result: { error: `Wiki page "${slug}" not found` }, citations: [] };
      }

      // Get linked pages
      const linkedPages = await db.select({
        slug: wikiPages.slug,
        title: wikiPages.title,
        type: wikiPages.type,
        summary: wikiPages.summary,
      })
        .from(wikiLinks)
        .innerJoin(wikiPages, eq(wikiLinks.target_page_id, wikiPages.id))
        .where(eq(wikiLinks.source_page_id, page.id));

      // Get backlinks
      const backlinks = await db.select({
        slug: wikiPages.slug,
        title: wikiPages.title,
        type: wikiPages.type,
      })
        .from(wikiLinks)
        .innerJoin(wikiPages, eq(wikiLinks.source_page_id, wikiPages.id))
        .where(eq(wikiLinks.target_page_id, page.id));

      // Get citations
      const citations = await db.select()
        .from(wikiCitations)
        .where(eq(wikiCitations.page_id, page.id))
        .orderBy(desc(wikiCitations.created_at))
        .limit(10);

      return {
        result: {
          title: page.title,
          slug: page.slug,
          type: page.type,
          scope: page.scope,
          content: page.content,
          summary: page.summary,
          confidence: page.confidence,
          version: page.version,
          updated_at: page.updated_at,
          linked_pages: linkedPages,
          backlinks,
          citations,
        },
        citations: [{ type: 'wiki', id: page.id, title: page.title }],
      };
    }

    case 'wiki_write': {
      const { slug: existingSlug, title, content, type: pageType, summary, related_slugs } = params;

      if (existingSlug) {
        // UPDATE existing page
        const [existing] = await db.select()
          .from(wikiPages)
          .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, existingSlug), eq(wikiPages.is_deleted, false)))
          .limit(1);

        if (!existing) {
          return { result: { error: `Wiki page "${existingSlug}" not found` }, citations: [] };
        }

        const updates: Record<string, any> = {};
        if (title) updates.title = title;
        if (summary) updates.summary = summary;
        if (pageType) updates.type = pageType;
        if (content && content !== existing.content) {
          updates.content = content;
          updates.previous_content = existing.content;
          updates.version = existing.version + 1;
        }

        if (Object.keys(updates).length > 0) {
          await db.update(wikiPages).set(updates).where(eq(wikiPages.id, existing.id));
        }

        // Update links
        if (related_slugs && related_slugs.length > 0) {
          await db.delete(wikiLinks).where(eq(wikiLinks.source_page_id, existing.id));
          const targets = await db.select({ id: wikiPages.id })
            .from(wikiPages)
            .where(and(eq(wikiPages.org_id, orgId), inArray(wikiPages.slug, related_slugs)));
          for (const t of targets) {
            if (t.id !== existing.id) {
              await db.insert(wikiLinks).values({ org_id: orgId, source_page_id: existing.id, target_page_id: t.id }).onConflictDoNothing();
            }
          }
        }

        await db.insert(wikiOpsLog).values({
          org_id: orgId,
          operation: 'update',
          page_id: existing.id,
          details: { updated_fields: Object.keys(updates), by_agent: true },
          performed_by: _userId,
        });

        return { result: { success: true, slug: existingSlug, action: 'updated' }, citations: [] };
      } else {
        // CREATE new page
        if (!title || !content || !pageType) {
          return { result: { error: 'title, content, and type are required to create a wiki page' }, citations: [] };
        }

        let slug = title.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 80);

        // Ensure unique
        const [dup] = await db.select({ id: wikiPages.id })
          .from(wikiPages)
          .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, slug)))
          .limit(1);
        if (dup) slug = `${slug}-${Date.now().toString(36)}`;

        const [page] = await db.insert(wikiPages).values({
          org_id: orgId,
          scope: 'org',
          type: pageType,
          title,
          slug,
          summary: summary || null,
          content,
          confidence: 1.0,
        }).returning();

        // Create links
        if (related_slugs && related_slugs.length > 0) {
          const targets = await db.select({ id: wikiPages.id })
            .from(wikiPages)
            .where(and(eq(wikiPages.org_id, orgId), inArray(wikiPages.slug, related_slugs)));
          for (const t of targets) {
            if (t.id !== page!.id) {
              await db.insert(wikiLinks).values({ org_id: orgId, source_page_id: page!.id, target_page_id: t.id }).onConflictDoNothing();
            }
          }
        }

        await db.insert(wikiOpsLog).values({
          org_id: orgId,
          operation: 'create',
          page_id: page!.id,
          details: { title, type: pageType, by_agent: true },
          performed_by: _userId,
        });

        return { result: { success: true, slug, action: 'created' }, citations: [] };
      }
    }

    case 'wiki_suggest_update': {
      const { slug, suggested_content, reason } = params as { slug: string; suggested_content: string; reason: string };

      if (!slug || !suggested_content || !reason) {
        return { result: { error: 'slug, suggested_content, and reason are required' }, citations: [] };
      }

      // Verify page exists
      const [page] = await db.select({ id: wikiPages.id, title: wikiPages.title })
        .from(wikiPages)
        .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, slug), eq(wikiPages.is_deleted, false)))
        .limit(1);

      if (!page) {
        return { result: { error: `Wiki page "${slug}" not found` }, citations: [] };
      }

      // Log the suggestion in ops log
      await db.insert(wikiOpsLog).values({
        org_id: orgId,
        operation: 'suggest_update',
        page_id: page.id,
        details: { suggested_content, reason, by_agent: true },
        performed_by: _userId,
      });

      return {
        result: { success: true, message: `Suggestion logged for "${page.title}". A team member will review it.` },
        citations: [{ type: 'wiki', id: page.id, title: page.title }],
      };
    }

    // ─── Superintendent Tools (read-only) ───

    case 'list_agent_employees': {
      const { status_filter } = params as { status_filter?: string };

      let query = db
        .select({
          id: agentEmployees.id,
          name: agentEmployees.name,
          slug: agentEmployees.slug,
          role: agentEmployees.role,
          is_active: agentEmployees.is_active,
          trust_level: agentEmployees.trust_level,
          daily_action_count: agentEmployees.daily_action_count,
          max_daily_actions: agentEmployees.max_daily_actions,
          is_byoa: agentEmployees.is_byoa,
          created_at: agentEmployees.created_at,
          updated_at: agentEmployees.updated_at,
        })
        .from(agentEmployees)
        .where(
          status_filter === 'active'
            ? and(eq(agentEmployees.org_id, orgId), eq(agentEmployees.is_active, true))
            : status_filter === 'paused'
              ? and(eq(agentEmployees.org_id, orgId), eq(agentEmployees.is_active, false))
              : eq(agentEmployees.org_id, orgId),
        )
        .orderBy(desc(agentEmployees.created_at));

      const employees = await query;
      return {
        result: {
          employees: employees.map((e) => ({
            id: e.id,
            name: e.name,
            slug: e.slug,
            role: e.role,
            status: e.is_active ? 'active' : 'paused',
            trust_level: e.trust_level,
            daily_actions: `${e.daily_action_count}/${e.max_daily_actions}`,
            is_byoa: e.is_byoa,
            created_at: e.created_at,
            updated_at: e.updated_at,
          })),
          total: employees.length,
        },
        citations: [],
      };
    }

    case 'get_agent_activity': {
      const { employee_id, limit: resultLimit } = params as { employee_id?: string; limit?: number };
      const maxResults = Math.min(resultLimit || 20, 100);

      const conditions = [eq(agentActions.org_id, orgId)];
      if (employee_id) {
        conditions.push(eq(agentActions.agent_employee_id, employee_id));
      }

      const actions = await db
        .select({
          id: agentActions.id,
          action: agentActions.action,
          params: agentActions.params,
          approval_status: agentActions.approval_status,
          agent_employee_id: agentActions.agent_employee_id,
          source: agentActions.source,
          created_at: agentActions.created_at,
          executed_at: agentActions.executed_at,
          error: agentActions.error,
        })
        .from(agentActions)
        .where(and(...conditions))
        .orderBy(desc(agentActions.created_at))
        .limit(maxResults);

      return {
        result: {
          actions,
          total: actions.length,
        },
        citations: [],
      };
    }

    case 'get_agent_economics': {
      const employees = await db
        .select({
          id: agentEmployees.id,
          name: agentEmployees.name,
          role: agentEmployees.role,
          is_active: agentEmployees.is_active,
          daily_action_count: agentEmployees.daily_action_count,
          max_daily_actions: agentEmployees.max_daily_actions,
          is_byoa: agentEmployees.is_byoa,
        })
        .from(agentEmployees)
        .where(eq(agentEmployees.org_id, orgId))
        .orderBy(desc(agentEmployees.daily_action_count));

      return {
        result: {
          employees: employees.map((e) => ({
            id: e.id,
            name: e.name,
            role: e.role,
            is_active: e.is_active,
            daily_actions_used: e.daily_action_count,
            daily_actions_limit: e.max_daily_actions,
            is_byoa: e.is_byoa,
          })),
          total_employees: employees.length,
          total_active: employees.filter((e) => e.is_active).length,
          total_daily_actions_used: employees.reduce((sum, e) => sum + e.daily_action_count, 0),
        },
        citations: [],
      };
    }

    case 'create_plan': {
      const { title, description, steps } = params as {
        title?: string;
        description?: string;
        steps?: any[];
      };

      if (!title || !steps || !Array.isArray(steps)) {
        return {
          result: { error: 'create_plan requires title and steps' },
          citations: [],
        };
      }

      const planResult = await createPlanRow({
        org_id: orgId,
        user_id: _userId,
        conversation_id: conversationId ?? null,
        agent_employee_id: agentEmployeeId ?? null,
        title,
        description: description ?? null,
        steps,
      });

      return { result: planResult, citations: [] };
    }

    default:
      return { result: { error: `Unknown tool: ${toolName}` }, citations: [] };
  }
}
