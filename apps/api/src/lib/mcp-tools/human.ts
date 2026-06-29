import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  connectedAccounts,
  events,
  messages,
  oauthAuditEvents,
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
import { reserveNextTaskNumber } from '../task-numbering.js';

export type HumanToolContext = {
  org_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  scopes: string[];
  token_id?: string;
  client_id?: string;
  grant_id?: string;
  principal_kind?: 'human' | 'oauth';
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

async function userIsSpaceMember(ctx: HumanToolContext, spaceId: string): Promise<boolean> {
  const [member] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
    .where(and(
      eq(spaceMembers.space_id, spaceId),
      eq(spaceMembers.user_id, ctx.user_id),
      eq(spaces.org_id, ctx.org_id),
    ))
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
  'task_get',
  'task_query',
  'project_list',
  'project_get',
  'space_list',
  'space_get',
  'thread_fetch',
  'member_list',
  'member_get',
  'activity_query',
  'events_query',
  'messages_search',
  'project_progress',
  'team_workload',
]);

export const HUMAN_WRITE_TOOLS = new Set([
  'memory_write',
  'task_create',
  'task_update',
  'task_transition',
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
  task_get: humanTaskGet,
  memory_write: humanMemoryWrite,
  task_query: humanTaskQuery,
  project_list: humanProjectList,
  project_get: humanProjectGet,
  space_list: humanSpaceList,
  space_get: humanSpaceGet,
  task_create: humanTaskCreate,
  task_update: humanTaskUpdate,
  task_transition: humanTaskTransition,
  comment_on_task: humanCommentOnTask,
  message_post: humanMessagePost,
  thread_fetch: humanThreadFetch,
  member_list: humanMemberList,
  member_get: humanMemberGet,
  activity_query: humanActivityQuery,
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

function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!key) return null;
  return key.slice(0, 160);
}

function storedToolResult(value: unknown): ToolResult | null {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as Partial<ToolResult>;
  if (!Array.isArray(maybe.content)) return null;
  if (!maybe.content.every((item) => item && item.type === 'text' && typeof item.text === 'string')) return null;
  return { content: maybe.content, isError: maybe.isError };
}

function normalizedText(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined && key !== 'idempotency_key')
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function fallbackDedupeInput(toolName: string, args: Record<string, unknown>): Record<string, unknown> | null {
  switch (toolName) {
    case 'task_create':
      return {
        title: normalizedText(args.title),
        project_id: args.project_id ?? null,
        assignee_id: args.assignee_id ?? null,
        priority: args.priority ?? null,
      };
    case 'task_update':
      return { task_id: args.task_id ?? null, patch: args.patch ?? null };
    case 'task_transition':
      return { task_id: args.task_id ?? null, status: args.status ?? null };
    case 'comment_on_task':
      return { task_id: args.task_id ?? null, content: normalizedText(args.content) };
    case 'message_post':
      return { space_id: args.space_id ?? null, parent_id: args.parent_id ?? null, content: normalizedText(args.content) };
    default:
      return null;
  }
}

function fallbackDedupeSignature(toolName: string, args: Record<string, unknown>): string | null {
  const input = fallbackDedupeInput(toolName, args);
  if (!input) return null;
  return createHash('sha256').update(`${toolName}:${stableJson(input)}`).digest('hex');
}

async function withIdempotency(
  toolName: string,
  args: { idempotency_key?: unknown } & Record<string, unknown>,
  ctx: HumanToolContext,
  execute: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const idempotencyKey = normalizeIdempotencyKey(args.idempotency_key);
  const fallbackSignature = idempotencyKey ? null : fallbackDedupeSignature(toolName, args);

  const clientId = ctx.client_id ?? `personal-token:${ctx.token_id ?? 'unknown'}`;
  if (idempotencyKey || fallbackSignature) {
    const [existing] = await db
      .select({ metadata: oauthAuditEvents.metadata })
      .from(oauthAuditEvents)
      .where(and(
        eq(oauthAuditEvents.org_id, ctx.org_id),
        eq(oauthAuditEvents.user_id, ctx.user_id),
        eq(oauthAuditEvents.client_id, clientId),
        eq(oauthAuditEvents.event, 'mcp_idempotency_result'),
        sql`${oauthAuditEvents.metadata}->>'tool_name' = ${toolName}`,
        idempotencyKey
          ? sql`${oauthAuditEvents.metadata}->>'idempotency_key' = ${idempotencyKey}`
          : sql`${oauthAuditEvents.metadata}->>'fallback_signature' = ${fallbackSignature} AND ${oauthAuditEvents.created_at} >= now() - interval '2 minutes'`,
      ))
      .orderBy(desc(oauthAuditEvents.created_at))
      .limit(1);
    const replay = storedToolResult(existing?.metadata?.result);
    if (replay) return replay;
  }

  const result = await execute();
  if (!result.isError && (idempotencyKey || fallbackSignature)) {
    await db.insert(oauthAuditEvents).values({
      org_id: ctx.org_id,
      user_id: ctx.user_id,
      client_id: clientId,
      event: 'mcp_idempotency_result',
      metadata: {
        tool_name: toolName,
        idempotency_key: idempotencyKey ?? null,
        fallback_signature: fallbackSignature,
        fallback_window_seconds: fallbackSignature ? 120 : null,
        grant_id: ctx.grant_id ?? null,
        principal_kind: ctx.principal_kind ?? 'human',
        result,
      },
    });
  }
  return result;
}

function taskReference(projectPrefix: string | null, number: number | null): string | null {
  if (!projectPrefix || !number) return null;
  return `${projectPrefix}-${number}`;
}

function validTaskStatus(value: unknown): value is 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled' {
  return typeof value === 'string' && ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'].includes(value);
}

type HumanTriggerDescriptor = {
  kind?: string;
  space_id?: string | null;
  triggering_message_id?: string | null;
  [key: string]: unknown;
};

type HumanWikiSnippet = {
  source_id?: string;
  slug: string;
  title: string;
  summary: string | null;
  type: string;
  confidence: number;
  scope?: string | null;
  tier?: string | null;
  space_id?: string | null;
  origin_space_id?: string | null;
  origin_message_id?: string | null;
  created_via?: string | null;
  matched_space_id?: string | null;
  agent_employee_id?: string | null;
};

function humanSnippetFromContextResult(result: ContextResult): HumanWikiSnippet {
  return {
    source_id: result.source_id,
    slug: String(result.metadata?.slug ?? ''),
    title: result.title,
    summary: (result.metadata?.summary as string | null) ?? null,
    type: String(result.metadata?.type ?? 'fact'),
    confidence: result.confidence ?? 0,
    scope: result.scope ?? null,
    tier: (result.metadata?.tier as string | null) ?? null,
    space_id: (result.metadata?.space_id as string | null) ?? null,
    origin_space_id: (result.metadata?.origin_space_id as string | null) ?? null,
    origin_message_id: (result.metadata?.origin_message_id as string | null) ?? null,
    created_via: (result.metadata?.created_via as string | null) ?? null,
    matched_space_id: (result.metadata?.matched_space_id as string | null) ?? null,
    agent_employee_id: (result.metadata?.agent_employee_id as string | null) ?? null,
  };
}

function humanIsChannelSnippet(snippet: HumanWikiSnippet, spaceId: string | null | undefined): boolean {
  if (!spaceId) return false;
  return (
    snippet.space_id === spaceId ||
    snippet.origin_space_id === spaceId ||
    snippet.matched_space_id === spaceId ||
    (snippet.scope === 'space' && snippet.space_id === spaceId)
  );
}

function humanIsPersonalSnippet(snippet: HumanWikiSnippet): boolean {
  return snippet.scope === 'user' && !snippet.agent_employee_id;
}

function humanWikiPageMatchesSpaceExpr(orgId: string, spaceId: string) {
  return sql<boolean>`(
    ${wikiPages.space_id} = ${spaceId}
    OR ${wikiPages.origin_space_id} = ${spaceId}
    OR EXISTS (
      SELECT 1
      FROM wiki_citations wc
      LEFT JOIN messages m
        ON m.id = wc.source_id
       AND wc.source_type = 'message'
      WHERE wc.page_id = ${wikiPages.id}
        AND (
          wc.source_space_id = ${spaceId}
          OR (m.space_id = ${spaceId} AND m.org_id = ${orgId})
        )
    )
  )`;
}

function humanMatchedSpaceIdExpr(orgId: string, spaceId: string | null | undefined) {
  if (!spaceId) return sql<string | null>`NULL`;
  return sql<string | null>`CASE WHEN ${humanWikiPageMatchesSpaceExpr(orgId, spaceId)} THEN ${spaceId} ELSE NULL END`;
}

function buildHumanContextPackets(snippets: HumanWikiSnippet[], trigger?: HumanTriggerDescriptor) {
  const spaceId = trigger?.space_id ?? null;
  const channelItems = spaceId ? snippets.filter((snippet) => humanIsChannelSnippet(snippet, spaceId)) : [];
  const personalItems = snippets.filter(humanIsPersonalSnippet);
  const companyItems = snippets.filter((snippet) => {
    if (humanIsPersonalSnippet(snippet)) return false;
    if (humanIsChannelSnippet(snippet, spaceId)) return false;
    return snippet.scope === 'org' || snippet.tier === 'org' || !snippet.scope;
  });

  const packets: Array<Record<string, unknown>> = [
    {
      id: 'company_memory',
      scope: 'org',
      label: 'Company memory',
      description: 'Org-wide knowledge useful across channels and teams.',
      retrieval_hint: {
        tool: 'memory_recall',
        args_template: { query: '<query>', scope: 'org' },
      },
      item_count: companyItems.length,
      items: companyItems,
    },
  ];

  if (spaceId) {
    packets.push({
      id: `space:${spaceId}:memory`,
      scope: 'space',
      label: 'Channel memory',
      description: 'Knowledge created in, scoped to, or cited from the current channel.',
      space_id: spaceId,
      retrieval_hint: {
        tool: 'memory_recall',
        args_template: {
          query: '<query>',
          space_id: spaceId,
          include_org: false,
          scope: 'all',
        },
      },
      item_count: channelItems.length,
      items: channelItems,
    });
  }

  packets.push({
    id: 'personal_memory',
    scope: 'user',
    label: 'Personal memory',
    description: 'Knowledge scoped to the connected human user.',
    retrieval_hint: {
      tool: 'memory_recall',
      args_template: { query: '<query>', scope: 'own' },
    },
    item_count: personalItems.length,
    items: personalItems,
  });

  return packets;
}

function mergeHumanWikiSnippets(existing: HumanWikiSnippet[], additions: HumanWikiSnippet[]): HumanWikiSnippet[] {
  const seen = new Set(existing.map((snippet) => snippet.source_id ?? snippet.slug));
  const merged = [...existing];
  for (const snippet of additions) {
    const key = snippet.source_id ?? snippet.slug;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(snippet);
  }
  return merged;
}

export async function humanPlatformContext(args: { trigger?: HumanTriggerDescriptor }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const trigger = args.trigger;
  const spaceId = trigger?.space_id?.trim() || undefined;
  if (spaceId && !(await userCanSeeSpace(ctx, spaceId))) {
    return errorResult(`platform_context: user cannot access space ${spaceId}`);
  }

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

  let queryText = '';
  if (hasScope(ctx, 'read:wiki') && trigger?.triggering_message_id) {
    const [msg] = await db
      .select({ content: messages.content, space_id: messages.space_id })
      .from(messages)
      .where(and(eq(messages.id, trigger.triggering_message_id), eq(messages.org_id, ctx.org_id), eq(messages.is_deleted, false)))
      .limit(1);
    if (msg && (await userCanSeeSpace(ctx, msg.space_id))) {
      queryText = msg.content;
    }
  }

  let wikiSnippets: HumanWikiSnippet[] = [];
  if (hasScope(ctx, 'read:wiki')) {
    try {
      if (queryText.trim()) {
        const results = await retrieveContext({
          query: queryText,
          org_id: ctx.org_id,
          user_id: ctx.user_id,
          space_id: spaceId,
          include_org: true,
          types: ['wiki'],
          limit: 8,
          hybrid: false,
        });
        wikiSnippets = results
          .filter((row) => row.source_type === 'wiki_page')
          .map(humanSnippetFromContextResult);
        if (spaceId) {
          const personalResults = await retrieveContext({
            query: queryText,
            org_id: ctx.org_id,
            user_id: ctx.user_id,
            types: ['wiki'],
            limit: 3,
            hybrid: false,
          });
          wikiSnippets = mergeHumanWikiSnippets(
            wikiSnippets,
            personalResults
              .filter((row) => row.source_type === 'wiki_page')
              .map(humanSnippetFromContextResult)
              .filter(humanIsPersonalSnippet),
          );
        }
      } else {
        const orderBy = spaceId
          ? [
              desc(sql<number>`CASE WHEN ${humanWikiPageMatchesSpaceExpr(ctx.org_id, spaceId)} THEN 1 ELSE 0 END`),
              desc(wikiPages.confidence),
              desc(wikiPages.updated_at),
            ]
          : [desc(wikiPages.confidence), desc(wikiPages.updated_at)];
        const rows = await db
          .select({
            id: wikiPages.id,
            slug: wikiPages.slug,
            title: wikiPages.title,
            summary: wikiPages.summary,
            type: wikiPages.type,
            confidence: wikiPages.confidence,
            scope: wikiPages.scope,
            space_id: wikiPages.space_id,
            origin_space_id: wikiPages.origin_space_id,
            origin_message_id: wikiPages.origin_message_id,
            created_via: wikiPages.created_via,
            matched_space_id: humanMatchedSpaceIdExpr(ctx.org_id, spaceId),
            agent_employee_id: wikiPages.agent_employee_id,
          })
          .from(wikiPages)
          .where(and(
            eq(wikiPages.org_id, ctx.org_id),
            eq(wikiPages.is_deleted, false),
            visibleWikiPageCondition(ctx.user_id),
            or(
              eq(wikiPages.scope, 'org'),
              and(eq(wikiPages.scope, 'user'), eq(wikiPages.user_id, ctx.user_id)),
              spaceId
                ? or(
                    and(eq(wikiPages.scope, 'space'), eq(wikiPages.space_id, spaceId)),
                    eq(wikiPages.origin_space_id, spaceId),
                  )
                : undefined,
            ),
          ))
          .orderBy(...orderBy)
          .limit(10);
        wikiSnippets = rows.map((row) => ({
          source_id: row.id,
          slug: row.slug,
          title: row.title,
          summary: row.summary,
          type: row.type,
          confidence: row.confidence,
          scope: row.scope,
          tier: row.scope === 'org' ? 'org' : row.scope === 'user' ? 'user' : null,
          space_id: row.space_id,
          origin_space_id: row.origin_space_id,
          origin_message_id: row.origin_message_id,
          created_via: row.created_via,
          matched_space_id: row.matched_space_id,
          agent_employee_id: row.agent_employee_id,
        }));
      }
    } catch (err) {
      console.warn('[human-mcp] platform_context wiki packet build failed:', err);
      wikiSnippets = [];
    }
  }

  return textResult({
    generated_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    org,
    user: { ...me, role: ctx.role },
    teammates,
    active_projects: activeProjects,
    relevant_wiki_snippets: wikiSnippets,
    context_packets: hasScope(ctx, 'read:wiki') ? buildHumanContextPackets(wikiSnippets, trigger) : [],
    trigger_context: trigger ?? null,
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

export async function humanMemoryRecall(
  args: { query?: string; limit?: number; space_id?: string; include_org?: boolean; scope?: 'own' | 'org' | 'all' },
  ctx: HumanToolContext,
): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:wiki');
  if (scopeError) return scopeError;
  const query = (args.query ?? '').trim();
  if (!query) return errorResult('memory_recall requires query');
  const limit = Math.min(Math.max(1, args.limit ?? 10), 25);
  const spaceId = args.space_id?.trim() || undefined;
  const includeOrg = args.include_org !== false;
  if (spaceId && !(await userCanSeeSpace(ctx, spaceId))) {
    return errorResult(`memory_recall: user cannot access space ${spaceId}`);
  }

  const rows = await retrieveContext({
    query,
    org_id: ctx.org_id,
    user_id: ctx.user_id,
    space_id: spaceId,
    include_org: includeOrg,
    types: ['wiki'],
    limit,
    hybrid: false,
  });
  const scope = args.scope ?? 'all';

  return textResult(rows
    .filter((row) => row.source_type === 'wiki_page')
    .filter((row) => {
      if (scope === 'all') return true;
      if (scope === 'org') return row.scope === 'org';
      return row.scope === 'user';
    })
    .map((row) => {
      const content = row.content ?? '';
      const truncated = content.length > 2000;
      return {
        slug: row.metadata?.slug ?? '',
        title: row.title,
        summary: row.metadata?.summary ?? null,
        content: truncated ? content.slice(0, 2000) : content,
        truncated,
        type: row.metadata?.type ?? '',
        confidence: row.confidence ?? 1.0,
        space_id: row.metadata?.space_id ?? null,
        origin_space_id: row.metadata?.origin_space_id ?? null,
        origin_message_id: row.metadata?.origin_message_id ?? null,
        created_via: row.metadata?.created_via ?? null,
        matched_space_id: row.metadata?.matched_space_id ?? null,
      };
    }));
}

export async function humanMemoryList(args: { type?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:wiki');
  if (scopeError) return scopeError;
  const limit = Math.min(Math.max(1, args.limit ?? 25), 100);
  const conditions = [eq(wikiPages.org_id, ctx.org_id), eq(wikiPages.is_deleted, false), visibleWikiPageCondition(ctx.user_id)];
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

export async function humanTaskGet(args: { task_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:tasks');
  if (scopeError) return scopeError;
  if (!args.task_id) return errorResult('task_get requires task_id');
  if (!(await userCanSeeTask(ctx, args.task_id))) return errorResult('task_get: task not found');
  const taskRows = await db.execute(sql`
    SELECT
      t.*,
      p.name AS project_name,
      p.prefix AS project_prefix,
      (p.prefix || '-' || t.number) AS task_key,
      assignee.name AS assignee_name,
      assignee.email AS assignee_email,
      creator.name AS created_by_name,
      creator.email AS created_by_email
    FROM tasks t
    JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
    LEFT JOIN users assignee ON assignee.id = t.assignee_id
    LEFT JOIN users creator ON creator.id = t.created_by
    WHERE t.org_id = ${ctx.org_id}
      AND t.id = ${args.task_id}
      AND t.is_deleted = false
    LIMIT 1
  `);
  const task = ((taskRows as any).rows ?? [])[0];
  if (!task) return errorResult('task_get: task not found');
  const comments = await db.execute(sql`
    SELECT c.id, c.user_id, u.name AS user_name, u.email AS user_email, c.content, c.created_at
    FROM task_comments c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.org_id = ${ctx.org_id}
      AND c.task_id = ${args.task_id}
    ORDER BY c.created_at DESC
    LIMIT 10
  `);
  const activity = await db.execute(sql`
    SELECT a.id, a.user_id, u.name AS user_name, u.email AS user_email, a.action, a.field, a.old_value, a.new_value, a.created_at
    FROM task_activity a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.org_id = ${ctx.org_id}
      AND a.task_id = ${args.task_id}
    ORDER BY a.created_at DESC
    LIMIT 10
  `);
  return textResult({
    task,
    recent_comments: ((comments as any).rows ?? []).reverse(),
    recent_activity: ((activity as any).rows ?? []).reverse(),
  });
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

export async function humanProjectList(args: { query?: string; include_archived?: boolean; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const query = (args.query ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(1, args.limit ?? 50), 100);
  const rows = await db.execute(sql`
    SELECT p.id, p.name, p.prefix, p.lead_id, lead.name AS lead_name, p.is_archived, p.created_at, p.updated_at,
           count(t.id) FILTER (WHERE t.is_deleted = false AND t.status NOT IN ('done', 'cancelled'))::int AS open_tasks
    FROM projects p
    LEFT JOIN users lead ON lead.id = p.lead_id
    LEFT JOIN tasks t ON t.project_id = p.id AND t.org_id = p.org_id
    WHERE p.org_id = ${ctx.org_id}
      AND p.is_deleted = false
      AND (${args.include_archived ? sql`true` : sql`p.is_archived = false`})
      AND (${query ? sql`lower(p.name) LIKE ${`%${query}%`} OR lower(p.prefix) LIKE ${`%${query}%`}` : sql`true`})
    GROUP BY p.id, p.name, p.prefix, p.lead_id, lead.name, p.is_archived, p.created_at, p.updated_at
    ORDER BY p.updated_at DESC
    LIMIT ${limit}
  `);
  return textResult((rows as any).rows ?? []);
}

export async function humanProjectGet(args: { project_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  if (!args.project_id) return errorResult('project_get requires project_id');
  if (!(await userCanSeeProject(ctx, args.project_id))) return errorResult('project_get: project not found');
  const rows = await db.execute(sql`
    SELECT p.id, p.name, p.prefix, p.description, p.lead_id, lead.name AS lead_name, p.is_archived, p.created_at, p.updated_at,
           count(t.id) FILTER (WHERE t.is_deleted = false)::int AS total_tasks,
           count(t.id) FILTER (WHERE t.is_deleted = false AND t.status NOT IN ('done', 'cancelled'))::int AS open_tasks,
           count(t.id) FILTER (WHERE t.is_deleted = false AND t.status = 'done')::int AS done_tasks
    FROM projects p
    LEFT JOIN users lead ON lead.id = p.lead_id
    LEFT JOIN tasks t ON t.project_id = p.id AND t.org_id = p.org_id
    WHERE p.org_id = ${ctx.org_id}
      AND p.id = ${args.project_id}
      AND p.is_deleted = false
    GROUP BY p.id, p.name, p.prefix, p.description, p.lead_id, lead.name, p.is_archived, p.created_at, p.updated_at
    LIMIT 1
  `);
  const project = ((rows as any).rows ?? [])[0];
  if (!project) return errorResult('project_get: project not found');
  const linkedSpaces = await db.execute(sql`
    SELECT s.id, s.name, s.type
    FROM project_spaces ps
    JOIN spaces s ON s.id = ps.space_id AND s.org_id = ${ctx.org_id}
    LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ${ctx.user_id}
    WHERE ps.project_id = ${args.project_id}
      AND (s.type = 'public' OR sm.id IS NOT NULL)
      AND s.is_archived = false
    ORDER BY s.name ASC
  `);
  return textResult({ project, linked_spaces: (linkedSpaces as any).rows ?? [] });
}

export async function humanSpaceList(args: { query?: string; type?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:messages');
  if (scopeError) return scopeError;
  const query = (args.query ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(1, args.limit ?? 50), 100);
  const rows = await db.execute(sql`
    SELECT s.id, s.name, s.type, s.description, s.is_default, s.created_at, s.updated_at,
           count(sm_all.id)::int AS member_count
    FROM spaces s
    LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ${ctx.user_id}
    LEFT JOIN space_members sm_all ON sm_all.space_id = s.id
    WHERE s.org_id = ${ctx.org_id}
      AND s.is_archived = false
      AND (s.type = 'public' OR sm.id IS NOT NULL)
      AND (${args.type ? sql`s.type = ${args.type}` : sql`true`})
      AND (${query ? sql`lower(s.name) LIKE ${`%${query}%`} OR lower(coalesce(s.description, '')) LIKE ${`%${query}%`}` : sql`true`})
    GROUP BY s.id, s.name, s.type, s.description, s.is_default, s.created_at, s.updated_at
    ORDER BY s.is_default DESC, s.name ASC
    LIMIT ${limit}
  `);
  return textResult((rows as any).rows ?? []);
}

export async function humanSpaceGet(args: { space_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:messages');
  if (scopeError) return scopeError;
  if (!args.space_id) return errorResult('space_get requires space_id');
  if (!(await userCanSeeSpace(ctx, args.space_id))) return errorResult('space_get: space not found');
  const rows = await db.execute(sql`
    SELECT s.id, s.name, s.type, s.description, s.is_default, s.created_at, s.updated_at
    FROM spaces s
    WHERE s.org_id = ${ctx.org_id}
      AND s.id = ${args.space_id}
      AND s.is_archived = false
    LIMIT 1
  `);
  const space = ((rows as any).rows ?? [])[0];
  if (!space) return errorResult('space_get: space not found');
  const members = await db.execute(sql`
    SELECT u.id, u.name, u.email, u.is_agent
    FROM space_members sm
    JOIN users u ON u.id = sm.user_id
    WHERE sm.space_id = ${args.space_id}
    ORDER BY u.name ASC
    LIMIT 100
  `);
  return textResult({ space, members: (members as any).rows ?? [] });
}

export async function humanTaskCreate(args: { title?: string; description?: string; project_id?: string; assignee_id?: string; priority?: string; idempotency_key?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:tasks');
  if (scopeError) return scopeError;
  const title = args.title?.trim();
  if (!title) return errorResult('task_create requires title');
  return withIdempotency('task_create', args, ctx, async () => {
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
    let taskNumber: number;
    try {
      taskNumber = await reserveNextTaskNumber({ projectId, orgId: ctx.org_id });
    } catch {
      return errorResult('task_create: project not found');
    }
    const [task] = await db.insert(tasks).values({
      org_id: ctx.org_id,
      project_id: projectId,
      number: taskNumber,
      title,
      description: args.description ?? null,
      priority: ['p0', 'p1', 'p2', 'p3'].includes(args.priority ?? '') ? args.priority as any : 'p2',
      assignee_id: args.assignee_id ?? null,
      created_by: ctx.user_id,
    }).returning();
    if (task) {
      await db.insert(taskActivity).values({ org_id: ctx.org_id, task_id: task.id, user_id: ctx.user_id, action: 'created' });
    }
    return textResult(task);
  });
}

export async function humanTaskUpdate(args: { task_id?: string; patch?: Record<string, unknown>; idempotency_key?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:tasks');
  if (scopeError) return scopeError;
  if (!args.task_id) return errorResult('task_update requires task_id');
  const taskId = args.task_id;
  return withIdempotency('task_update', args, ctx, async () => {
    const patch = args.patch ?? {};
    const updates: Record<string, unknown> = {};
    if (typeof patch.title === 'string') updates.title = patch.title;
    if (typeof patch.description === 'string') updates.description = patch.description;
    if (patch.status !== undefined) {
      if (!validTaskStatus(patch.status)) return errorResult('task_update requires valid status: backlog, todo, in_progress, in_review, done, or cancelled');
      updates.status = patch.status;
    }
    if (typeof patch.priority === 'string') updates.priority = patch.priority;
    if (typeof patch.assignee_id === 'string' || patch.assignee_id === null) updates.assignee_id = patch.assignee_id;
    if (Object.keys(updates).length === 0) return errorResult('task_update requires at least one supported patch field');
    if (!(await userCanSeeTask(ctx, taskId))) return errorResult('task_update: task not found');
    const [existingTask] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.org_id, ctx.org_id), eq(tasks.is_deleted, false))).limit(1);
    if (!existingTask) return errorResult('task_update: task not found');
    if (typeof patch.assignee_id === 'string') {
      const [member] = await db
        .select({ id: orgMembers.id })
        .from(orgMembers)
        .where(and(eq(orgMembers.org_id, ctx.org_id), eq(orgMembers.user_id, patch.assignee_id), eq(orgMembers.is_active, true)))
        .limit(1);
      if (!member) return errorResult('task_update: assignee is not an active org member');
    }
    const [task] = await db.update(tasks).set(updates).where(and(eq(tasks.id, taskId), eq(tasks.org_id, ctx.org_id), eq(tasks.is_deleted, false))).returning();
    if (!task) return errorResult('task_update: task not found');
    const activityEntries: Array<{ action: string; field: string; old_value: string | null; new_value: string | null }> = [];
    if (typeof updates.status === 'string' && updates.status !== existingTask.status) {
      activityEntries.push({ action: 'status_changed', field: 'status', old_value: existingTask.status, new_value: updates.status });
    }
    if (typeof updates.priority === 'string' && updates.priority !== existingTask.priority) {
      activityEntries.push({ action: 'priority_changed', field: 'priority', old_value: existingTask.priority, new_value: updates.priority });
    }
    if ('assignee_id' in updates && updates.assignee_id !== existingTask.assignee_id) {
      activityEntries.push({ action: 'assigned', field: 'assignee_id', old_value: existingTask.assignee_id ?? null, new_value: (updates.assignee_id as string | null) ?? null });
    }
    if (typeof updates.title === 'string' && updates.title !== existingTask.title) {
      activityEntries.push({ action: 'title_changed', field: 'title', old_value: existingTask.title, new_value: updates.title });
    }
    if (typeof updates.description === 'string' && updates.description !== (existingTask.description ?? null)) {
      activityEntries.push({ action: 'description_changed', field: 'description', old_value: existingTask.description ?? null, new_value: updates.description });
    }
    if (activityEntries.length === 0) {
      await db.insert(taskActivity).values({ org_id: ctx.org_id, task_id: task.id, user_id: ctx.user_id, action: 'updated' });
    } else {
      await db.insert(taskActivity).values(activityEntries.map((entry) => ({
        org_id: ctx.org_id,
        task_id: task.id,
        user_id: ctx.user_id,
        action: entry.action,
        field: entry.field,
        old_value: entry.old_value,
        new_value: entry.new_value,
      })));
    }
    return textResult(task);
  });
}

export async function humanTaskTransition(args: { task_id?: string; status?: string; reason?: string; idempotency_key?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:tasks');
  if (scopeError) return scopeError;
  if (!args.task_id) return errorResult('task_transition requires task_id');
  if (!validTaskStatus(args.status)) return errorResult('task_transition requires valid status: backlog, todo, in_progress, in_review, done, or cancelled');
  const taskId = args.task_id;
  const status = args.status;
  return withIdempotency('task_transition', args, ctx, async () => {
    if (!(await userCanSeeTask(ctx, taskId))) return errorResult('task_transition: task not found');
    const [existingTask] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.org_id, ctx.org_id), eq(tasks.is_deleted, false)))
      .limit(1);
    if (!existingTask) return errorResult('task_transition: task not found');
    if (existingTask.status === status) {
      return textResult({ ...existingTask, unchanged: true, task_key: null });
    }
    const [task] = await db
      .update(tasks)
      .set({ status })
      .where(and(eq(tasks.id, taskId), eq(tasks.org_id, ctx.org_id), eq(tasks.is_deleted, false)))
      .returning();
    if (!task) return errorResult('task_transition: task not found');
    const [project] = await db.select({ prefix: projects.prefix }).from(projects).where(eq(projects.id, task.project_id)).limit(1);
    await db.insert(taskActivity).values({
      org_id: ctx.org_id,
      task_id: task.id,
      user_id: ctx.user_id,
      action: 'status_changed',
      field: 'status',
      old_value: existingTask.status,
      new_value: status,
    });
    return textResult({
      ...task,
      task_key: taskReference(project?.prefix ?? null, task.number),
      transition: {
        from: existingTask.status,
        to: status,
        reason: args.reason ?? null,
      },
    });
  });
}

export async function humanCommentOnTask(args: { task_id?: string; content?: string; idempotency_key?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:tasks');
  if (scopeError) return scopeError;
  if (!args.task_id) return errorResult('comment_on_task requires task_id');
  const taskId = args.task_id;
  const content = args.content?.trim();
  if (!content) return errorResult('comment_on_task requires content');
  return withIdempotency('comment_on_task', args, ctx, async () => {
    if (!(await userCanSeeTask(ctx, taskId))) return errorResult('comment_on_task: task not found');
    const [comment] = await db.insert(taskComments).values({
      org_id: ctx.org_id,
      task_id: taskId,
      user_id: ctx.user_id,
      content,
    }).returning();
    await db.insert(taskActivity).values({ org_id: ctx.org_id, task_id: taskId, user_id: ctx.user_id, action: 'commented' });
    return textResult(comment);
  });
}

export async function humanMessagePost(args: { space_id?: string; content?: string; parent_id?: string; idempotency_key?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:messages');
  if (scopeError) return scopeError;
  if (!args.space_id) return errorResult('message_post requires space_id');
  const spaceId = args.space_id;
  const content = args.content?.trim();
  if (!content) return errorResult('message_post requires content');
  return withIdempotency('message_post', args, ctx, async () => {
    if (!(await userCanSeeSpace(ctx, spaceId))) return errorResult('message_post: space not found or not visible to user');
    if (!(await userIsSpaceMember(ctx, spaceId))) return errorResult('message_post: user is not a member of this space');
    if (args.parent_id) {
      const [parent] = await db
        .select({ id: messages.id, space_id: messages.space_id })
        .from(messages)
        .where(and(eq(messages.id, args.parent_id), eq(messages.org_id, ctx.org_id), eq(messages.is_deleted, false)))
        .limit(1);
      if (!parent || parent.space_id !== spaceId) return errorResult('message_post: parent message not found in target space');
    }
    const [row] = await db.insert(messages).values({
      org_id: ctx.org_id,
      space_id: spaceId,
      user_id: ctx.user_id,
      content,
      parent_id: args.parent_id ?? null,
    }).returning();
    return textResult(row);
  });
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

export async function humanMemberList(args: { query?: string; include_agents?: boolean; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const query = (args.query ?? '').trim().toLowerCase();
  const rows = await db.execute(sql`
    SELECT u.id, u.name, u.email, om.role, u.is_agent, om.is_active
    FROM org_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.org_id = ${ctx.org_id}
      AND om.is_active = true
      AND (${args.include_agents === false ? sql`u.is_agent = false` : sql`true`})
      AND (${query ? sql`lower(u.name) LIKE ${`%${query}%`} OR lower(u.email) LIKE ${`%${query}%`}` : sql`true`})
    ORDER BY u.is_agent ASC, u.name ASC
    LIMIT ${Math.min(Math.max(1, args.limit ?? 100), 200)}
  `);
  return textResult((rows as any).rows ?? []);
}

export async function humanMemberGet(args: { user_id?: string; email?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  if (!args.user_id && !args.email) return errorResult('member_get requires user_id or email');
  const rows = await db.execute(sql`
    SELECT u.id, u.name, u.email, om.role, u.is_agent, om.is_active
    FROM org_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.org_id = ${ctx.org_id}
      AND om.is_active = true
      AND (${args.user_id ? sql`u.id = ${args.user_id}` : sql`lower(u.email) = ${args.email!.toLowerCase()}`})
    LIMIT 1
  `);
  const member = ((rows as any).rows ?? [])[0];
  return member ? textResult(member) : errorResult('member_get: member not found');
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

type ProjectProgressArgs = {
  project_id?: string;
  project_identifier?: string;
  project_name?: string;
};

export async function humanProjectProgress(args: ProjectProgressArgs, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:tasks');
  if (scopeError) return scopeError;
  const projectId = args.project_id?.trim();
  const projectIdentifier = args.project_identifier?.trim();
  const projectName = args.project_name?.trim();
  const identifier = projectIdentifier ? projectIdentifier.toLowerCase() : '';
  const prefixIdentifier = identifier.includes('-') ? identifier.split('-')[0] : identifier;
  const hasSpecificProject = Boolean(projectId || projectIdentifier || projectName);
  const projectWhere = projectId
    ? sql`p.id = ${projectId}`
    : projectIdentifier
      ? sql`(lower(p.prefix) = ${prefixIdentifier} OR lower(p.name) = ${identifier} OR p.id = ${projectIdentifier})`
      : projectName
        ? sql`lower(p.name) = ${projectName.toLowerCase()}`
        : sql`true`;
  const rows = await db.execute(sql`
    SELECT
      p.id,
      p.name,
      p.prefix,
      p.updated_at,
      t.status,
      count(t.id)::int AS count,
      count(t.id) FILTER (WHERE t.status = 'done' AND t.updated_at >= now() - interval '7 days')::int AS done_last_7_days
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
    GROUP BY p.id, p.name, p.prefix, p.updated_at, t.status
    ORDER BY p.updated_at DESC
    LIMIT ${hasSpecificProject ? 20 : 200}
  `);
  const summaries = new Map<string, {
    project: { id: string; name: string; prefix: string | null };
    status_counts: Record<string, number>;
    total_tasks: number;
    open_tasks: number;
    done_tasks: number;
    cancelled_tasks: number;
    completion_rate: number;
    recent_velocity: { done_last_7_days: number };
  }>();

  for (const row of ((rows as any).rows ?? []) as Array<Record<string, unknown>>) {
    const id = String(row.id);
    const summary = summaries.get(id) ?? {
      project: { id, name: String(row.name), prefix: row.prefix == null ? null : String(row.prefix) },
      status_counts: {},
      total_tasks: 0,
      open_tasks: 0,
      done_tasks: 0,
      cancelled_tasks: 0,
      completion_rate: 0,
      recent_velocity: { done_last_7_days: 0 },
    };
    const status = row.status == null ? null : String(row.status);
    const count = Number(row.count ?? 0);
    if (status && count > 0) {
      summary.status_counts[status] = count;
      summary.total_tasks += count;
      if (status === 'done') summary.done_tasks += count;
      else if (status === 'cancelled') summary.cancelled_tasks += count;
      else summary.open_tasks += count;
    }
    summary.recent_velocity.done_last_7_days += Number(row.done_last_7_days ?? 0);
    summaries.set(id, summary);
  }

  const result = Array.from(summaries.values()).map((summary) => ({
    ...summary,
    completion_rate: summary.total_tasks > 0 ? Number((summary.done_tasks / summary.total_tasks).toFixed(2)) : 0,
  }));

  if (hasSpecificProject) {
    if (!result[0]) return errorResult('project_progress: project not found');
    return textResult(result[0]);
  }

  return textResult({ projects: result });
}

export async function humanActivityQuery(args: { limit?: number; tool_name?: string; since?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const limit = Math.min(Math.max(1, args.limit ?? 25), 100);
  const toolName = args.tool_name?.trim();
  const since = args.since && !Number.isNaN(Date.parse(args.since)) ? new Date(args.since) : null;
  const rows = await db.execute(sql`
    SELECT id, client_id, event, metadata, created_at
    FROM oauth_audit_events
    WHERE org_id = ${ctx.org_id}
      AND user_id = ${ctx.user_id}
      AND event IN ('mcp_tool_call', 'mcp_idempotency_result', 'token_issued', 'grant_revoked', 'token_revoked')
      AND (${toolName ? sql`metadata->>'tool_name' = ${toolName}` : sql`true`})
      AND (${since ? sql`created_at >= ${since}` : sql`true`})
    ORDER BY created_at DESC
    LIMIT ${limit}
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
      name: 'task_get',
      title: 'Get Deft Task',
      description: 'Fetch one visible task by id, including project key, assignee, recent comments, and recent activity. Human personal-MCP read: requires read:tasks.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
    {
      name: 'project_list',
      title: 'List Deft Projects',
      description: 'List active projects in the connected user workspace. Human personal-MCP read: requires read:workspace.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          include_archived: { type: 'boolean' },
          limit: { type: 'number', minimum: 1, maximum: 100 },
        },
      },
    },
    {
      name: 'project_get',
      title: 'Get Deft Project',
      description: 'Fetch one project by id, including task counts and linked visible spaces. Human personal-MCP read: requires read:workspace.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { project_id: { type: 'string' } },
        required: ['project_id'],
      },
    },
    {
      name: 'space_list',
      title: 'List Deft Spaces',
      description: 'List public spaces and private spaces the connected user can access. Human personal-MCP read: requires read:messages.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          type: { type: 'string', description: 'Optional space type such as public, private, or dm.' },
          limit: { type: 'number', minimum: 1, maximum: 100 },
        },
      },
    },
    {
      name: 'space_get',
      title: 'Get Deft Space',
      description: 'Fetch one visible space by id, including members. Human personal-MCP read: requires read:messages.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { space_id: { type: 'string' } },
        required: ['space_id'],
      },
    },
    {
      name: 'member_get',
      title: 'Get Deft Member',
      description: 'Fetch one active org member by user_id or email. Human personal-MCP read: requires read:workspace.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          email: { type: 'string' },
        },
      },
    },
    {
      name: 'activity_query',
      title: 'Query Deft MCP Activity',
      description: 'Query recent OAuth/Codex MCP activity for the connected human user: tool calls, idempotency results, token events, and grant revocations. Use this to answer "what did my connected AI app do?" Human personal-MCP read: requires read:workspace.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: 'Optional tool name filter such as task_create, task_update, message_post, or search.' },
          since: { type: 'string', description: 'Optional ISO timestamp lower bound.' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
    {
      name: 'task_transition',
      title: 'Transition Deft Task',
      description: 'Change one visible task status as the connected human user. Prefer this over task_update for status-only changes. Always include idempotency_key for retry-safe writes. Human personal-MCP write: requires write:tasks.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'] },
          reason: { type: 'string' },
          idempotency_key: { type: 'string', description: 'Stable key for retry-safe writes. Reusing the same key returns the first successful result.' },
        },
        required: ['task_id', 'status'],
      },
    },
    {
      name: 'comment_on_task',
      title: 'Comment On Deft Task',
      description: 'Add a comment to a visible task as the connected human user. Always include idempotency_key for retry-safe writes. Human personal-MCP write: requires write:tasks.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          content: { type: 'string' },
          idempotency_key: { type: 'string', description: 'Stable key for retry-safe writes. Reusing the same key returns the first successful result.' },
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
        next.description = `${next.description ?? ''} Human personal-MCP write: executes as the token owner and requires a matching write scope. Always include idempotency_key for retry-safe writes; if you retry the same user intent, reuse the same key.`;
        next.annotations = { ...(next.annotations as Record<string, unknown> | undefined), readOnlyHint: false, destructiveHint: false };
        const inputSchema = next.inputSchema as { properties?: Record<string, unknown> } | undefined;
        if (inputSchema?.properties && !inputSchema.properties.idempotency_key) {
          inputSchema.properties.idempotency_key = {
            type: 'string',
            description: 'Stable key for retry-safe writes. Reusing the same key returns the first successful result.',
          };
        }
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
