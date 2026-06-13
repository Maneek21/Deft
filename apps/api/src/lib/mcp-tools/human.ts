import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  connectedAccounts,
  events,
  messages,
  orgMembers,
  orgs,
  projects,
  spaceMembers,
  spaces,
  taskActivity,
  taskComments,
  tasks,
  users,
  wikiPages,
} from '@deft/db/schema';
import { retrieveContext, type ContextResult } from '../retrieve-context.js';
import { visibleTaskCondition } from '../task-visibility.js';
import { visibleWikiPageCondition } from '../wiki-visibility.js';
import { errorResult, textResult, type ToolResult } from './types.js';

export type HumanToolContext = {
  org_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  scopes: string[];
};

type HumanToolHandler = (args: any, ctx: HumanToolContext) => Promise<ToolResult>;

function hasScope(ctx: HumanToolContext, scope: string): boolean {
  return ctx.scopes.includes(scope);
}

function requireScope(ctx: HumanToolContext, scope: string): ToolResult | null {
  return hasScope(ctx, scope) ? null : errorResult(`Missing MCP scope: ${scope}`);
}

async function userCanSeeSpace(ctx: HumanToolContext, spaceId: string): Promise<boolean> {
  const [space] = await db
    .select({ id: spaces.id, type: spaces.type })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, ctx.org_id)))
    .limit(1);
  if (!space) return false;
  if (space.type === 'public') return true;
  const [member] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, ctx.user_id)))
    .limit(1);
  return Boolean(member);
}

async function userCanSeeTask(ctx: HumanToolContext, taskId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.org_id, ctx.org_id),
      eq(tasks.is_deleted, false),
      visibleTaskCondition(ctx.user_id),
    ))
    .limit(1);
  return Boolean(row);
}

async function userCanSeeProject(ctx: HumanToolContext, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.org_id, ctx.org_id), eq(projects.is_archived, false), eq(projects.is_deleted, false)))
    .limit(1);
  return Boolean(row);
}

async function userCanSeeEvent(ctx: HumanToolContext, eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .leftJoin(connectedAccounts, eq(events.connected_account_id, connectedAccounts.id))
    .where(and(
      eq(events.id, eventId),
      eq(events.org_id, ctx.org_id),
      sql`(${events.user_id} = ${ctx.user_id} OR ${connectedAccounts.user_id} = ${ctx.user_id})`,
    ))
    .limit(1);
  return Boolean(row);
}

function retrievalResultToSearchResult(row: ContextResult): Record<string, unknown> | null {
  const summary = typeof row.metadata?.summary === 'string' ? row.metadata.summary : null;
  const snippet = summary ?? row.content.slice(0, 280);
  if (row.source_type === 'wiki_page' || row.source_type === 'decision') {
    const slug = typeof row.metadata?.slug === 'string' ? row.metadata.slug : null;
    if (!slug) return null;
    return {
      id: `wiki:${slug}`,
      type: 'wiki',
      title: row.title,
      snippet,
      url: `/knowledge?slug=${encodeURIComponent(slug)}`,
      score: row.score,
      updated_at: null,
    };
  }
  if (row.source_type === 'task') {
    return {
      id: `task:${row.source_id}`,
      type: 'task',
      title: row.title,
      snippet,
      url: `/tasks?task=${encodeURIComponent(row.source_id)}`,
      score: row.score,
      updated_at: null,
    };
  }
  return null;
}

export const HUMAN_READ_TOOLS = new Set([
  'search',
  'fetch',
  'platform_context',
  'memory_recall',
  'wiki_search',
  'memory_list',
  'list_my_tasks',
  'task_query',
  'thread_fetch',
  'member_list',
  'events_query',
  'messages_search',
  'project_progress',
  'team_workload',
]);

export const HUMAN_WRITE_TOOLS = new Set([
  'memory_write',
  'task_create',
  'task_update',
  'comment_on_task',
  'message_post',
]);

export const HUMAN_TOOLS: Record<string, HumanToolHandler> = {
  search: humanSearch,
  fetch: humanFetch,
  platform_context: humanPlatformContext,
  memory_recall: humanMemoryRecall,
  wiki_search: humanMemoryRecall,
  memory_list: humanMemoryList,
  list_my_tasks: humanListMyTasks,
  memory_write: humanMemoryWrite,
  task_query: humanTaskQuery,
  task_create: humanTaskCreate,
  task_update: humanTaskUpdate,
  comment_on_task: humanCommentOnTask,
  message_post: humanMessagePost,
  thread_fetch: humanThreadFetch,
  member_list: humanMemberList,
  messages_search: humanMessagesSearch,
  project_progress: humanProjectProgress,
  team_workload: humanTeamWorkload,
  events_query: humanEventsQuery,
};

function hasAnyScope(ctx: HumanToolContext, scopes: string[]): boolean {
  return scopes.some((scope) => hasScope(ctx, scope));
}

function requireAnyScope(ctx: HumanToolContext, scopes: string[]): ToolResult | null {
  return hasAnyScope(ctx, scopes) ? null : errorResult(`Missing MCP scope: ${scopes.join(' or ')}`);
}

export async function humanPlatformContext(_args: {}, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const [org] = await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(eq(orgs.id, ctx.org_id)).limit(1);
  if (!org) return errorResult('Org not found');
  const [me] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, ctx.user_id)).limit(1);
  const teammates = await db
    .select({ id: users.id, name: users.name, email: users.email, role: orgMembers.role, is_agent: users.is_agent })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(eq(orgMembers.org_id, ctx.org_id), eq(orgMembers.is_active, true)))
    .limit(100);
  const activeProjects = await db
    .select({ id: projects.id, name: projects.name, prefix: projects.prefix })
    .from(projects)
    .where(and(eq(projects.org_id, ctx.org_id), eq(projects.is_archived, false), eq(projects.is_deleted, false)))
    .orderBy(desc(projects.updated_at))
    .limit(25);
  return textResult({
    generated_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    org,
    user: { ...me, role: ctx.role },
    teammates,
    active_projects: activeProjects,
    mcp_principal: 'human',
  });
}

export async function humanSearch(args: { query?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireAnyScope(ctx, ['read:workspace', 'read:wiki', 'read:tasks', 'read:messages', 'read:calendar']);
  if (scopeError) return scopeError;
  const query = (args.query ?? '').trim();
  if (!query) return errorResult('search requires query');
  const pattern = `%${query.toLowerCase()}%`;
  const limit = Math.min(Math.max(1, args.limit ?? 10), 20);
  const results: Array<Record<string, unknown>> = [];

  const retrievalTypes: Array<'wiki' | 'decisions' | 'tasks'> = [];
  if (hasScope(ctx, 'read:wiki')) retrievalTypes.push('wiki', 'decisions');
  if (hasScope(ctx, 'read:tasks')) retrievalTypes.push('tasks');
  if (retrievalTypes.length > 0) {
    const retrievalRows = await retrieveContext({
      query,
      org_id: ctx.org_id,
      user_id: ctx.user_id,
      types: retrievalTypes,
      limit,
      hybrid: false,
    });
    results.push(...retrievalRows.map(retrievalResultToSearchResult).filter(Boolean) as Array<Record<string, unknown>>);
  }

  if (hasScope(ctx, 'read:messages')) {
    const rows = await db.execute(sql`
      SELECT ('message:' || m.id) AS id, 'message' AS type,
             ('#' || s.name || ' message') AS title,
             left(m.content, 280) AS snippet,
             ('/chat?space=' || m.space_id || '&message=' || m.id) AS url,
             m.updated_at
      FROM messages m
      JOIN spaces s ON s.id = m.space_id AND s.org_id = m.org_id
      LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ${ctx.user_id}
      WHERE m.org_id = ${ctx.org_id}
        AND m.is_deleted = false
        AND (s.type = 'public' OR sm.id IS NOT NULL)
        AND lower(m.content) LIKE ${pattern}
      ORDER BY m.created_at DESC
      LIMIT ${limit}
    `);
    results.push(...((rows as any).rows ?? []));
  }

  if (hasScope(ctx, 'read:calendar') || hasScope(ctx, 'read:workspace')) {
    const rows = await db.execute(sql`
      SELECT ('event:' || events.id) AS id, 'event' AS type, events.title,
             COALESCE(events.body, events.source || ' calendar event') AS snippet,
             ('/calendar?event=' || events.id) AS url,
             COALESCE(events.timestamp, events.created_at) AS updated_at
      FROM events
      LEFT JOIN connected_accounts ca ON ca.id = events.connected_account_id
      WHERE events.org_id = ${ctx.org_id}
        AND (events.user_id = ${ctx.user_id} OR ca.user_id = ${ctx.user_id})
        AND (lower(COALESCE(events.title, '')) LIKE ${pattern} OR lower(COALESCE(events.body, '')) LIKE ${pattern})
      ORDER BY events.timestamp DESC NULLS LAST, events.created_at DESC
      LIMIT ${limit}
    `);
    results.push(...((rows as any).rows ?? []));
  }

  results.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
  return textResult(results.slice(0, limit));
}

export async function humanFetch(args: { id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const id = (args.id ?? '').trim();
  if (!id || !id.includes(':')) return errorResult('fetch requires an id returned by search, e.g. wiki:slug');
  const colon = id.indexOf(':');
  const kind = id.slice(0, colon);
  const rawId = id.slice(colon + 1);
  if (!kind || !rawId) return errorResult('fetch received an invalid id');

  if (kind === 'wiki') {
    const scopeError = requireScope(ctx, 'read:wiki');
    if (scopeError) return scopeError;
    const [row] = await db
      .select({
        id: wikiPages.id,
        slug: wikiPages.slug,
        title: wikiPages.title,
        summary: wikiPages.summary,
        content: wikiPages.content,
        type: wikiPages.type,
        updated_at: wikiPages.updated_at,
      })
      .from(wikiPages)
      .where(and(
        eq(wikiPages.org_id, ctx.org_id),
        eq(wikiPages.slug, rawId),
        eq(wikiPages.is_deleted, false),
        isNull(wikiPages.agent_employee_id),
        visibleWikiPageCondition(ctx.user_id),
      ))
      .limit(1);
    return row ? textResult(row) : errorResult('fetch: wiki page not found');
  }

  if (kind === 'task') {
    const scopeError = requireScope(ctx, 'read:tasks');
    if (scopeError) return scopeError;
    if (!(await userCanSeeTask(ctx, rawId))) return errorResult('fetch: task not found');
    const [row] = await db.select().from(tasks).where(and(eq(tasks.org_id, ctx.org_id), eq(tasks.id, rawId), eq(tasks.is_deleted, false))).limit(1);
    return row ? textResult(row) : errorResult('fetch: task not found');
  }

  if (kind === 'message') {
    const scopeError = requireScope(ctx, 'read:messages');
    if (scopeError) return scopeError;
    const [row] = await db.select().from(messages).where(and(eq(messages.org_id, ctx.org_id), eq(messages.id, rawId), eq(messages.is_deleted, false))).limit(1);
    if (!row) return errorResult('fetch: message not found');
    if (!(await userCanSeeSpace(ctx, row.space_id))) return errorResult('fetch: message not visible to user');
    return textResult(row);
  }

  if (kind === 'event') {
    const scopeError = requireAnyScope(ctx, ['read:calendar', 'read:workspace']);
    if (scopeError) return scopeError;
    if (!(await userCanSeeEvent(ctx, rawId))) return errorResult('fetch: event not found');
    const rows = await db.execute(sql`
      SELECT events.id, events.event_type, events.source, events.title, events.body, events.url, events.actor, events.timestamp, events.metadata, events.created_at, events.updated_at
      FROM events
      WHERE events.org_id = ${ctx.org_id}
        AND events.id = ${rawId}
      LIMIT 1
    `);
    const row = ((rows as any).rows ?? [])[0];
    return row ? textResult(row) : errorResult('fetch: event not found');
  }

  return errorResult(`fetch: unsupported id type ${kind}`);
}

export async function humanMemoryRecall(args: { query?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:wiki');
  if (scopeError) return scopeError;
  const query = (args.query ?? '').trim();
  if (!query) return errorResult('memory_recall requires query');
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3).slice(0, 8);
  const limit = Math.min(Math.max(1, args.limit ?? 10), 25);
  const rows = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      summary: wikiPages.summary,
      content: wikiPages.content,
      type: wikiPages.type,
      confidence: wikiPages.confidence,
      updated_at: wikiPages.updated_at,
    })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, ctx.org_id),
      eq(wikiPages.is_deleted, false),
      isNull(wikiPages.agent_employee_id),
      visibleWikiPageCondition(ctx.user_id),
      ...terms.map((term) => {
        const pattern = `%${term}%`;
        return sql`(lower(${wikiPages.title}) like ${pattern} or lower(${wikiPages.summary}) like ${pattern} or lower(${wikiPages.content}) like ${pattern})`;
      }),
    ))
    .orderBy(desc(wikiPages.updated_at))
    .limit(limit);
  return textResult(rows.map((row) => ({
    ...row,
    content: row.content.length > 2000 ? row.content.slice(0, 2000) : row.content,
    truncated: row.content.length > 2000,
  })));
}

export async function humanMemoryList(args: { type?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:wiki');
  if (scopeError) return scopeError;
  const limit = Math.min(Math.max(1, args.limit ?? 25), 100);
  const conditions = [eq(wikiPages.org_id, ctx.org_id), eq(wikiPages.is_deleted, false), isNull(wikiPages.agent_employee_id), visibleWikiPageCondition(ctx.user_id)];
  if (args.type) conditions.push(eq(wikiPages.type, args.type as any));
  const rows = await db
    .select({ slug: wikiPages.slug, title: wikiPages.title, summary: wikiPages.summary, type: wikiPages.type, updated_at: wikiPages.updated_at })
    .from(wikiPages)
    .where(and(...conditions))
    .orderBy(desc(wikiPages.updated_at))
    .limit(limit);
  return textResult(rows);
}

export async function humanMemoryWrite(args: { title?: string; body?: string; type?: string; confidence?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:wiki');
  if (scopeError) return scopeError;
  if (!args.title?.trim()) return errorResult('memory_write requires title');
  if (!args.body?.trim()) return errorResult('memory_write requires body');
  const type = args.type ?? 'fact';
  const slugBase = args.title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  const slug = `${slugBase || 'memory'}-${Math.random().toString(36).slice(2, 8)}`;
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO wiki_pages
      (id, org_id, scope, agent_employee_id, type, title, slug, summary, content, confidence, version, is_deleted, created_at, updated_at, metadata)
    VALUES
      (${id}, ${ctx.org_id}, 'org', NULL, ${type}, ${args.title.trim()}, ${slug}, ${args.body.slice(0, 240)}, ${args.body}, ${args.confidence ?? 0.8}, 1, false, now(), now(), ${JSON.stringify({ created_via: 'human_mcp', user_id: ctx.user_id })}::jsonb)
  `);
  return textResult({ slug, created_at: new Date().toISOString() });
}

export async function humanListMyTasks(args: { status?: string; include_completed?: boolean; filter?: { status?: string; project_id?: string }; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:tasks');
  if (scopeError) return scopeError;
  const status = args.status ?? args.filter?.status;
  const conditions = [
    eq(tasks.org_id, ctx.org_id),
    eq(tasks.is_deleted, false),
    eq(tasks.assignee_id, ctx.user_id),
  ];
  if (status) {
    conditions.push(eq(tasks.status, status as any));
  } else if (!args.include_completed) {
    conditions.push(sql`${tasks.status} NOT IN ('done', 'cancelled')` as any);
  }
  if (args.filter?.project_id) conditions.push(eq(tasks.project_id, args.filter.project_id));
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.updated_at))
    .limit(Math.min(Math.max(1, args.limit ?? 20), 50));
  return textResult(rows);
}

export async function humanTaskQuery(args: { filter?: { status?: string; assignee_id?: string; project_id?: string }; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:tasks');
  if (scopeError) return scopeError;
  const filter = args.filter ?? {};
  const conditions = [eq(tasks.org_id, ctx.org_id), eq(tasks.is_deleted, false)];
  if (filter.status) conditions.push(eq(tasks.status, filter.status as any));
  if (filter.assignee_id) conditions.push(eq(tasks.assignee_id, filter.assignee_id));
  if (filter.project_id) conditions.push(eq(tasks.project_id, filter.project_id));
  const rows = await db
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .where(and(...conditions, visibleTaskCondition(ctx.user_id)))
    .orderBy(desc(tasks.updated_at))
    .limit(Math.min(Math.max(1, args.limit ?? 20), 50));
  return textResult(rows.map((row) => row.task));
}

export async function humanTaskCreate(args: { title?: string; description?: string; project_id?: string; assignee_id?: string; priority?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:tasks');
  if (scopeError) return scopeError;
  if (!args.title?.trim()) return errorResult('task_create requires title');
  let projectId = args.project_id ?? null;
  if (!projectId) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.org_id, ctx.org_id), eq(projects.is_archived, false), eq(projects.is_deleted, false))).limit(1);
    projectId = p?.id ?? null;
  }
  if (!projectId) return errorResult('task_create: no project available');
  if (!(await userCanSeeProject(ctx, projectId))) return errorResult('task_create: project not found');
  if (args.assignee_id) {
    const [member] = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, ctx.org_id), eq(orgMembers.user_id, args.assignee_id), eq(orgMembers.is_active, true)))
      .limit(1);
    if (!member) return errorResult('task_create: assignee is not an active org member');
  }
  const counterRow = await db.execute(sql`UPDATE projects SET task_counter = task_counter + 1 WHERE id = ${projectId} AND org_id = ${ctx.org_id} AND is_deleted = false RETURNING task_counter`);
  const first = ((counterRow as any).rows ?? [])[0] as { task_counter?: number } | undefined;
  if (!first) return errorResult('task_create: project not found');
  const [task] = await db.insert(tasks).values({
    org_id: ctx.org_id,
    project_id: projectId,
    number: Number(first.task_counter),
    title: args.title.trim(),
    description: args.description ?? null,
    priority: ['p0', 'p1', 'p2', 'p3'].includes(args.priority ?? '') ? args.priority as any : 'p2',
    assignee_id: args.assignee_id ?? null,
    created_by: ctx.user_id,
  }).returning();
  if (task) {
    await db.insert(taskActivity).values({ org_id: ctx.org_id, task_id: task.id, user_id: ctx.user_id, action: 'created' });
  }
  return textResult(task);
}

export async function humanTaskUpdate(args: { task_id?: string; patch?: Record<string, unknown> }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:tasks');
  if (scopeError) return scopeError;
  if (!args.task_id) return errorResult('task_update requires task_id');
  const patch = args.patch ?? {};
  const updates: Record<string, unknown> = {};
  if (typeof patch.title === 'string') updates.title = patch.title;
  if (typeof patch.description === 'string') updates.description = patch.description;
  if (typeof patch.status === 'string') updates.status = patch.status;
  if (typeof patch.priority === 'string') updates.priority = patch.priority;
  if (typeof patch.assignee_id === 'string' || patch.assignee_id === null) updates.assignee_id = patch.assignee_id;
  if (Object.keys(updates).length === 0) return errorResult('task_update requires at least one supported patch field');
  if (!(await userCanSeeTask(ctx, args.task_id))) return errorResult('task_update: task not found');
  if (typeof patch.assignee_id === 'string') {
    const [member] = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, ctx.org_id), eq(orgMembers.user_id, patch.assignee_id), eq(orgMembers.is_active, true)))
      .limit(1);
    if (!member) return errorResult('task_update: assignee is not an active org member');
  }
  const [task] = await db.update(tasks).set(updates).where(and(eq(tasks.id, args.task_id), eq(tasks.org_id, ctx.org_id), eq(tasks.is_deleted, false))).returning();
  if (!task) return errorResult('task_update: task not found');
  await db.insert(taskActivity).values({ org_id: ctx.org_id, task_id: task.id, user_id: ctx.user_id, action: 'updated' });
  return textResult(task);
}

export async function humanCommentOnTask(args: { task_id?: string; content?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:tasks');
  if (scopeError) return scopeError;
  if (!args.task_id) return errorResult('comment_on_task requires task_id');
  const content = args.content?.trim();
  if (!content) return errorResult('comment_on_task requires content');
  if (!(await userCanSeeTask(ctx, args.task_id))) return errorResult('comment_on_task: task not found');
  const [comment] = await db.insert(taskComments).values({
    org_id: ctx.org_id,
    task_id: args.task_id,
    user_id: ctx.user_id,
    content,
  }).returning();
  await db.insert(taskActivity).values({ org_id: ctx.org_id, task_id: args.task_id, user_id: ctx.user_id, action: 'commented' });
  return textResult(comment);
}

export async function humanMessagePost(args: { space_id?: string; content?: string; parent_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:messages');
  if (scopeError) return scopeError;
  if (!args.space_id) return errorResult('message_post requires space_id');
  if (!args.content?.trim()) return errorResult('message_post requires content');
  if (!(await userCanSeeSpace(ctx, args.space_id))) return errorResult('message_post: space not found or not visible to user');
  if (args.parent_id) {
    const [parent] = await db
      .select({ id: messages.id, space_id: messages.space_id })
      .from(messages)
      .where(and(eq(messages.id, args.parent_id), eq(messages.org_id, ctx.org_id), eq(messages.is_deleted, false)))
      .limit(1);
    if (!parent || parent.space_id !== args.space_id) return errorResult('message_post: parent message not found in target space');
  }
  const [row] = await db.insert(messages).values({
    org_id: ctx.org_id,
    space_id: args.space_id,
    user_id: ctx.user_id,
    content: args.content,
    parent_id: args.parent_id ?? null,
  }).returning();
  return textResult(row);
}

export async function humanThreadFetch(args: { parent_message_id?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:messages');
  if (scopeError) return scopeError;
  if (!args.parent_message_id) return errorResult('thread_fetch requires parent_message_id');
  const [parent] = await db.select().from(messages).where(and(eq(messages.id, args.parent_message_id), eq(messages.org_id, ctx.org_id), eq(messages.is_deleted, false))).limit(1);
  if (!parent || !(await userCanSeeSpace(ctx, parent.space_id))) return errorResult('thread_fetch: thread not visible');
  const replies = await db.select().from(messages).where(and(eq(messages.parent_id, parent.id), eq(messages.org_id, ctx.org_id), eq(messages.is_deleted, false))).orderBy(desc(messages.created_at)).limit(Math.min(Math.max(1, args.limit ?? 100), 200));
  return textResult({ parent, replies: replies.reverse() });
}

export async function humanMemberList(_args: {}, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: orgMembers.role, is_agent: users.is_agent })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(eq(orgMembers.org_id, ctx.org_id), eq(orgMembers.is_active, true)));
  return textResult(rows);
}

export async function humanMessagesSearch(args: { query?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:messages');
  if (scopeError) return scopeError;
  const query = (args.query ?? '').trim().toLowerCase();
  if (!query) return errorResult('messages_search requires query');
  const pattern = `%${query}%`;
  const rows = await db.execute(sql`
    SELECT m.id, m.space_id, s.name AS space_name, m.user_id, u.name AS user_name, m.content, m.parent_id, m.created_at
    FROM messages m
    JOIN spaces s ON s.id = m.space_id AND s.org_id = ${ctx.org_id}
    JOIN users u ON u.id = m.user_id
    LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ${ctx.user_id}
    WHERE m.org_id = ${ctx.org_id}
      AND m.is_deleted = false
      AND lower(m.content) LIKE ${pattern}
      AND (s.type = 'public' OR sm.id IS NOT NULL)
    ORDER BY m.created_at DESC
    LIMIT ${Math.min(Math.max(1, args.limit ?? 20), 50)}
  `);
  return textResult((rows as any).rows ?? []);
}

export async function humanProjectProgress(args: { project_id?: string; project_name?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:tasks');
  if (scopeError) return scopeError;
  const projectWhere = args.project_id
    ? sql`p.id = ${args.project_id}`
    : args.project_name
      ? sql`lower(p.name) = ${args.project_name.toLowerCase()}`
      : sql`true`;
  const rows = await db.execute(sql`
    SELECT p.id, p.name, p.prefix, t.status, count(t.id)::int AS count
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
      AND t.org_id = p.org_id
      AND t.is_deleted = false
      AND (
        coalesce(t.metadata->>'visibility', 'org') != 'restricted'
        OR t.assignee_id = ${ctx.user_id}
        OR t.created_by = ${ctx.user_id}
        OR p.lead_id = ${ctx.user_id}
        OR coalesce(t.metadata->'visible_user_ids', '[]'::jsonb) ? ${ctx.user_id}
        OR exists (select 1 from task_watchers tw where tw.task_id = t.id and tw.user_id = ${ctx.user_id})
        OR exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = ${ctx.user_id})
      )
    WHERE p.org_id = ${ctx.org_id}
      AND p.is_deleted = false
      AND ${projectWhere}
    GROUP BY p.id, p.name, p.prefix, t.status
    ORDER BY p.updated_at DESC
    LIMIT 30
  `);
  return textResult((rows as any).rows ?? []);
}

export async function humanTeamWorkload(args: { days?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:tasks');
  if (scopeError) return scopeError;
  const days = Math.min(Math.max(1, args.days ?? 7), 90);
  const rows = await db.execute(sql`
    SELECT u.id AS user_id, u.name, count(t.id)::int AS open_tasks
    FROM users u
    JOIN org_members om ON om.user_id = u.id AND om.org_id = ${ctx.org_id} AND om.is_active = true
    LEFT JOIN tasks t ON t.assignee_id = u.id
      AND t.org_id = ${ctx.org_id}
      AND t.is_deleted = false
      AND t.status NOT IN ('done', 'cancelled')
    LEFT JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
    WHERE u.is_agent = false
      AND (
        t.id IS NULL
        OR coalesce(t.metadata->>'visibility', 'org') != 'restricted'
        OR t.assignee_id = ${ctx.user_id}
        OR t.created_by = ${ctx.user_id}
        OR p.lead_id = ${ctx.user_id}
        OR coalesce(t.metadata->'visible_user_ids', '[]'::jsonb) ? ${ctx.user_id}
        OR exists (select 1 from task_watchers tw where tw.task_id = t.id and tw.user_id = ${ctx.user_id})
        OR exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = ${ctx.user_id})
      )
    GROUP BY u.id, u.name
    ORDER BY open_tasks DESC, u.name ASC
    LIMIT 50
  `);
  return textResult({ days, workload: (rows as any).rows ?? [] });
}

export async function humanEventsQuery(args: { limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireAnyScope(ctx, ['read:calendar', 'read:workspace']);
  if (scopeError) return scopeError;
  const rows = await db.execute(sql`
    SELECT events.id, events.event_type, events.source, events.title, events.body, events.url, events.actor, events.timestamp, events.metadata, events.created_at
    FROM events
    LEFT JOIN connected_accounts ca ON ca.id = events.connected_account_id
    WHERE events.org_id = ${ctx.org_id}
      AND (events.user_id = ${ctx.user_id} OR ca.user_id = ${ctx.user_id})
    ORDER BY events.timestamp DESC NULLS LAST, events.created_at DESC
    LIMIT ${Math.min(Math.max(1, args.limit ?? 50), 200)}
  `);
  return textResult((rows as any).rows ?? []);
}

function withoutCallerSlug(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema));
  if (clone?.inputSchema?.properties) delete clone.inputSchema.properties.caller_employee_slug;
  if (Array.isArray(clone?.inputSchema?.required)) {
    clone.inputSchema.required = clone.inputSchema.required.filter((r: string) => r !== 'caller_employee_slug');
  }
  return clone;
}

export function buildHumanToolSchemas(agentSchemas: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const compatibilitySchemas = [
    {
      name: 'search',
      title: 'Search Deft',
      description: 'Search Deft wiki, tasks, visible messages, and calendar context. Human personal-MCP read: scoped to the token owner.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
    },
    {
      name: 'fetch',
      title: 'Fetch Deft Result',
      description: 'Fetch a result returned by search by stable id, such as wiki:slug, task:id, message:id, or event:id. Human personal-MCP read: scoped to the token owner.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'list_my_tasks',
      title: 'List My Deft Tasks',
      description: 'List tasks assigned to the connected human user. Human personal-MCP read: scoped to the token owner and requires read:tasks.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Optional task status filter, such as todo, in_progress, in_review, done, or cancelled.' },
          include_completed: { type: 'boolean', description: 'Include done and cancelled tasks. Defaults to false.' },
          filter: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              project_id: { type: 'string' },
            },
            additionalProperties: false,
          },
          limit: { type: 'number', minimum: 1, maximum: 50 },
        },
      },
    },
    {
      name: 'comment_on_task',
      title: 'Comment On Deft Task',
      description: 'Add a comment to a visible task as the connected human user. Human personal-MCP write: requires write:tasks.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['task_id', 'content'],
      },
    },
  ];
  const existing = agentSchemas
    .filter((schema) => {
      const name = String(schema.name ?? '');
      return HUMAN_READ_TOOLS.has(name) || HUMAN_WRITE_TOOLS.has(name);
    })
    .map((schema) => {
      const next = withoutCallerSlug(schema);
      if (HUMAN_WRITE_TOOLS.has(String(next.name))) {
        next.description = `${next.description ?? ''} Human personal-MCP write: executes as the token owner and requires a matching write scope.`;
        next.annotations = { ...(next.annotations as Record<string, unknown> | undefined), readOnlyHint: false, destructiveHint: false };
      } else {
        next.description = `${next.description ?? ''} Human personal-MCP read: scoped to the token owner's Deft permissions.`;
        next.annotations = { ...(next.annotations as Record<string, unknown> | undefined), readOnlyHint: true };
      }
      return next;
    });
  const existingNames = new Set(existing.map((schema) => String(schema.name ?? '')));
  return [
    ...compatibilitySchemas.filter((schema) => !existingNames.has(schema.name)),
    ...existing,
  ];
}
