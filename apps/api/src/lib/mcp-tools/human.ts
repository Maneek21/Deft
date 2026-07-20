import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  connectedAccounts,
  agentActions,
  agentEmployees,
  attentionItems,
  events,
  messages,
  notes,
  noteVersions,
  notifications,
  oauthAuditEvents,
  orgMembers,
  orgs,
  projects,
  spaceMembers,
  spaces,
  taskActivity,
  taskComments,
  tasks,
  savedViews,
  users,
  wikiCitations,
  wikiOpsLog,
  wikiPages,
  wikiPageVersions,
} from '@deft/db/schema';
import { retrieveContext, type ContextResult } from '../retrieve-context.js';
import { visibleTaskCondition } from '../task-visibility.js';
import { visibleWikiPageCondition } from '../wiki-visibility.js';
import { errorResult, textResult, type ToolResult } from './types.js';
import { enrichOAuthAuditActions } from '../oauth-audit-receipts.js';
import { getTeamContext, getTeamProfile, listTeamSummaries } from './team-context.js';
import { createTaskBundle, type TaskBundleSubtaskInput } from '../task-bundle.js';
import { bulkUpdateTasks, BulkTaskUpdateError, bulkTaskUpdateSchema } from '../task-bulk-update.js';
import { queryCompactTasks, type CompactTaskQuery } from '../task-compact-query.js';
import { visibleNoteCondition } from '../note-visibility.js';
import { approveAction, rejectAction } from '../agent-approval-resolver.js';
import {
  ensureAttentionBackfillForUser,
  filterVisibleAttentionItems,
  visibleAttentionCondition,
  transitionAttentionItem,
  type AttentionLane,
  type AttentionState,
} from '../attention.js';

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
  'attention_digest',
  'memory_recall',
  'wiki_search',
  'memory_list',
  'list_my_tasks',
  'task_get',
  'task_query',
  'task_saved_view_get',
  'project_list',
  'resolve_project',
  'project_get',
  'space_list',
  'resolve_space',
  'space_get',
  'thread_fetch',
  'member_list',
  'resolve_member',
  'resolve_targets',
  'member_get',
  'activity_query',
  'events_query',
  'messages_recent',
  'messages_search',
  'project_progress',
  'team_workload',
  'team_list',
  'team_get',
  'team_context',
  'workspace_capabilities',
  'note_list',
  'note_get',
  'calendar_list',
  'calendar_get',
  'calendar_availability',
  'inbox_list',
  'inbox_get',
  'approval_list',
  'approval_get',
  'attention_list',
  'attention_get',
  'task_saved_view_list',
  'agent_employee_list',
  'agent_employee_get',
]);

export const HUMAN_WRITE_TOOLS = new Set([
  'memory_write',
  'wiki_upsert',
  'task_create',
  'task_update',
  'task_bulk_update',
  'task_transition',
  'comment_on_task',
  'message_post',
  'send_message',
  'note_create',
  'note_update',
  'note_archive',
  'calendar_event_create',
  'calendar_event_update',
  'calendar_event_cancel',
  'inbox_mark_read',
  'inbox_mark_all_read',
  'approval_approve',
  'approval_reject',
  'attention_acknowledge',
  'attention_snooze',
  'attention_resolve',
  'project_create',
  'project_update',
  'project_archive',
  'task_saved_view_create',
  'agent_employee_update_state',
]);

export const HUMAN_TOOLS: Record<string, HumanToolHandler> = {
  search: humanSearch,
  fetch: humanFetch,
  platform_context: humanPlatformContext,
  attention_digest: humanAttentionDigest,
  memory_recall: humanMemoryRecall,
  wiki_search: humanMemoryRecall,
  memory_list: humanMemoryList,
  list_my_tasks: humanListMyTasks,
  task_get: humanTaskGet,
  memory_write: humanMemoryWrite,
  task_query: humanTaskQuery,
  task_saved_view_get: humanTaskSavedViewGet,
  project_list: humanProjectList,
  resolve_project: humanResolveProject,
  project_get: humanProjectGet,
  space_list: humanSpaceList,
  resolve_space: humanResolveSpace,
  space_get: humanSpaceGet,
  task_create: humanTaskCreate,
  task_update: humanTaskUpdate,
  task_bulk_update: humanTaskBulkUpdate,
  task_transition: humanTaskTransition,
  comment_on_task: humanCommentOnTask,
  message_post: humanMessagePost,
  thread_fetch: humanThreadFetch,
  member_list: humanMemberList,
  resolve_member: humanResolveMember,
  resolve_targets: humanResolveTargets,
  member_get: humanMemberGet,
  activity_query: humanActivityQuery,
  messages_recent: humanMessagesRecent,
  messages_search: humanMessagesSearch,
  project_progress: humanProjectProgress,
  team_workload: humanTeamWorkload,
  team_list: humanTeamList,
  team_get: humanTeamGet,
  team_context: humanTeamContext,
  events_query: humanEventsQuery,
  wiki_upsert: humanWikiUpsert,
  send_message: humanSendMessage,
  workspace_capabilities: humanWorkspaceCapabilities,
  note_list: humanNoteList,
  note_get: humanNoteGet,
  note_create: humanNoteCreate,
  note_update: humanNoteUpdate,
  note_archive: humanNoteArchive,
  calendar_list: humanCalendarList,
  calendar_get: humanCalendarGet,
  calendar_availability: humanCalendarAvailability,
  calendar_event_create: humanCalendarEventCreate,
  calendar_event_update: humanCalendarEventUpdate,
  calendar_event_cancel: humanCalendarEventCancel,
  inbox_list: humanInboxList,
  inbox_get: humanInboxGet,
  inbox_mark_read: humanInboxMarkRead,
  inbox_mark_all_read: humanInboxMarkAllRead,
  approval_list: humanApprovalList,
  approval_get: humanApprovalGet,
  approval_approve: humanApprovalApprove,
  approval_reject: humanApprovalReject,
  attention_list: humanAttentionList,
  attention_get: humanAttentionGet,
  attention_acknowledge: humanAttentionAcknowledge,
  attention_snooze: humanAttentionSnooze,
  attention_resolve: humanAttentionResolve,
  project_create: humanProjectCreate,
  project_update: humanProjectUpdate,
  project_archive: humanProjectArchive,
  task_saved_view_list: humanTaskSavedViewList,
  task_saved_view_create: humanTaskSavedViewCreate,
  agent_employee_list: humanAgentEmployeeList,
  agent_employee_get: humanAgentEmployeeGet,
  agent_employee_update_state: humanAgentEmployeeUpdateState,
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
        project_name: normalizedText(args.project_name),
        project_identifier: normalizedText(args.project_identifier),
        assignee_id: args.assignee_id ?? null,
        assignee_name: normalizedText(args.assignee_name),
        assignee_email: normalizedText(args.assignee_email),
        priority: args.priority ?? null,
        due_date: args.due_date ?? null,
        start_date: args.start_date ?? null,
        estimation: normalizedText(args.estimation),
        source_message_id: args.source_message_id ?? null,
      };
    case 'wiki_upsert':
      return {
        title: normalizedText(args.title),
        slug: normalizedText(args.slug),
        content: normalizedText(args.content ?? args.body),
        scope: args.scope ?? null,
        space_id: args.space_id ?? null,
        space_name: normalizedText(args.space_name),
      };
    case 'task_update':
      return { task_id: args.task_id ?? null, patch: args.patch ?? null };
    case 'task_bulk_update':
      return { task_ids: args.task_ids ?? null, updates: args.updates ?? null };
    case 'task_transition':
      return { task_id: args.task_id ?? null, status: args.status ?? null };
    case 'comment_on_task':
      return { task_id: args.task_id ?? null, content: normalizedText(args.content) };
    case 'message_post':
      return { space_id: args.space_id ?? null, parent_id: args.parent_id ?? null, content: normalizedText(args.content) };
    case 'send_message':
      return { target: args.target ?? null, space_id: args.space_id ?? null, space_name: normalizedText(args.space_name), thread_id: args.thread_id ?? null, user_id: args.user_id ?? null, email: normalizedText(args.email), person_name: normalizedText(args.person_name), content: normalizedText(args.content) };
    case 'note_create':
      return { title: normalizedText(args.title), content: normalizedText(args.content), visibility: args.visibility ?? 'private', visibility_space_id: args.visibility_space_id ?? null };
    case 'note_update':
      return { note_id: args.note_id ?? null, fields: args };
    case 'note_archive':
      return { note_id: args.note_id ?? null };
    case 'calendar_event_create':
      return { title: normalizedText(args.title), start: args.start ?? null, end: args.end ?? null, all_day: args.all_day ?? false };
    case 'calendar_event_update':
      return { event_id: args.event_id ?? null, fields: args };
    case 'calendar_event_cancel':
      return { event_id: args.event_id ?? null };
    case 'inbox_mark_read':
      return { notification_id: args.notification_id ?? null };
    case 'inbox_mark_all_read':
      return { all: true };
    case 'attention_acknowledge':
    case 'attention_resolve':
      return { attention_id: args.attention_id ?? null, resolution: normalizedText(args.resolution) };
    case 'attention_snooze':
      return { attention_id: args.attention_id ?? null, until: args.until ?? null };
    case 'approval_approve':
    case 'approval_reject':
      return { action_id: args.action_id ?? null, reason: normalizedText(args.reason) };
    case 'project_create':
      return { name: normalizedText(args.name), prefix: normalizedText(args.prefix) };
    case 'project_update':
      return { project_id: args.project_id ?? null, fields: args };
    case 'project_archive':
      return { project_id: args.project_id ?? null, archived: args.archived ?? true };
    case 'task_saved_view_create':
      return { name: normalizedText(args.name), project_id: args.project_id ?? null, config: args.config ?? null, is_shared: args.is_shared ?? false };
    case 'agent_employee_update_state':
      return { employee_id: args.employee_id ?? null, state: args.state ?? null };
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

function validWikiType(value: unknown): value is 'concept' | 'entity' | 'decision' | 'resource' | 'procedure' | 'preference' | 'fact' {
  return typeof value === 'string' && ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'].includes(value);
}

function validWikiScope(value: unknown): value is 'org' | 'space' | 'user' {
  return typeof value === 'string' && ['org', 'space', 'user'].includes(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function parseOptionalDate(value: unknown, field: string): Date | null | ToolResult {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && !(value instanceof Date)) return errorResult(`${field} must be an ISO date string`);
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return errorResult(`${field} must be a valid ISO date string`);
  return parsed;
}

function cleanSnippet(value: unknown, max = 240): string {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

type ResolverStatus = 'resolved' | 'ambiguous' | 'not_found';

type ResolverPart = {
  value: unknown;
  reason: string;
  weight?: number;
};

type RankedResolverCandidate<T extends Record<string, unknown>> = T & {
  confidence: number;
  match_reason: string;
};

function normalizeResolverText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/^[@#]/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactResolverText(value: unknown): string {
  return normalizeResolverText(value).replace(/\s+/g, '');
}

function resolverTokens(value: unknown): string[] {
  return normalizeResolverText(value).split(' ').filter(Boolean);
}

function scoreResolverPart(query: string, part: ResolverPart): { score: number; reason: string } {
  const normalizedQuery = normalizeResolverText(query);
  const compactQuery = compactResolverText(query);
  const normalizedPart = normalizeResolverText(part.value);
  const compactPart = compactResolverText(part.value);
  if (!normalizedQuery || !normalizedPart) return { score: 0, reason: part.reason };

  let score = 0;
  let reason = part.reason;
  if (normalizedPart === normalizedQuery || compactPart === compactQuery) {
    score = 1;
    reason = `${part.reason}: exact`;
  } else if (normalizedPart.startsWith(normalizedQuery) || compactPart.startsWith(compactQuery)) {
    score = 0.92;
    reason = `${part.reason}: prefix`;
  } else if (compactQuery && compactPart.includes(compactQuery)) {
    score = 0.84;
    reason = `${part.reason}: compact contains`;
  } else {
    const queryTokens = resolverTokens(query);
    const partTokens = new Set(resolverTokens(part.value));
    const matched = queryTokens.filter((token) => partTokens.has(token)).length;
    if (queryTokens.length > 0 && matched === queryTokens.length) {
      score = 0.8;
      reason = `${part.reason}: all words`;
    } else if (queryTokens.length > 0 && matched > 0) {
      score = 0.48 + (matched / queryTokens.length) * 0.24;
      reason = `${part.reason}: partial words`;
    }
  }

  return { score: Math.min(1, score * (part.weight ?? 1)), reason };
}

function rankResolverCandidates<T extends Record<string, unknown>>(
  query: string,
  candidates: T[],
  getParts: (candidate: T) => ResolverPart[],
): Array<RankedResolverCandidate<T>> {
  return candidates
    .map((candidate) => {
      const scored = getParts(candidate)
        .map((part) => scoreResolverPart(query, part))
        .sort((a, b) => b.score - a.score)[0] ?? { score: 0, reason: 'no match' };
      return {
        ...candidate,
        confidence: Number(scored.score.toFixed(2)),
        match_reason: scored.reason,
      };
    })
    .filter((candidate) => candidate.confidence > 0)
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return String(a.name ?? a.email ?? a.id ?? '').localeCompare(String(b.name ?? b.email ?? b.id ?? ''));
    });
}

function buildResolverResponse<T extends Record<string, unknown>>(
  query: string,
  ranked: Array<RankedResolverCandidate<T>>,
  options: { limit?: number; resolvedThreshold?: number; ambiguityDelta?: number } = {},
): {
  query: string;
  status: ResolverStatus;
  selected: RankedResolverCandidate<T> | null;
  candidates: Array<RankedResolverCandidate<T>>;
  needs_confirmation: boolean;
  confidence: number;
} {
  const limit = Math.min(Math.max(1, options.limit ?? 5), 20);
  const candidates = ranked.slice(0, limit);
  const top = candidates[0] ?? null;
  const second = candidates[1] ?? null;
  const resolvedThreshold = options.resolvedThreshold ?? 0.78;
  const ambiguityDelta = options.ambiguityDelta ?? 0.12;

  let status: ResolverStatus = 'not_found';
  if (top) {
    const tooWeak = top.confidence < resolvedThreshold;
    const exactTop = top.confidence >= 0.99;
    const exactTie = Boolean(second && second.confidence >= 0.99);
    const tooClose = exactTop ? exactTie : Boolean(second && top.confidence - second.confidence < ambiguityDelta);
    status = tooWeak || tooClose ? 'ambiguous' : 'resolved';
  }

  return {
    query,
    status,
    selected: status === 'resolved' ? top : null,
    candidates,
    needs_confirmation: status !== 'resolved',
    confidence: top?.confidence ?? 0,
  };
}

function resolverError(label: string, query: string, response: { status: ResolverStatus; candidates: Array<Record<string, unknown>> }): ToolResult {
  if (response.status === 'not_found' || response.candidates.length === 0) {
    return errorResult(`${label}: "${query}" not found. Use an id or call the matching resolve_* tool first.`);
  }
  const matches = response.candidates
    .map((row) => String(row.name ?? row.email ?? row.id ?? 'unknown'))
    .join(', ');
  return errorResult(`${label}: ambiguous "${query}". Confirm one of: ${matches}. Use the matching resolve_* tool and retry with the selected id.`);
}

async function resolveActiveMember(
  ctx: HumanToolContext,
  params: { user_id?: unknown; email?: unknown; name?: unknown; label: string },
): Promise<{ user: { id: string; name: string | null; email: string | null } | null; error?: ToolResult }> {
  const userId = typeof params.user_id === 'string' ? params.user_id.trim() : '';
  const email = typeof params.email === 'string' ? params.email.trim().toLowerCase() : '';
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (!userId && !email && !name) return { user: null };

  if (userId || email) {
    const rows = await db.execute(sql`
      SELECT u.id, u.name, u.email
      FROM org_members om
      JOIN users u ON u.id = om.user_id
      WHERE om.org_id = ${ctx.org_id}
        AND om.is_active = true
        AND (${userId ? sql`u.id = ${userId}` : sql`lower(u.email) = ${email}`})
      ORDER BY u.is_agent ASC, u.name ASC
      LIMIT 1
    `);
    const match = (((rows as any).rows ?? []) as Array<{ id: string; name: string | null; email: string | null }>)[0] ?? null;
    return match ? { user: match } : { user: null, error: errorResult(`${params.label}: member not found`) };
  }

  const rows = await db.execute(sql`
    SELECT u.id, u.name, u.email
    FROM org_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.org_id = ${ctx.org_id}
      AND om.is_active = true
    ORDER BY u.is_agent ASC, u.name ASC
    LIMIT 200
  `);
  const members = ((rows as any).rows ?? []) as Array<{ id: string; name: string | null; email: string | null }>;
  const ranked = rankResolverCandidates(name, members, (row) => [
    { value: row.name, reason: 'name' },
    { value: row.email, reason: 'email', weight: 0.96 },
  ]);
  const response = buildResolverResponse(name, ranked, { limit: 5, resolvedThreshold: 0.76 });
  if (!response.selected) return { user: null, error: resolverError(params.label, name, response) };
  return { user: response.selected };
}

async function resolveProjectForHumanTask(
  ctx: HumanToolContext,
  args: { project_id?: unknown; project_name?: unknown; project_identifier?: unknown },
): Promise<{ project: { id: string; name: string; prefix: string | null } | null; error?: ToolResult }> {
  const projectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
  const projectName = typeof args.project_name === 'string' ? args.project_name.trim() : '';
  const projectIdentifier = typeof args.project_identifier === 'string' ? args.project_identifier.trim() : '';
  if (projectId) {
    if (!(await userCanSeeProject(ctx, projectId))) return { project: null, error: errorResult('task_create: project not found') };
    const [project] = await db
      .select({ id: projects.id, name: projects.name, prefix: projects.prefix })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.org_id, ctx.org_id), eq(projects.is_deleted, false)))
      .limit(1);
    return { project: project ?? null };
  }

  const query = projectIdentifier || projectName;
  if (query) {
    const lookupQuery = projectIdentifier && projectIdentifier.includes('-') ? (projectIdentifier.split('-')[0] ?? query) : query;
    const rows = await db.execute(sql`
      SELECT id, name, prefix
      FROM projects
      WHERE org_id = ${ctx.org_id}
        AND is_archived = false
        AND is_deleted = false
      ORDER BY updated_at DESC
      LIMIT 200
    `);
    const projectsRows = ((rows as any).rows ?? []) as Array<{ id: string; name: string; prefix: string | null }>;
    const ranked = rankResolverCandidates(lookupQuery, projectsRows, (row) => [
      { value: row.name, reason: 'name' },
      { value: row.prefix, reason: 'prefix', weight: 0.98 },
    ]);
    const response = buildResolverResponse(lookupQuery, ranked, { limit: 5, resolvedThreshold: 0.76 });
    if (!response.selected) return { project: null, error: resolverError('task_create project', query, response) };
    return { project: response.selected };
  }

  const [fallback] = await db
    .select({ id: projects.id, name: projects.name, prefix: projects.prefix })
    .from(projects)
    .where(and(eq(projects.org_id, ctx.org_id), eq(projects.is_archived, false), eq(projects.is_deleted, false)))
    .orderBy(desc(projects.updated_at))
    .limit(1);
  return fallback ? { project: fallback } : { project: null, error: errorResult('task_create: no project available') };
}

async function resolveVisibleSpace(
  ctx: HumanToolContext,
  args: { space_id?: unknown; space_name?: unknown },
): Promise<{ space: { id: string; name: string; type: string } | null; error?: ToolResult }> {
  const spaceId = typeof args.space_id === 'string' ? args.space_id.trim() : '';
  const spaceName = typeof args.space_name === 'string' ? args.space_name.trim().replace(/^#/, '') : '';
  if (spaceId) {
    if (!(await userCanSeeSpace(ctx, spaceId))) return { space: null, error: errorResult('space not found or not visible to user') };
    const [space] = await db
      .select({ id: spaces.id, name: spaces.name, type: spaces.type })
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, ctx.org_id), eq(spaces.is_archived, false)))
      .limit(1);
    return { space: space ?? null };
  }
  if (!spaceName) return { space: null };
  const rows = await db.execute(sql`
    SELECT s.id, s.name, s.type, s.description
    FROM spaces s
    LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ${ctx.user_id}
    WHERE s.org_id = ${ctx.org_id}
      AND s.is_archived = false
      AND (s.type = 'public' OR sm.id IS NOT NULL)
    ORDER BY s.is_default DESC, s.name ASC
    LIMIT 200
  `);
  const spacesRows = ((rows as any).rows ?? []) as Array<{ id: string; name: string; type: string; description: string | null }>;
  const ranked = rankResolverCandidates(spaceName, spacesRows, (row) => [
    { value: row.name, reason: 'name' },
    { value: row.description, reason: 'description', weight: 0.68 },
  ]);
  const response = buildResolverResponse(spaceName, ranked, { limit: 5, resolvedThreshold: 0.76 });
  if (!response.selected) return { space: null, error: resolverError('space', spaceName, response) };
  return { space: response.selected };
}

async function verifyReadableSourceMessage(ctx: HumanToolContext, messageId: string): Promise<ToolResult | null> {
  const [message] = await db
    .select({ id: messages.id, space_id: messages.space_id, user_id: messages.user_id, content: messages.content })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.org_id, ctx.org_id), eq(messages.is_deleted, false)))
    .limit(1);
  if (!message) return errorResult(`source_message_id ${messageId} not found`);
  if (!(await userCanSeeSpace(ctx, message.space_id))) return errorResult(`source_message_id ${messageId} is not visible to user`);
  return null;
}

async function findOrCreateHumanDmSpace(ctx: HumanToolContext, otherUserId: string): Promise<string> {
  const existing = await db.execute(sql`
    SELECT s.id
    FROM spaces s
    WHERE s.org_id = ${ctx.org_id}
      AND s.type = 'dm'
      AND s.is_archived = false
      AND EXISTS (SELECT 1 FROM space_members WHERE space_id = s.id AND user_id = ${ctx.user_id})
      AND EXISTS (SELECT 1 FROM space_members WHERE space_id = s.id AND user_id = ${otherUserId})
      AND (SELECT count(*) FROM space_members WHERE space_id = s.id) = 2
    LIMIT 1
  `);
  const existingId = ((existing as any).rows ?? [])[0]?.id;
  if (existingId) return existingId;

  const [other] = await db.select({ name: users.name }).from(users).where(eq(users.id, otherUserId)).limit(1);
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, ctx.user_id)).limit(1);
  const [space] = await db
    .insert(spaces)
    .values({
      org_id: ctx.org_id,
      name: [me?.name ?? 'Me', other?.name ?? 'Member'].sort().join(', '),
      type: 'dm',
      created_by: ctx.user_id,
    })
    .returning();
  await db
    .insert(spaceMembers)
    .values([
      { space_id: space!.id, user_id: ctx.user_id },
      { space_id: space!.id, user_id: otherUserId },
    ])
    .onConflictDoNothing();
  return space!.id;
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

  let teamSummaries: Array<Record<string, unknown>> = [];
  try {
    teamSummaries = (await listTeamSummaries(ctx, { limit: 20 })).map((team) => ({
      id: team.id,
      name: team.name,
      handle: team.handle,
      description: team.description,
      type: team.type,
      visibility: team.visibility,
      lead_user_id: team.lead_user_id,
      lead_name: team.lead_name,
      default_space_id: team.default_space_id,
      member_count: team.member_count,
      agent_count: team.agent_count,
      resource_count: team.resource_count,
      resources_by_type: team.resources_by_type,
      current_user_role: team.current_user_role,
      retrieval_hint: {
        tool: 'team_context',
        args_template: { team_id: team.id },
      },
    }));
  } catch {
    teamSummaries = [];
  }

  return textResult({
    generated_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    org,
    user: { ...me, role: ctx.role },
    teammates,
    active_projects: activeProjects,
    teams: teamSummaries,
    relevant_wiki_snippets: wikiSnippets,
    context_packets: hasScope(ctx, 'read:wiki') ? buildHumanContextPackets(wikiSnippets, trigger) : [],
    recommended_tool_paths: [
      {
        intent: 'triage unread work or "what needs my attention?"',
        first_tool: 'attention_digest',
        why: 'one call returns unread/recent messages, mentions, tasks, calendar, approvals, and next-action hints',
      },
      {
        intent: 'multi-step owner/operator workflow with named spaces, projects, or people',
        first_tool: 'resolve_targets',
        why: 'resolve human names once, then pass confirmed ids to task_create, wiki_upsert, and send_message',
      },
      {
        intent: 'save durable workspace knowledge',
        preferred_tool: 'wiki_upsert',
        why: 'updates matching pages by slug/title instead of creating duplicate memory pages',
      },
      {
        intent: 'post to chat or DM a teammate',
        preferred_tool: 'send_message',
        why: 'accepts spaces, threads, emails, and person names while enforcing membership and idempotency',
      },
    ],
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

type HumanWikiUpsertArgs = {
  title?: string;
  slug?: string;
  content?: string;
  body?: string;
  summary?: string;
  type?: string;
  confidence?: number;
  scope?: string;
  space_id?: string;
  space_name?: string;
  source_message_id?: string;
  tags?: string[];
  idempotency_key?: string;
};

export async function humanWikiUpsert(args: HumanWikiUpsertArgs, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:wiki');
  if (scopeError) return scopeError;
  const title = args.title?.trim();
  const content = (args.content ?? args.body ?? '').trim();
  if (!title) return errorResult('wiki_upsert requires title');
  if (!content) return errorResult('wiki_upsert requires content');
  const type = validWikiType(args.type) ? args.type : 'fact';
  const scope = validWikiScope(args.scope) ? args.scope : 'org';
  const confidence = typeof args.confidence === 'number' && Number.isFinite(args.confidence)
    ? Math.max(0, Math.min(1, args.confidence))
    : 0.85;

  return withIdempotency('wiki_upsert', args, ctx, async () => {
    let spaceId: string | null = null;
    if (scope === 'space' || args.space_id || args.space_name) {
      const spaceResult = await resolveVisibleSpace(ctx, args);
      if (spaceResult.error) return spaceResult.error;
      if (!spaceResult.space) return errorResult('wiki_upsert: space scope requires space_id or space_name');
      spaceId = spaceResult.space.id;
    }

    let sourceMessage: { id: string; space_id: string; user_id: string; content: string } | null = null;
    const sourceMessageId = args.source_message_id?.trim() || null;
    if (sourceMessageId) {
      const sourceError = await verifyReadableSourceMessage(ctx, sourceMessageId);
      if (sourceError) return sourceError;
      const [row] = await db
        .select({ id: messages.id, space_id: messages.space_id, user_id: messages.user_id, content: messages.content })
        .from(messages)
        .where(and(eq(messages.id, sourceMessageId), eq(messages.org_id, ctx.org_id), eq(messages.is_deleted, false)))
        .limit(1);
      sourceMessage = row ?? null;
      if (!spaceId && scope === 'space') spaceId = sourceMessage?.space_id ?? null;
    }

    const requestedSlug = args.slug?.trim() ? slugify(args.slug.trim()) : null;
    const titleKey = title.toLowerCase();
    const existingRows = await db.execute(sql`
      SELECT *
      FROM wiki_pages
      WHERE org_id = ${ctx.org_id}
        AND is_deleted = false
        AND ${visibleWikiPageCondition(ctx.user_id)}
        AND (${requestedSlug ? sql`slug = ${requestedSlug}` : sql`lower(title) = ${titleKey}`})
        AND (${scope === 'space' ? sql`scope = 'space' AND space_id = ${spaceId}` : sql`scope = ${scope}`})
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    const existing = (((existingRows as any).rows ?? []) as Array<Record<string, any>>)[0];
    const tags = Array.isArray(args.tags)
      ? args.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 20)
      : [];
    const summary = args.summary?.trim() || content.slice(0, 240);
    const nowMetadata = {
      updated_via: 'human_mcp_upsert',
      user_id: ctx.user_id,
      source_message_id: sourceMessage?.id ?? null,
    };

    if (existing?.id) {
      await db.insert(wikiPageVersions).values({
        page_id: String(existing.id),
        version: Number(existing.version ?? 1),
        title: String(existing.title),
        content: String(existing.content ?? ''),
        summary: existing.summary ?? null,
        edited_by: ctx.user_id,
      }).onConflictDoNothing();

      const [page] = await db.update(wikiPages)
        .set({
          title,
          content,
          summary,
          type,
          confidence,
          scope: scope as any,
          space_id: scope === 'space' ? spaceId : null,
          user_id: scope === 'user' ? ctx.user_id : null,
          origin_space_id: sourceMessage?.space_id ?? existing.origin_space_id ?? null,
          origin_message_id: sourceMessage?.id ?? existing.origin_message_id ?? null,
          origin_user_id: sourceMessage?.user_id ?? existing.origin_user_id ?? null,
          created_via: existing.created_via ?? 'human_mcp_upsert',
          previous_content: String(existing.content ?? ''),
          metadata: { ...(existing.metadata ?? {}), ...nowMetadata } as any,
          tags,
          version: sql`${wikiPages.version} + 1` as any,
          updated_at: new Date(),
        })
        .where(and(eq(wikiPages.id, String(existing.id)), eq(wikiPages.org_id, ctx.org_id)))
        .returning();

      if (sourceMessage?.id && page?.id) {
        await db.insert(wikiCitations).values({
          org_id: ctx.org_id,
          page_id: page.id,
          source_type: 'message',
          source_id: sourceMessage.id,
          source_space_id: sourceMessage.space_id,
          source_user_id: sourceMessage.user_id,
          excerpt: cleanSnippet(sourceMessage.content, 500),
        });
      }
      if (page?.id) {
        await db.insert(wikiOpsLog).values({
          org_id: ctx.org_id,
          operation: 'human_mcp_upsert_update',
          page_id: page.id,
          performed_by: ctx.user_id,
          details: { title, slug: page.slug, scope, source_message_id: sourceMessage?.id ?? null },
        });
      }
      return textResult({
        operation: 'updated',
        id: page?.id,
        slug: page?.slug,
        title: page?.title,
        version: page?.version,
        url: page?.slug ? `/knowledge?slug=${encodeURIComponent(page.slug)}` : undefined,
      });
    }

    let slug = requestedSlug || slugify(title) || 'knowledge';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const [conflict] = await db
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(and(eq(wikiPages.org_id, ctx.org_id), eq(wikiPages.slug, slug)))
        .limit(1);
      if (!conflict) break;
      slug = `${requestedSlug || slugify(title) || 'knowledge'}-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    }

    const [page] = await db.insert(wikiPages).values({
      org_id: ctx.org_id,
      scope: scope as any,
      space_id: scope === 'space' ? spaceId : null,
      origin_space_id: sourceMessage?.space_id ?? spaceId,
      origin_message_id: sourceMessage?.id ?? null,
      origin_user_id: sourceMessage?.user_id ?? null,
      created_via: 'human_mcp_upsert',
      user_id: scope === 'user' ? ctx.user_id : null,
      type,
      title,
      slug,
      summary,
      content,
      confidence,
      metadata: nowMetadata,
      tags,
    }).returning();

    if (sourceMessage?.id && page?.id) {
      await db.insert(wikiCitations).values({
        org_id: ctx.org_id,
        page_id: page.id,
        source_type: 'message',
        source_id: sourceMessage.id,
        source_space_id: sourceMessage.space_id,
        source_user_id: sourceMessage.user_id,
        excerpt: cleanSnippet(sourceMessage.content, 500),
      });
    }
    if (page?.id) {
      await db.insert(wikiOpsLog).values({
        org_id: ctx.org_id,
        operation: 'human_mcp_upsert_create',
        page_id: page.id,
        performed_by: ctx.user_id,
        details: { title, slug: page.slug, scope, source_message_id: sourceMessage?.id ?? null },
      });
    }

    return textResult({
      operation: 'created',
      id: page?.id,
      slug: page?.slug,
      title: page?.title,
      version: page?.version,
      url: page?.slug ? `/knowledge?slug=${encodeURIComponent(page.slug)}` : undefined,
    });
  });
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

export async function humanTaskQuery(args: CompactTaskQuery & { filter?: { status?: string; assignee_id?: string; project_id?: string } }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:tasks');
  if (scopeError) return scopeError;
  const legacy = args.filter ?? {};
  try {
    const rows = await queryCompactTasks({
      ...args,
      project_id: args.project_id ?? legacy.project_id,
      statuses: args.statuses ?? (legacy.status ? [legacy.status] : undefined),
      assignee_ids: args.assignee_ids ?? (legacy.assignee_id ? [legacy.assignee_id] : undefined),
    }, { orgId: ctx.org_id, userId: ctx.user_id });
    return textResult(rows);
  } catch (err) {
    return errorResult(`task_query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function humanTaskSavedViewGet(args: { saved_view_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:tasks');
  if (scopeError) return scopeError;
  if (!args.saved_view_id) return errorResult('task_saved_view_get requires saved_view_id');
  const [view] = await db.select().from(savedViews).where(and(
    eq(savedViews.id, args.saved_view_id),
    eq(savedViews.org_id, ctx.org_id),
    or(eq(savedViews.user_id, ctx.user_id), eq(savedViews.is_shared, true)),
  )).limit(1);
  if (!view) return errorResult('task_saved_view_get: saved view not found');
  return textResult({
    id: view.id,
    name: view.name,
    project_id: view.project_id,
    is_shared: view.is_shared,
    query_config: view.config,
    read_only: true,
  });
}

export async function humanTaskBulkUpdate(
  args: { task_ids?: string[]; updates?: Record<string, unknown>; idempotency_key?: string },
  ctx: HumanToolContext,
): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:tasks');
  if (scopeError) return scopeError;
  const parsed = bulkTaskUpdateSchema.safeParse({ task_ids: args.task_ids, updates: args.updates });
  if (!parsed.success) return errorResult(parsed.error.issues[0]?.message ?? 'Invalid bulk task update');
  return withIdempotency('task_bulk_update', args, ctx, async () => {
    try {
      return textResult(await bulkUpdateTasks(parsed.data, { orgId: ctx.org_id, userId: ctx.user_id }));
    } catch (err) {
      if (err instanceof BulkTaskUpdateError) return errorResult(`${err.code}: ${err.message}`);
      throw err;
    }
  });
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

export async function humanResolveProject(args: { query?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const query = args.query?.trim();
  if (!query) return errorResult('resolve_project requires query');
  const lookupQuery = query.includes('-') ? (query.split('-')[0] ?? query) : query;
  const rows = await db.execute(sql`
    SELECT p.id, p.name, p.prefix, p.lead_id, lead.name AS lead_name, p.is_archived, p.updated_at
    FROM projects p
    LEFT JOIN users lead ON lead.id = p.lead_id
    WHERE p.org_id = ${ctx.org_id}
      AND p.is_deleted = false
      AND p.is_archived = false
    ORDER BY p.updated_at DESC
    LIMIT 200
  `);
  const projectsRows = ((rows as any).rows ?? []) as Array<Record<string, unknown>>;
  const ranked = rankResolverCandidates(lookupQuery, projectsRows, (row) => [
    { value: row.name, reason: 'name' },
    { value: row.prefix, reason: 'prefix', weight: 0.98 },
  ]);
  return textResult(buildResolverResponse(query, ranked, { limit: args.limit, resolvedThreshold: 0.76 }));
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

export async function humanResolveSpace(args: { query?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:messages');
  if (scopeError) return scopeError;
  const query = args.query?.trim().replace(/^#/, '');
  if (!query) return errorResult('resolve_space requires query');
  const rows = await db.execute(sql`
    SELECT s.id, s.name, s.type, s.description, s.is_default, s.updated_at
    FROM spaces s
    LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ${ctx.user_id}
    WHERE s.org_id = ${ctx.org_id}
      AND s.is_archived = false
      AND (s.type = 'public' OR sm.id IS NOT NULL)
    ORDER BY s.is_default DESC, s.name ASC
    LIMIT 200
  `);
  const spacesRows = ((rows as any).rows ?? []) as Array<Record<string, unknown>>;
  const ranked = rankResolverCandidates(query, spacesRows, (row) => [
    { value: row.name, reason: 'name' },
    { value: row.description, reason: 'description', weight: 0.68 },
  ]);
  return textResult(buildResolverResponse(query, ranked, { limit: args.limit, resolvedThreshold: 0.76 }));
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

type HumanTaskCreateArgs = {
  title?: string;
  description?: string;
  project_id?: string;
  project_name?: string;
  project_identifier?: string;
  assignee_id?: string;
  assignee_name?: string;
  assignee_email?: string;
  priority?: string;
  due_date?: string;
  start_date?: string;
  estimation?: string;
  source_message_id?: string;
  subtasks?: TaskBundleSubtaskInput[];
  idempotency_key?: string;
};

export async function humanTaskCreate(args: HumanTaskCreateArgs, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:tasks');
  if (scopeError) return scopeError;
  const title = args.title?.trim();
  if (!title) return errorResult('task_create requires title');
  return withIdempotency('task_create', args, ctx, async () => {
    const projectResult = await resolveProjectForHumanTask(ctx, args);
    if (projectResult.error) return projectResult.error;
    const project = projectResult.project;
    if (!project) return errorResult('task_create: no project available');

    const assigneeResult = await resolveActiveMember(ctx, {
      user_id: args.assignee_id,
      email: args.assignee_email,
      name: args.assignee_name,
      label: 'task_create assignee',
    });
    if (assigneeResult.error) return assigneeResult.error;

    const dueDate = parseOptionalDate(args.due_date, 'due_date');
    if (dueDate && 'content' in dueDate) return dueDate;
    const startDate = parseOptionalDate(args.start_date, 'start_date');
    if (startDate && 'content' in startDate) return startDate;

    const sourceMessageId = args.source_message_id?.trim() || null;
    if (sourceMessageId) {
      const messageError = await verifyReadableSourceMessage(ctx, sourceMessageId);
      if (messageError) return messageError;
    }

    let bundle;
    try {
      bundle = await createTaskBundle({
        orgId: ctx.org_id,
        projectId: project.id,
        projectPrefix: project.prefix ?? 'TASK',
        projectName: project.name,
        createdBy: ctx.user_id,
        title,
        description: args.description,
        priority: ['p0', 'p1', 'p2', 'p3'].includes(args.priority ?? '') ? args.priority : 'p2',
        assigneeId: assigneeResult.user?.id ?? null,
        dueDate: dueDate as Date | null,
        startDate: startDate as Date | null,
        estimation: typeof args.estimation === 'string' && args.estimation.trim() ? args.estimation.trim() : null,
        sourceMessageId,
        subtasks: Array.isArray(args.subtasks) ? args.subtasks : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(msg);
    }
    const task = bundle.parent;
    return textResult({
      ...task,
      task_key: taskReference(project.prefix, task.number ?? null),
      project_name: project.name,
      assignee_name: assigneeResult.user?.name ?? null,
      assignee_email: assigneeResult.user?.email ?? null,
      subtasks: bundle.subtasks,
    });
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

type HumanSendMessageArgs = {
  target?: Record<string, unknown>;
  space_id?: string;
  space_name?: string;
  thread_id?: string;
  parent_id?: string;
  user_id?: string;
  email?: string;
  person_name?: string;
  content?: string;
  idempotency_key?: string;
};

export async function humanSendMessage(args: HumanSendMessageArgs, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:messages');
  if (scopeError) return scopeError;
  const content = args.content?.trim();
  if (!content) return errorResult('send_message requires content');

  return withIdempotency('send_message', args, ctx, async () => {
    const target = args.target && typeof args.target === 'object' && !Array.isArray(args.target)
      ? args.target
      : {};
    const directSpace = {
      space_id: args.space_id ?? (typeof target.space_id === 'string' ? target.space_id : undefined),
      space_name: args.space_name ?? (typeof target.space_name === 'string' ? target.space_name : undefined),
    };
    const threadId = args.thread_id ?? args.parent_id ?? (typeof target.thread_id === 'string' ? target.thread_id : undefined) ?? (typeof target.parent_id === 'string' ? target.parent_id : undefined);

    let spaceId: string | null = null;
    let spaceName: string | null = null;
    let parentId: string | null = null;
    let targetKind: 'space' | 'thread' | 'dm' = 'space';
    let targetUser: { id: string; name: string | null; email: string | null } | null = null;

    if (threadId) {
      const [parent] = await db
        .select({ id: messages.id, space_id: messages.space_id })
        .from(messages)
        .where(and(eq(messages.id, threadId), eq(messages.org_id, ctx.org_id), eq(messages.is_deleted, false)))
        .limit(1);
      if (!parent || !(await userCanSeeSpace(ctx, parent.space_id))) return errorResult('send_message: thread not found or not visible to user');
      if (!(await userIsSpaceMember(ctx, parent.space_id))) return errorResult('send_message: user is not a member of the thread space');
      const [space] = await db.select({ name: spaces.name }).from(spaces).where(eq(spaces.id, parent.space_id)).limit(1);
      spaceId = parent.space_id;
      spaceName = space?.name ?? null;
      parentId = parent.id;
      targetKind = 'thread';
    } else if (directSpace.space_id || directSpace.space_name) {
      const spaceResult = await resolveVisibleSpace(ctx, directSpace);
      if (spaceResult.error) return spaceResult.error;
      if (!spaceResult.space) return errorResult('send_message: space not found');
      if (!(await userIsSpaceMember(ctx, spaceResult.space.id))) return errorResult('send_message: user is not a member of this space');
      spaceId = spaceResult.space.id;
      spaceName = spaceResult.space.name;
      targetKind = 'space';
    } else {
      const memberResult = await resolveActiveMember(ctx, {
        user_id: args.user_id ?? (typeof target.user_id === 'string' ? target.user_id : undefined),
        email: args.email ?? (typeof target.email === 'string' ? target.email : undefined),
        name: args.person_name ?? (typeof target.person_name === 'string' ? target.person_name : undefined) ?? (typeof target.name === 'string' ? target.name : undefined),
        label: 'send_message target',
      });
      if (memberResult.error) return memberResult.error;
      targetUser = memberResult.user;
      if (!targetUser) return errorResult('send_message requires a space, thread, or person target');
      spaceId = await findOrCreateHumanDmSpace(ctx, targetUser.id);
      const [space] = await db.select({ name: spaces.name }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
      spaceName = space?.name ?? null;
      targetKind = 'dm';
    }

    const [row] = await db.insert(messages).values({
      org_id: ctx.org_id,
      space_id: spaceId!,
      user_id: ctx.user_id,
      content,
      parent_id: parentId,
    }).returning();

    return textResult({
      ...row,
      target_kind: targetKind,
      target_user_id: targetUser?.id ?? null,
      target_user_name: targetUser?.name ?? null,
      target_user_email: targetUser?.email ?? null,
      space_name: spaceName,
      url: `/chat?space=${encodeURIComponent(spaceId!)}&message=${encodeURIComponent(row!.id)}`,
    });
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

export async function humanResolveMember(args: { query?: string; include_agents?: boolean; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const query = args.query?.trim();
  if (!query) return errorResult('resolve_member requires query');
  const rows = await db.execute(sql`
    SELECT u.id, u.name, u.email, om.role, u.is_agent, om.is_active
    FROM org_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.org_id = ${ctx.org_id}
      AND om.is_active = true
      AND (${args.include_agents === false ? sql`u.is_agent = false` : sql`true`})
    ORDER BY u.is_agent ASC, u.name ASC
    LIMIT 200
  `);
  const members = ((rows as any).rows ?? []) as Array<Record<string, unknown>>;
  const ranked = rankResolverCandidates(query, members, (row) => [
    { value: row.name, reason: 'name' },
    { value: row.email, reason: 'email', weight: 0.96 },
  ]);
  return textResult(buildResolverResponse(query, ranked, { limit: args.limit, resolvedThreshold: 0.76 }));
}

async function parseResolverToolResult(result: ToolResult): Promise<Record<string, unknown>> {
  if (result.isError) {
    return {
      status: 'error',
      needs_confirmation: true,
      error: result.content.map((item) => item.text).join('\n'),
    };
  }
  try {
    return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
  } catch {
    return {
      status: 'error',
      needs_confirmation: true,
      error: result.content[0]?.text ?? 'resolver returned invalid JSON',
    };
  }
}

function normalizeResolverBatch(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 10);
}

export async function humanResolveTargets(
  args: { spaces?: string[]; members?: string[]; projects?: string[]; include_agents?: boolean; limit?: number },
  ctx: HumanToolContext,
): Promise<ToolResult> {
  const spacesToResolve = normalizeResolverBatch(args.spaces);
  const membersToResolve = normalizeResolverBatch(args.members);
  const projectsToResolve = normalizeResolverBatch(args.projects);
  if (spacesToResolve.length === 0 && membersToResolve.length === 0 && projectsToResolve.length === 0) {
    return errorResult('resolve_targets requires at least one spaces, members, or projects query');
  }

  const resolved: Record<string, unknown> = {
    spaces: {},
    members: {},
    projects: {},
  };

  for (const query of spacesToResolve) {
    (resolved.spaces as Record<string, unknown>)[query] = await parseResolverToolResult(
      await humanResolveSpace({ query, limit: args.limit }, ctx),
    );
  }
  for (const query of membersToResolve) {
    (resolved.members as Record<string, unknown>)[query] = await parseResolverToolResult(
      await humanResolveMember({ query, include_agents: args.include_agents, limit: args.limit }, ctx),
    );
  }
  for (const query of projectsToResolve) {
    (resolved.projects as Record<string, unknown>)[query] = await parseResolverToolResult(
      await humanResolveProject({ query, limit: args.limit }, ctx),
    );
  }

  return textResult(resolved);
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

type HumanMessagesRecentArgs = {
  space_id?: string;
  space_name?: string;
  author_user_id?: string;
  author_name?: string;
  mentions_me?: boolean;
  since?: string;
  until?: string;
  limit?: number;
};

export async function humanMessagesRecent(args: HumanMessagesRecentArgs, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:messages');
  if (scopeError) return scopeError;

  const spaceResult = await resolveVisibleSpace(ctx, args);
  if (spaceResult.error) return spaceResult.error;

  const authorResult = await resolveActiveMember(ctx, {
    user_id: args.author_user_id,
    name: args.author_name,
    label: 'messages_recent author',
  });
  if (authorResult.error) return authorResult.error;

  const since = parseOptionalDate(args.since, 'since');
  if (since && 'content' in since) return since;
  const until = parseOptionalDate(args.until, 'until');
  if (until && 'content' in until) return until;

  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, ctx.user_id)).limit(1);
  const mentionPattern = me?.name ? `%${me.name.toLowerCase()}%` : null;
  const limit = Math.min(Math.max(1, args.limit ?? 50), 100);

  const rows = await db.execute(sql`
    SELECT
      m.id,
      m.space_id,
      s.name AS space_name,
      s.type AS space_type,
      m.user_id,
      u.name AS user_name,
      u.email AS user_email,
      m.content,
      m.parent_id,
      m.created_at,
      m.updated_at
    FROM messages m
    JOIN spaces s ON s.id = m.space_id AND s.org_id = ${ctx.org_id}
    JOIN users u ON u.id = m.user_id
    LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ${ctx.user_id}
    WHERE m.org_id = ${ctx.org_id}
      AND m.is_deleted = false
      AND s.is_archived = false
      AND (s.type = 'public' OR sm.id IS NOT NULL)
      AND (${spaceResult.space ? sql`m.space_id = ${spaceResult.space.id}` : sql`true`})
      AND (${authorResult.user ? sql`m.user_id = ${authorResult.user.id}` : sql`true`})
      AND (${since instanceof Date ? sql`m.created_at >= ${since}` : sql`true`})
      AND (${until instanceof Date ? sql`m.created_at <= ${until}` : sql`true`})
      AND (${args.mentions_me === true
        ? sql`(m.content ILIKE ${`%${ctx.user_id}%`} OR lower(m.content) LIKE ${mentionPattern ?? `%${ctx.user_id.toLowerCase()}%`})`
        : sql`true`})
    ORDER BY m.created_at DESC
    LIMIT ${limit}
  `);

  const messagesRows = ((rows as any).rows ?? []) as Array<Record<string, unknown>>;
  return textResult({
    count: messagesRows.length,
    messages: messagesRows.map((row) => ({
      ...row,
      snippet: cleanSnippet(row.content),
      url: `/chat?space=${encodeURIComponent(String(row.space_id))}&message=${encodeURIComponent(String(row.id))}`,
    })),
  });
}

type HumanAttentionDigestArgs = {
  limit?: number;
  since?: string;
  space_id?: string;
  space_name?: string;
  include_recent?: boolean;
  include_calendar?: boolean;
};

export async function humanAttentionDigest(args: HumanAttentionDigestArgs, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireAnyScope(ctx, ['read:workspace', 'read:messages', 'read:tasks', 'read:calendar']);
  if (scopeError) return scopeError;

  const limit = Math.min(Math.max(1, args.limit ?? 20), 50);
  const since = parseOptionalDate(args.since, 'since');
  if (since && 'content' in since) return since;
  const spaceResult = await resolveVisibleSpace(ctx, args);
  if (spaceResult.error) return spaceResult.error;

  const digest: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    scopes_used: ctx.scopes.filter((scope) => ['read:workspace', 'read:messages', 'read:tasks', 'read:calendar'].includes(scope)),
    workspace: {},
    unread_messages: [],
    mentions: [],
    assigned_tasks: [],
    overdue_tasks: [],
    upcoming_events: [],
    pending_approvals: [],
    recommended_next_actions: [],
  };

  if (hasScope(ctx, 'read:workspace')) {
    const [org] = await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(eq(orgs.id, ctx.org_id)).limit(1);
    const [me] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, ctx.user_id)).limit(1);
    digest.workspace = { org, user: me };

    const approvals = await db.execute(sql`
      SELECT id, action, params, approval_tier, approval_status, created_at
      FROM agent_actions
      WHERE org_id = ${ctx.org_id}
        AND user_id = ${ctx.user_id}
        AND approval_status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    digest.pending_approvals = (approvals as any).rows ?? [];
  }

  if (hasScope(ctx, 'read:messages')) {
    const unreadRows = await db.execute(sql`
      SELECT
        m.id,
        m.space_id,
        s.name AS space_name,
        s.type AS space_type,
        m.user_id,
        u.name AS user_name,
        m.content,
        m.parent_id,
        m.created_at,
        sm.last_read_at
      FROM space_members sm
      JOIN spaces s ON s.id = sm.space_id AND s.org_id = ${ctx.org_id}
      JOIN messages m ON m.space_id = s.id AND m.org_id = ${ctx.org_id}
      JOIN users u ON u.id = m.user_id
      WHERE sm.user_id = ${ctx.user_id}
        AND s.is_archived = false
        AND m.is_deleted = false
        AND m.user_id != ${ctx.user_id}
        AND m.created_at > coalesce(sm.last_read_at, timestamp '1970-01-01')
        AND (${spaceResult.space ? sql`m.space_id = ${spaceResult.space.id}` : sql`true`})
        AND (${since instanceof Date ? sql`m.created_at >= ${since}` : sql`true`})
      ORDER BY m.created_at DESC
      LIMIT ${limit}
    `);
    const unread = (((unreadRows as any).rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      snippet: cleanSnippet(row.content),
      url: `/chat?space=${encodeURIComponent(String(row.space_id))}&message=${encodeURIComponent(String(row.id))}`,
    }));
    digest.unread_messages = unread;

    const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, ctx.user_id)).limit(1);
    const mentionPattern = me?.name ? `%${me.name.toLowerCase()}%` : `%${ctx.user_id.toLowerCase()}%`;
    const mentionsRows = await db.execute(sql`
      SELECT
        m.id,
        m.space_id,
        s.name AS space_name,
        m.user_id,
        u.name AS user_name,
        m.content,
        m.created_at
      FROM messages m
      JOIN spaces s ON s.id = m.space_id AND s.org_id = ${ctx.org_id}
      JOIN users u ON u.id = m.user_id
      LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ${ctx.user_id}
      WHERE m.org_id = ${ctx.org_id}
        AND m.is_deleted = false
        AND s.is_archived = false
        AND (s.type = 'public' OR sm.id IS NOT NULL)
        AND m.user_id != ${ctx.user_id}
        AND (m.content ILIKE ${`%${ctx.user_id}%`} OR lower(m.content) LIKE ${mentionPattern})
        AND (${spaceResult.space ? sql`m.space_id = ${spaceResult.space.id}` : sql`true`})
        AND (${since instanceof Date ? sql`m.created_at >= ${since}` : sql`m.created_at >= now() - interval '14 days'`})
      ORDER BY m.created_at DESC
      LIMIT ${limit}
    `);
    digest.mentions = (((mentionsRows as any).rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      snippet: cleanSnippet(row.content),
      url: `/chat?space=${encodeURIComponent(String(row.space_id))}&message=${encodeURIComponent(String(row.id))}`,
    }));

    if (args.include_recent !== false && unread.length === 0) {
      const recent = await humanMessagesRecent({ space_id: spaceResult.space?.id, limit: Math.min(limit, 10) }, ctx);
      if (!recent.isError) digest.recent_messages = JSON.parse(recent.content[0]?.text ?? '{}');
    }
  }

  if (hasScope(ctx, 'read:tasks')) {
    const taskRows = await db.execute(sql`
      SELECT
        t.id,
        t.title,
        t.status,
        t.priority,
        t.due_date,
        p.name AS project_name,
        p.prefix AS project_prefix,
        (p.prefix || '-' || t.number) AS task_key
      FROM tasks t
      JOIN projects p ON p.id = t.project_id AND p.org_id = ${ctx.org_id}
      WHERE t.org_id = ${ctx.org_id}
        AND t.is_deleted = false
        AND t.assignee_id = ${ctx.user_id}
        AND t.status NOT IN ('done', 'cancelled')
      ORDER BY
        CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
        t.due_date ASC,
        t.priority ASC,
        t.updated_at DESC
      LIMIT ${limit}
    `);
    const assigned = ((taskRows as any).rows ?? []) as Array<Record<string, unknown>>;
    digest.assigned_tasks = assigned.map((row) => ({
      ...row,
      url: `/tasks?task=${encodeURIComponent(String(row.id))}`,
    }));
    digest.overdue_tasks = assigned
      .filter((row) => row.due_date && new Date(String(row.due_date)).getTime() < Date.now())
      .map((row) => ({ ...row, url: `/tasks?task=${encodeURIComponent(String(row.id))}` }));
  }

  if ((args.include_calendar ?? true) && hasScope(ctx, 'read:calendar')) {
    const eventRows = await db.execute(sql`
      SELECT e.id, e.title, e.body, e.source, e.event_type, e.timestamp, e.url, e.metadata
      FROM events e
      LEFT JOIN connected_accounts ca ON ca.id = e.connected_account_id
      WHERE e.org_id = ${ctx.org_id}
        AND (e.user_id = ${ctx.user_id} OR ca.user_id = ${ctx.user_id})
        AND e.timestamp >= now() - interval '2 hours'
        AND e.timestamp <= now() + interval '7 days'
      ORDER BY e.timestamp ASC
      LIMIT ${Math.min(limit, 20)}
    `);
    digest.upcoming_events = (eventRows as any).rows ?? [];
  }

  const unreadCount = Array.isArray(digest.unread_messages) ? digest.unread_messages.length : 0;
  const mentionsCount = Array.isArray(digest.mentions) ? digest.mentions.length : 0;
  const taskCount = Array.isArray(digest.assigned_tasks) ? digest.assigned_tasks.length : 0;
  const approvalCount = Array.isArray(digest.pending_approvals) ? digest.pending_approvals.length : 0;
  digest.recommended_next_actions = [
    unreadCount > 0 ? `Review ${unreadCount} unread message${unreadCount === 1 ? '' : 's'}` : null,
    mentionsCount > 0 ? `Reply to ${mentionsCount} mention${mentionsCount === 1 ? '' : 's'}` : null,
    taskCount > 0 ? `Work through ${taskCount} assigned open task${taskCount === 1 ? '' : 's'}` : null,
    approvalCount > 0 ? `Resolve ${approvalCount} pending approval${approvalCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  return textResult(digest);
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
  const actions = ((rows as any).rows ?? []) as Array<{
    id: string;
    client_id: string;
    event: string;
    metadata: Record<string, unknown> | null;
    created_at: Date;
  }>;
  const enriched = await enrichOAuthAuditActions(ctx.org_id, actions);
  return textResult(enriched);
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

export async function humanTeamList(
  args: { query?: string; include_archived?: boolean; limit?: number },
  ctx: HumanToolContext,
): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const teams = await listTeamSummaries(ctx, args);
  return textResult({ teams, count: teams.length });
}

function teamAccessFromHuman(ctx: HumanToolContext) {
  return {
    ...ctx,
    can_read_tasks: hasScope(ctx, 'read:tasks'),
    can_read_messages: hasScope(ctx, 'read:messages'),
    can_read_wiki: hasScope(ctx, 'read:wiki'),
  };
}

export async function humanTeamGet(
  args: { team_id?: string; handle?: string; query?: string; include_archived?: boolean },
  ctx: HumanToolContext,
): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  return textResult(await getTeamProfile(teamAccessFromHuman(ctx), args));
}

export async function humanTeamContext(
  args: { team_id?: string; handle?: string; query?: string; include_archived?: boolean; limit?: number },
  ctx: HumanToolContext,
): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  return textResult(await getTeamContext(teamAccessFromHuman(ctx), args));
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

function operationalBoundary() {
  return {
    operationally_headless: true,
    ui_only: [
      'initial workspace authentication and connector authorization',
      'billing and provider secrets',
      'ownership transfer, member role changes, and member removal',
      'agent credential reveal, rotation, and deletion',
      'irreversible project deletion',
    ],
  };
}

export async function humanWorkspaceCapabilities(_args: Record<string, never>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const available = [...HUMAN_READ_TOOLS, ...HUMAN_WRITE_TOOLS].filter((name) => {
    const required = HUMAN_TOOL_SCOPES[name];
    if (required && !ctx.scopes.includes(required)) return false;
    if (name === 'agent_employee_update_state' && !canManageWorkspace(ctx)) return false;
    return true;
  });
  return textResult({
    ...operationalBoundary(),
    role: ctx.role,
    granted_scopes: ctx.scopes,
    available_tools: available.sort(),
    guidance: 'Use attention_digest for triage, resolve_targets before fuzzy writes, and reuse idempotency_key when retrying the same write.',
  });
}

export async function humanNoteList(args: { query?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const limit = Math.min(Math.max(1, args.limit ?? 50), 100);
  const query = args.query?.trim();
  const rows = await db.select({
    id: notes.id, title: notes.title, content: notes.content, icon: notes.icon,
    is_pinned: notes.is_pinned, visibility: notes.visibility,
    visibility_space_id: notes.visibility_space_id, user_id: notes.user_id,
    version: notes.version, created_at: notes.created_at, updated_at: notes.updated_at,
  }).from(notes).where(and(
    eq(notes.org_id, ctx.org_id), eq(notes.is_deleted, false), eq(notes.is_template, false),
    visibleNoteCondition(ctx.user_id), query ? sql`(${notes.title} ILIKE ${`%${query}%`} OR ${notes.content} ILIKE ${`%${query}%`})` : sql`true`,
  )).orderBy(desc(notes.is_pinned), desc(notes.updated_at)).limit(limit);
  return textResult(rows.map((row) => ({ ...row, url: `/notes?note=${row.id}` })));
}

export async function humanNoteGet(args: { note_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  if (!args.note_id) return errorResult('note_id is required');
  const [row] = await db.select().from(notes).where(and(
    eq(notes.id, args.note_id), eq(notes.org_id, ctx.org_id), eq(notes.is_deleted, false), visibleNoteCondition(ctx.user_id),
  )).limit(1);
  return row ? textResult({ ...row, url: `/notes?note=${row.id}` }) : errorResult('Note not found or not visible');
}

function validNoteVisibility(value: unknown): value is 'private' | 'org' | 'space' {
  return typeof value === 'string' && ['private', 'org', 'space'].includes(value);
}

async function validateNoteSpace(ctx: HumanToolContext, visibility: string, spaceId?: string | null): Promise<ToolResult | null> {
  if (visibility !== 'space') return null;
  if (!spaceId) return errorResult('visibility_space_id is required for a space-visible note');
  return await userIsSpaceMember(ctx, spaceId) ? null : errorResult('You are not a member of that space');
}

export async function humanNoteCreate(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace');
  if (scopeError) return scopeError;
  return withIdempotency('note_create', args, ctx, async () => {
    const visibility = validNoteVisibility(args.visibility) ? args.visibility : 'private';
    const spaceId = typeof args.visibility_space_id === 'string' ? args.visibility_space_id : null;
    const spaceError = await validateNoteSpace(ctx, visibility, spaceId);
    if (spaceError) return spaceError;
    const [created] = await db.insert(notes).values({
      org_id: ctx.org_id, user_id: ctx.user_id,
      title: typeof args.title === 'string' ? args.title.trim() : '',
      content: typeof args.content === 'string' ? args.content : '',
      icon: typeof args.icon === 'string' ? args.icon : null,
      is_pinned: args.is_pinned === true,
      visibility, visibility_space_id: visibility === 'space' ? spaceId : null,
    }).returning();
    return textResult({ created: true, note: created, url: `/notes?note=${created!.id}` });
  });
}

export async function humanNoteUpdate(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace');
  if (scopeError) return scopeError;
  if (typeof args.note_id !== 'string') return errorResult('note_id is required');
  return withIdempotency('note_update', args, ctx, async () => {
    const [current] = await db.select().from(notes).where(and(
      eq(notes.id, args.note_id as string), eq(notes.org_id, ctx.org_id), eq(notes.user_id, ctx.user_id), eq(notes.is_deleted, false),
    )).limit(1);
    if (!current) return errorResult('Note not found or not owned by the connected user');
    const visibility = validNoteVisibility(args.visibility) ? args.visibility : current.visibility;
    const spaceId = args.visibility_space_id === null ? null : typeof args.visibility_space_id === 'string' ? args.visibility_space_id : current.visibility_space_id;
    const spaceError = await validateNoteSpace(ctx, visibility, spaceId);
    if (spaceError) return spaceError;
    const updates: Record<string, unknown> = {};
    for (const field of ['title', 'content', 'icon', 'is_pinned'] as const) if (args[field] !== undefined) updates[field] = args[field];
    if (args.visibility !== undefined) updates.visibility = visibility;
    if (args.visibility !== undefined || args.visibility_space_id !== undefined) updates.visibility_space_id = visibility === 'space' ? spaceId : null;
    if (args.content !== undefined && args.content !== current.content) {
      await db.insert(noteVersions).values({ note_id: current.id, version: current.version, title: current.title, content: current.content, edited_by: ctx.user_id }).onConflictDoNothing();
      updates.version = current.version + 1;
    }
    if (Object.keys(updates).length === 0) return textResult({ updated: false, note: current, url: `/notes?note=${current.id}` });
    const [updated] = await db.update(notes).set(updates).where(and(eq(notes.id, current.id), eq(notes.version, current.version))).returning();
    return updated ? textResult({ updated: true, note: updated, url: `/notes?note=${updated.id}` }) : errorResult('Note changed in another session; read it again before retrying');
  });
}

export async function humanNoteArchive(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace');
  if (scopeError) return scopeError;
  if (typeof args.note_id !== 'string') return errorResult('note_id is required');
  return withIdempotency('note_archive', args, ctx, async () => {
    const [updated] = await db.update(notes).set({ is_deleted: true }).where(and(
      eq(notes.id, args.note_id as string), eq(notes.org_id, ctx.org_id), eq(notes.user_id, ctx.user_id), eq(notes.is_deleted, false),
    )).returning({ id: notes.id, title: notes.title });
    return updated ? textResult({ archived: true, note: updated }) : errorResult('Note not found or not owned by the connected user');
  });
}

function parseRequiredDate(value: unknown, field: string): Date | ToolResult {
  if (typeof value !== 'string') return errorResult(`${field} is required as an ISO timestamp`);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? errorResult(`${field} must be a valid ISO timestamp`) : parsed;
}

export async function humanCalendarList(args: { from?: string; until?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:calendar');
  if (scopeError) return scopeError;
  const from = args.from ? new Date(args.from) : new Date(Date.now() - 2 * 60 * 60 * 1000);
  const until = args.until ? new Date(args.until) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime()) || until <= from) return errorResult('from/until must be a valid increasing ISO range');
  const rows = await db.execute(sql`
    SELECT e.* FROM events e LEFT JOIN connected_accounts ca ON ca.id = e.connected_account_id
    WHERE e.org_id = ${ctx.org_id} AND (e.user_id = ${ctx.user_id} OR ca.user_id = ${ctx.user_id})
      AND e.event_type = 'calendar_event' AND e.timestamp >= ${from} AND e.timestamp <= ${until}
    ORDER BY e.timestamp ASC LIMIT ${Math.min(Math.max(1, args.limit ?? 100), 200)}
  `);
  return textResult((rows as any).rows ?? []);
}

export async function humanCalendarGet(args: { event_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:calendar');
  if (scopeError) return scopeError;
  if (!args.event_id || !(await userCanSeeEvent(ctx, args.event_id))) return errorResult('Event not found or not visible');
  const [row] = await db.select().from(events).where(eq(events.id, args.event_id)).limit(1);
  return textResult(row);
}

export async function humanCalendarAvailability(args: { from?: string; until?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const result = await humanCalendarList({ from: args.from, until: args.until, limit: 200 }, ctx);
  if (result.isError) return result;
  const rows = JSON.parse(result.content[0]?.text ?? '[]') as Array<any>;
  return textResult({ from: args.from ?? null, until: args.until ?? null, busy: rows.map((row) => ({ event_id: row.id, title: row.title, start: row.metadata?.start ?? row.timestamp, end: row.metadata?.end ?? row.timestamp, source: row.source })) });
}

export async function humanCalendarEventCreate(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:calendar');
  if (scopeError) return scopeError;
  return withIdempotency('calendar_event_create', args, ctx, async () => {
    if (typeof args.title !== 'string' || !args.title.trim()) return errorResult('title is required');
    const start = parseRequiredDate(args.start, 'start'); if (!(start instanceof Date)) return start;
    const end = parseRequiredDate(args.end, 'end'); if (!(end instanceof Date)) return end;
    if (end <= start) return errorResult('end must be after start');
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.user_id)).limit(1);
    const [created] = await db.insert(events).values({ org_id: ctx.org_id, source: 'native', event_type: 'calendar_event', title: args.title.trim(), body: typeof args.description === 'string' ? args.description : null, actor: user?.email ?? null, timestamp: start, metadata: { start: start.toISOString(), end: end.toISOString(), location: typeof args.location === 'string' ? args.location : null, attendees: [], status: 'confirmed', allDay: args.all_day === true }, user_id: ctx.user_id }).returning();
    return textResult({ created: true, event: created, url: `/calendar?event=${created!.id}` });
  });
}

export async function humanCalendarEventUpdate(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:calendar');
  if (scopeError) return scopeError;
  if (typeof args.event_id !== 'string') return errorResult('event_id is required');
  return withIdempotency('calendar_event_update', args, ctx, async () => {
    const [current] = await db.select().from(events).where(and(eq(events.id, args.event_id as string), eq(events.org_id, ctx.org_id), eq(events.user_id, ctx.user_id), eq(events.source, 'native'))).limit(1);
    if (!current) return errorResult('Native event not found or not editable');
    const metadata = { ...(current.metadata as Record<string, unknown>) };
    const updates: Record<string, unknown> = {};
    if (typeof args.title === 'string' && args.title.trim()) updates.title = args.title.trim();
    if (args.description !== undefined) updates.body = typeof args.description === 'string' ? args.description : null;
    if (args.start !== undefined) { const start = parseRequiredDate(args.start, 'start'); if (!(start instanceof Date)) return start; updates.timestamp = start; metadata.start = start.toISOString(); }
    if (args.end !== undefined) { const end = parseRequiredDate(args.end, 'end'); if (!(end instanceof Date)) return end; metadata.end = end.toISOString(); }
    if (args.location !== undefined) metadata.location = typeof args.location === 'string' ? args.location : null;
    const startValue = new Date(String(metadata.start ?? current.timestamp)); const endValue = new Date(String(metadata.end ?? current.timestamp));
    if (!Number.isNaN(endValue.getTime()) && endValue <= startValue) return errorResult('end must be after start');
    updates.metadata = metadata;
    const [updated] = await db.update(events).set(updates).where(eq(events.id, current.id)).returning();
    return textResult({ updated: true, event: updated, url: `/calendar?event=${updated!.id}` });
  });
}

export async function humanCalendarEventCancel(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:calendar');
  if (scopeError) return scopeError;
  if (typeof args.event_id !== 'string') return errorResult('event_id is required');
  return withIdempotency('calendar_event_cancel', args, ctx, async () => {
    const [deleted] = await db.delete(events).where(and(eq(events.id, args.event_id as string), eq(events.org_id, ctx.org_id), eq(events.user_id, ctx.user_id), eq(events.source, 'native'))).returning({ id: events.id, title: events.title });
    return deleted ? textResult({ cancelled: true, event: deleted }) : errorResult('Native event not found or not cancellable');
  });
}

const MCP_OPEN_ATTENTION_STATES: AttentionState[] = ['open_unseen', 'open_seen', 'acknowledged'];
const MCP_ALL_ATTENTION_STATES: AttentionState[] = [
  ...MCP_OPEN_ATTENTION_STATES,
  'snoozed',
  'resolved',
  'expired',
  'superseded',
];

function parseAttentionLane(value: unknown): AttentionLane | null | 'all' {
  if (value === undefined || value === null || value === 'all') return 'all';
  return value === 'needs_you' || value === 'updates' ? value : null;
}

function parseAttentionStates(value: unknown): AttentionState[] | null {
  if (value === undefined || value === null || value === 'open') return MCP_OPEN_ATTENTION_STATES;
  if (value === 'all') return MCP_ALL_ATTENTION_STATES;
  return typeof value === 'string' && MCP_ALL_ATTENTION_STATES.includes(value as AttentionState)
    ? [value as AttentionState]
    : null;
}

export async function humanAttentionList(args: { lane?: string; state?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const lane = parseAttentionLane(args.lane);
  const states = parseAttentionStates(args.state);
  if (!lane) return errorResult('lane must be needs_you, updates, or all');
  if (!states) return errorResult('state must be open, all, or a valid attention lifecycle state');

  await ensureAttentionBackfillForUser({ orgId: ctx.org_id, userId: ctx.user_id, role: ctx.role });
  const rows = await db
    .select()
    .from(attentionItems)
    .where(and(
      eq(attentionItems.org_id, ctx.org_id),
      eq(attentionItems.user_id, ctx.user_id),
      lane === 'all' ? sql`true` : eq(attentionItems.lane, lane),
      inArray(attentionItems.state, states),
      visibleAttentionCondition(ctx.user_id),
    ))
    .orderBy(desc(attentionItems.last_event_at))
    .limit(Math.min(Math.max(1, args.limit ?? 50), 100));
  const visibleRows = await filterVisibleAttentionItems(ctx.user_id, rows);
  const counts = await db
    .select({
      lane: attentionItems.lane,
      count: sql<number>`count(*)::int`,
      unseen: sql<number>`count(*) FILTER (WHERE ${attentionItems.state} = 'open_unseen')::int`,
    })
    .from(attentionItems)
    .where(and(
      eq(attentionItems.org_id, ctx.org_id),
      eq(attentionItems.user_id, ctx.user_id),
      inArray(attentionItems.state, MCP_OPEN_ATTENTION_STATES),
      visibleAttentionCondition(ctx.user_id),
    ))
    .groupBy(attentionItems.lane);
  return textResult({
    items: visibleRows.map((row) => ({ ...row, url: row.link ?? `/inbox?lane=${row.lane}` })),
    counts: Object.fromEntries(counts.map((row) => [row.lane, { count: Number(row.count), unseen: Number(row.unseen) }])),
  });
}

export async function humanAttentionGet(args: { attention_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  if (!args.attention_id) return errorResult('attention_id is required');
  const [row] = await db
    .select()
    .from(attentionItems)
    .where(and(
      eq(attentionItems.id, args.attention_id),
      eq(attentionItems.org_id, ctx.org_id),
      eq(attentionItems.user_id, ctx.user_id),
      visibleAttentionCondition(ctx.user_id),
    ))
    .limit(1);
  if (!row) return errorResult('Attention item not found');
  const visible = await filterVisibleAttentionItems(ctx.user_id, [row]);
  return visible[0]
    ? textResult({ ...visible[0], url: visible[0].link ?? `/inbox?lane=${visible[0].lane}` })
    : errorResult('Attention item not found');
}

async function transitionHumanAttention(
  args: Record<string, unknown>,
  ctx: HumanToolContext,
  action: 'acknowledge' | 'snooze' | 'resolve',
): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace');
  if (scopeError) return scopeError;
  if (typeof args.attention_id !== 'string') return errorResult('attention_id is required');
  const until = action === 'snooze' && typeof args.until === 'string' ? new Date(args.until) : null;
  if (action === 'snooze' && (!until || Number.isNaN(until.getTime()) || until <= new Date())) {
    return errorResult('until must be a future ISO timestamp');
  }
  const [visible] = await db
    .select({ id: attentionItems.id })
    .from(attentionItems)
    .where(and(
      eq(attentionItems.id, args.attention_id as string),
      eq(attentionItems.org_id, ctx.org_id),
      eq(attentionItems.user_id, ctx.user_id),
      visibleAttentionCondition(ctx.user_id),
    ))
    .limit(1);
  if (!visible) return errorResult('Attention item not found');
  return withIdempotency(`attention_${action}`, args, ctx, async () => {
    const row = await transitionAttentionItem({
      orgId: ctx.org_id,
      userId: ctx.user_id,
      itemId: args.attention_id as string,
      state: action === 'acknowledge' ? 'acknowledged' : action === 'snooze' ? 'snoozed' : 'resolved',
      snoozedUntil: until,
      resolution: action === 'resolve' && typeof args.resolution === 'string' ? args.resolution.slice(0, 120) : action,
      actorUserId: ctx.user_id,
    });
    return row ? textResult({ updated: true, item: row }) : errorResult('Attention item not found');
  });
}

export function humanAttentionAcknowledge(args: Record<string, unknown>, ctx: HumanToolContext) {
  return transitionHumanAttention(args, ctx, 'acknowledge');
}

export function humanAttentionSnooze(args: Record<string, unknown>, ctx: HumanToolContext) {
  return transitionHumanAttention(args, ctx, 'snooze');
}

export function humanAttentionResolve(args: Record<string, unknown>, ctx: HumanToolContext) {
  return transitionHumanAttention(args, ctx, 'resolve');
}

export async function humanInboxList(args: { unread_only?: boolean; type?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace');
  if (scopeError) return scopeError;
  const rows = await db.select().from(notifications).where(and(
    eq(notifications.org_id, ctx.org_id), eq(notifications.user_id, ctx.user_id),
    args.unread_only === false ? sql`true` : eq(notifications.is_read, false),
    args.type ? eq(notifications.type, args.type as any) : sql`true`,
  )).orderBy(desc(notifications.created_at)).limit(Math.min(Math.max(1, args.limit ?? 50), 100));
  return textResult(rows);
}

export async function humanInboxGet(args: { notification_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace'); if (scopeError) return scopeError;
  if (!args.notification_id) return errorResult('notification_id is required');
  const [row] = await db.select().from(notifications).where(and(eq(notifications.id, args.notification_id), eq(notifications.org_id, ctx.org_id), eq(notifications.user_id, ctx.user_id))).limit(1);
  return row ? textResult(row) : errorResult('Notification not found');
}

export async function humanInboxMarkRead(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace'); if (scopeError) return scopeError;
  if (typeof args.notification_id !== 'string') return errorResult('notification_id is required');
  return withIdempotency('inbox_mark_read', args, ctx, async () => {
    const [row] = await db.update(notifications).set({ is_read: true }).where(and(eq(notifications.id, args.notification_id as string), eq(notifications.org_id, ctx.org_id), eq(notifications.user_id, ctx.user_id))).returning();
    return row ? textResult({ marked_read: true, notification: row }) : errorResult('Notification not found');
  });
}

export async function humanInboxMarkAllRead(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace'); if (scopeError) return scopeError;
  return withIdempotency('inbox_mark_all_read', args, ctx, async () => {
    const rows = await db.update(notifications).set({ is_read: true }).where(and(eq(notifications.org_id, ctx.org_id), eq(notifications.user_id, ctx.user_id), eq(notifications.is_read, false))).returning({ id: notifications.id });
    return textResult({ marked_read: rows.length });
  });
}

async function ownApproval(ctx: HumanToolContext, actionId: string) {
  const canReview = ctx.role === 'owner' || ctx.role === 'admin'
    ? sql`true`
    : sql`COALESCE(
        ${agentActions.params}->>'source_user_id',
        ${agentActions.params}->>'origin_user_id',
        ${agentActions.user_id}
      ) = ${ctx.user_id}`;
  const [row] = await db.select().from(agentActions).where(and(
    eq(agentActions.id, actionId),
    eq(agentActions.org_id, ctx.org_id),
    canReview,
  )).limit(1);
  return row ?? null;
}

export async function humanApprovalList(args: { status?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace'); if (scopeError) return scopeError;
  const status = args.status ?? 'pending';
  if (!['pending', 'approved', 'rejected', 'expired', 'all'].includes(status)) return errorResult('status must be pending, approved, rejected, expired, or all');
  const canReview = ctx.role === 'owner' || ctx.role === 'admin'
    ? sql`true`
    : sql`COALESCE(${agentActions.params}->>'source_user_id', ${agentActions.params}->>'origin_user_id', ${agentActions.user_id}) = ${ctx.user_id}`;
  const rows = await db.select().from(agentActions).where(and(eq(agentActions.org_id, ctx.org_id), canReview, status === 'all' ? sql`true` : eq(agentActions.approval_status, status as any))).orderBy(desc(agentActions.created_at)).limit(Math.min(Math.max(1, args.limit ?? 50), 100));
  return textResult(rows.map((row) => ({ ...row, url: '/inbox?lane=needs_you' })));
}

export async function humanApprovalGet(args: { action_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace'); if (scopeError) return scopeError;
  if (!args.action_id) return errorResult('action_id is required');
  const row = await ownApproval(ctx, args.action_id);
  return row ? textResult({ ...row, url: '/inbox?lane=needs_you' }) : errorResult('Approval not found');
}

export async function humanApprovalApprove(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace'); if (scopeError) return scopeError;
  if (typeof args.action_id !== 'string') return errorResult('action_id is required');
  return withIdempotency('approval_approve', args, ctx, async () => {
    if (!(await ownApproval(ctx, args.action_id as string))) return errorResult('Approval not found');
    const result = await approveAction(args.action_id as string, ctx.user_id);
    return result.status === 'error' ? errorResult(`${result.code}: ${result.message}`) : textResult(result);
  });
}

export async function humanApprovalReject(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace'); if (scopeError) return scopeError;
  if (typeof args.action_id !== 'string') return errorResult('action_id is required');
  return withIdempotency('approval_reject', args, ctx, async () => {
    if (!(await ownApproval(ctx, args.action_id as string))) return errorResult('Approval not found');
    const result = await rejectAction(args.action_id as string, ctx.user_id, typeof args.reason === 'string' ? args.reason : undefined);
    return result.status === 'error' ? errorResult(`${result.code}: ${result.message}`) : textResult(result);
  });
}

function canManageWorkspace(ctx: HumanToolContext) { return ctx.role === 'owner' || ctx.role === 'admin'; }

export async function humanProjectCreate(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace'); if (scopeError) return scopeError;
  return withIdempotency('project_create', args, ctx, async () => {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const prefix = typeof args.prefix === 'string' ? args.prefix.trim().toUpperCase() : '';
    if (!name || !/^[A-Z0-9]{2,6}$/.test(prefix)) return errorResult('name and a unique 2-6 character alphanumeric prefix are required');
    const leadResult = await resolveActiveMember(ctx, { user_id: args.lead_id, label: 'project_create lead' });
    if (leadResult.error) return leadResult.error;
    const [duplicate] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.org_id, ctx.org_id), eq(projects.prefix, prefix))).limit(1);
    if (duplicate) return errorResult(`Project prefix ${prefix} is already in use`);
    const [created] = await db.insert(projects).values({ org_id: ctx.org_id, name, prefix, description: typeof args.description === 'string' ? args.description : null, color: typeof args.color === 'string' ? args.color : null, icon: typeof args.icon === 'string' ? args.icon : null, lead_id: leadResult.user?.id ?? null }).returning();
    return textResult({ created: true, project: created, url: `/tasks?project=${created!.id}` });
  });
}

export async function humanProjectUpdate(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace'); if (scopeError) return scopeError;
  if (typeof args.project_id !== 'string') return errorResult('project_id is required');
  return withIdempotency('project_update', args, ctx, async () => {
    if (!(await userCanSeeProject(ctx, args.project_id as string))) return errorResult('Project not found');
    const updates: Record<string, unknown> = {};
    for (const field of ['name', 'description', 'color', 'icon'] as const) if (args[field] !== undefined) updates[field] = args[field];
    if (args.lead_id === null) updates.lead_id = null;
    else if (args.lead_id !== undefined) {
      const leadResult = await resolveActiveMember(ctx, { user_id: args.lead_id, label: 'project_update lead' });
      if (leadResult.error) return leadResult.error;
      updates.lead_id = leadResult.user?.id ?? null;
    }
    if (Object.keys(updates).length === 0) return errorResult('At least one editable project field is required');
    const [updated] = await db.update(projects).set(updates).where(and(eq(projects.id, args.project_id as string), eq(projects.org_id, ctx.org_id))).returning();
    return textResult({ updated: true, project: updated, url: `/tasks?project=${updated!.id}` });
  });
}

export async function humanProjectArchive(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace'); if (scopeError) return scopeError;
  if (typeof args.project_id !== 'string') return errorResult('project_id is required');
  return withIdempotency('project_archive', args, ctx, async () => {
    const [updated] = await db.update(projects).set({ is_archived: args.archived !== false }).where(and(eq(projects.id, args.project_id as string), eq(projects.org_id, ctx.org_id), eq(projects.is_deleted, false))).returning();
    return updated ? textResult({ archived: updated.is_archived, project: updated, url: `/tasks?project=${updated.id}` }) : errorResult('Project not found');
  });
}

export async function humanTaskSavedViewList(args: { project_id?: string; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:tasks'); if (scopeError) return scopeError;
  const rows = await db.select().from(savedViews).where(and(eq(savedViews.org_id, ctx.org_id), or(eq(savedViews.user_id, ctx.user_id), eq(savedViews.is_shared, true)), args.project_id ? eq(savedViews.project_id, args.project_id) : sql`true`)).orderBy(desc(savedViews.updated_at)).limit(Math.min(Math.max(1, args.limit ?? 50), 100));
  return textResult(rows);
}

export async function humanTaskSavedViewCreate(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:tasks'); if (scopeError) return scopeError;
  return withIdempotency('task_saved_view_create', args, ctx, async () => {
    if (typeof args.name !== 'string' || !args.name.trim() || !args.config || typeof args.config !== 'object') return errorResult('name and config are required');
    if (typeof args.project_id === 'string' && !(await userCanSeeProject(ctx, args.project_id))) return errorResult('Project not found');
    const [created] = await db.insert(savedViews).values({ org_id: ctx.org_id, user_id: ctx.user_id, project_id: typeof args.project_id === 'string' ? args.project_id : null, name: args.name.trim(), config: args.config, is_shared: args.is_shared === true && canManageWorkspace(ctx) }).returning();
    return textResult({ created: true, saved_view: created });
  });
}

export async function humanAgentEmployeeList(args: { include_paused?: boolean; limit?: number }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace'); if (scopeError) return scopeError;
  const rows = await db.select({ id: agentEmployees.id, name: agentEmployees.name, slug: agentEmployees.slug, role: agentEmployees.role, job_title: agentEmployees.job_title, runtime_kind: agentEmployees.runtime_kind, is_active: agentEmployees.is_active, unhealthy: agentEmployees.unhealthy, unhealthy_reason: agentEmployees.unhealthy_reason, certification_status: agentEmployees.certification_status, last_mcp_call_at: agentEmployees.last_mcp_call_at, last_work_outcome_at: agentEmployees.last_work_outcome_at }).from(agentEmployees).where(and(eq(agentEmployees.org_id, ctx.org_id), eq(agentEmployees.is_deleted, false), args.include_paused ? sql`true` : eq(agentEmployees.is_active, true))).orderBy(agentEmployees.name).limit(Math.min(Math.max(1, args.limit ?? 50), 100));
  return textResult(rows.map((row) => ({ ...row, url: `/settings/agent-employees/${row.id}` })));
}

export async function humanAgentEmployeeGet(args: { employee_id?: string }, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'read:workspace'); if (scopeError) return scopeError;
  if (!args.employee_id) return errorResult('employee_id is required');
  const [row] = await db.select({ id: agentEmployees.id, name: agentEmployees.name, slug: agentEmployees.slug, role: agentEmployees.role, job_title: agentEmployees.job_title, expertise_description: agentEmployees.expertise_description, runtime_kind: agentEmployees.runtime_kind, trust_level: agentEmployees.trust_level, max_daily_actions: agentEmployees.max_daily_actions, daily_action_count: agentEmployees.daily_action_count, is_active: agentEmployees.is_active, unhealthy: agentEmployees.unhealthy, unhealthy_reason: agentEmployees.unhealthy_reason, certification_status: agentEmployees.certification_status, last_verified_at: agentEmployees.last_verified_at, last_mcp_call_at: agentEmployees.last_mcp_call_at, last_work_outcome_at: agentEmployees.last_work_outcome_at }).from(agentEmployees).where(and(eq(agentEmployees.id, args.employee_id), eq(agentEmployees.org_id, ctx.org_id), eq(agentEmployees.is_deleted, false))).limit(1);
  return row ? textResult({ ...row, url: `/settings/agent-employees/${row.id}` }) : errorResult('Agent employee not found');
}

export async function humanAgentEmployeeUpdateState(args: Record<string, unknown>, ctx: HumanToolContext): Promise<ToolResult> {
  const scopeError = requireScope(ctx, 'write:workspace'); if (scopeError) return scopeError;
  if (!canManageWorkspace(ctx)) return errorResult('Only workspace owners and admins can pause, resume, or mark an agent healthy');
  if (typeof args.employee_id !== 'string') return errorResult('employee_id is required');
  return withIdempotency('agent_employee_update_state', args, ctx, async () => {
    const updates: Record<string, unknown> = {};
    if (args.state === 'paused') updates.is_active = false;
    else if (args.state === 'active') updates.is_active = true;
    else if (args.state === 'healthy') { updates.unhealthy = false; updates.unhealthy_reason = null; }
    else return errorResult('state must be active, paused, or healthy');
    const [updated] = await db.update(agentEmployees).set(updates).where(and(eq(agentEmployees.id, args.employee_id as string), eq(agentEmployees.org_id, ctx.org_id), eq(agentEmployees.is_deleted, false))).returning({ id: agentEmployees.id, name: agentEmployees.name, is_active: agentEmployees.is_active, unhealthy: agentEmployees.unhealthy });
    return updated ? textResult({ updated: true, employee: updated, url: `/settings/agent-employees/${updated.id}` }) : errorResult('Agent employee not found');
  });
}

export const HUMAN_TOOL_SCOPES: Record<string, string> = {
  search: 'read:workspace', fetch: 'read:workspace', platform_context: 'read:workspace', attention_digest: 'read:workspace',
  member_list: 'read:workspace', resolve_member: 'read:workspace', resolve_targets: 'read:workspace', member_get: 'read:workspace', activity_query: 'read:workspace',
  events_query: 'read:calendar', memory_recall: 'read:wiki', wiki_search: 'read:wiki', memory_list: 'read:wiki',
  list_my_tasks: 'read:tasks', task_get: 'read:tasks', task_query: 'read:tasks', task_saved_view_get: 'read:tasks',
  project_list: 'read:workspace', resolve_project: 'read:workspace', project_get: 'read:workspace',
  space_list: 'read:messages', resolve_space: 'read:messages', space_get: 'read:messages', thread_fetch: 'read:messages', messages_recent: 'read:messages', messages_search: 'read:messages',
  project_progress: 'read:tasks', team_workload: 'read:tasks', team_list: 'read:workspace', team_get: 'read:workspace', team_context: 'read:workspace',
  memory_write: 'write:wiki', wiki_upsert: 'write:wiki', task_create: 'write:tasks', task_update: 'write:tasks', task_bulk_update: 'write:tasks', task_transition: 'write:tasks', comment_on_task: 'write:tasks',
  message_post: 'write:messages', send_message: 'write:messages',
  workspace_capabilities: 'read:workspace', note_list: 'read:workspace', note_get: 'read:workspace',
  note_create: 'write:workspace', note_update: 'write:workspace', note_archive: 'write:workspace',
  calendar_list: 'read:calendar', calendar_get: 'read:calendar', calendar_availability: 'read:calendar',
  calendar_event_create: 'write:calendar', calendar_event_update: 'write:calendar', calendar_event_cancel: 'write:calendar',
  inbox_list: 'read:workspace', inbox_get: 'read:workspace', inbox_mark_read: 'write:workspace', inbox_mark_all_read: 'write:workspace',
  attention_list: 'read:workspace', attention_get: 'read:workspace', attention_acknowledge: 'write:workspace', attention_snooze: 'write:workspace', attention_resolve: 'write:workspace',
  approval_list: 'read:workspace', approval_get: 'read:workspace', approval_approve: 'write:workspace', approval_reject: 'write:workspace',
  project_create: 'write:workspace', project_update: 'write:workspace', project_archive: 'write:workspace',
  task_saved_view_list: 'read:tasks', task_saved_view_create: 'write:tasks',
  agent_employee_list: 'read:workspace', agent_employee_get: 'read:workspace', agent_employee_update_state: 'write:workspace',
};

function operationalHumanSchemas(): Array<Record<string, unknown>> {
  const read = (name: string, title: string, description: string, properties: Record<string, unknown> = {}, required?: string[]) => ({
    name, title, description, annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties, ...(required ? { required } : {}) },
  });
  const write = (name: string, title: string, description: string, properties: Record<string, unknown> = {}, required?: string[]) => ({
    name, title, description: `${description} Reuse idempotency_key when retrying the same intent.`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: { type: 'object', properties: { ...properties, idempotency_key: { type: 'string', description: 'Stable retry key.' } }, ...(required ? { required } : {}) },
  });
  const id = (description: string) => ({ type: 'string', description });
  const limit = { type: 'integer', minimum: 1, maximum: 100 };
  const iso = (description: string) => ({ type: 'string', description });
  return [
    read('workspace_capabilities', 'Inspect Deft MCP Capabilities', 'Return granted scopes, available operational tools, usage guidance, and the intentionally UI-only boundary.'),
    read('note_list', 'List Deft Notes', 'List private notes owned by the connected user plus org/space notes they can see.', { query: { type: 'string' }, limit }),
    read('note_get', 'Get Deft Note', 'Read one visible note including its full TipTap HTML content.', { note_id: id('Note id') }, ['note_id']),
    write('note_create', 'Create Deft Note', 'Create a private, org, or space-visible note as the connected user.', { title: { type: 'string' }, content: { type: 'string' }, icon: { type: 'string' }, is_pinned: { type: 'boolean' }, visibility: { type: 'string', enum: ['private', 'org', 'space'] }, visibility_space_id: id('Required for space visibility') }),
    write('note_update', 'Update Deft Note', 'Update a note owned by the connected user with optimistic version protection.', { note_id: id('Note id'), title: { type: 'string' }, content: { type: 'string' }, icon: { type: ['string', 'null'] }, is_pinned: { type: 'boolean' }, visibility: { type: 'string', enum: ['private', 'org', 'space'] }, visibility_space_id: { type: ['string', 'null'] } }, ['note_id']),
    write('note_archive', 'Archive Deft Note', 'Soft-delete a note owned by the connected user.', { note_id: id('Note id') }, ['note_id']),
    read('calendar_list', 'List Deft Calendar Events', "List the connected user's native and imported calendar events in a time range.", { from: iso('ISO range start'), until: iso('ISO range end'), limit }),
    read('calendar_get', 'Get Deft Calendar Event', 'Read one visible native or imported calendar event.', { event_id: id('Event id') }, ['event_id']),
    read('calendar_availability', 'Check Deft Calendar Availability', 'Return busy windows from native and imported calendar context.', { from: iso('ISO range start'), until: iso('ISO range end') }),
    write('calendar_event_create', 'Create Deft Calendar Event', 'Create a native Deft calendar event owned by the connected user.', { title: { type: 'string' }, start: iso('ISO start'), end: iso('ISO end'), description: { type: 'string' }, location: { type: 'string' }, all_day: { type: 'boolean' } }, ['title', 'start', 'end']),
    write('calendar_event_update', 'Update Deft Calendar Event', 'Update a native event owned by the connected user. Imported ICS events remain read-only.', { event_id: id('Event id'), title: { type: 'string' }, start: iso('ISO start'), end: iso('ISO end'), description: { type: ['string', 'null'] }, location: { type: ['string', 'null'] } }, ['event_id']),
    { ...write('calendar_event_cancel', 'Cancel Deft Calendar Event', 'Remove a native event owned by the connected user. Imported events cannot be changed.', { event_id: id('Event id') }, ['event_id']), annotations: { readOnlyHint: false, destructiveHint: true } },
    read('inbox_list', 'List Deft Inbox', 'List notifications for the connected user.', { unread_only: { type: 'boolean' }, type: { type: 'string' }, limit }),
    read('inbox_get', 'Get Deft Inbox Item', 'Read one notification owned by the connected user.', { notification_id: id('Notification id') }, ['notification_id']),
    write('inbox_mark_read', 'Mark Deft Inbox Item Read', 'Mark one owned notification read.', { notification_id: id('Notification id') }, ['notification_id']),
    write('inbox_mark_all_read', 'Mark Deft Inbox Read', 'Mark all unread notifications for the connected user read.'),
    read('attention_list', 'List Deft Attention', 'List the connected user\'s durable Needs-you or Updates items with counts and lifecycle state.', { lane: { type: 'string', enum: ['needs_you', 'updates', 'all'] }, state: { type: 'string', enum: ['open', 'all', 'open_unseen', 'open_seen', 'acknowledged', 'snoozed', 'resolved', 'expired', 'superseded'] }, limit }),
    read('attention_get', 'Get Deft Attention Item', 'Read one durable attention item owned by the connected user.', { attention_id: id('Attention item id') }, ['attention_id']),
    write('attention_acknowledge', 'Acknowledge Deft Attention', 'Accept responsibility for an open item without claiming the underlying work is resolved.', { attention_id: id('Attention item id') }, ['attention_id']),
    write('attention_snooze', 'Snooze Deft Attention', 'Hide an attention item until a future ISO timestamp.', { attention_id: id('Attention item id'), until: iso('Future ISO timestamp') }, ['attention_id', 'until']),
    write('attention_resolve', 'Resolve Deft Attention', 'Clear an attention item without mutating its source object.', { attention_id: id('Attention item id'), resolution: { type: 'string' } }, ['attention_id']),
    read('approval_list', 'List Deft Approvals', 'List pending or historical approval actions assigned to the connected user.', { status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired', 'all'] }, limit }),
    read('approval_get', 'Get Deft Approval', 'Read one approval assigned to the connected user, including exact action parameters.', { action_id: id('Approval action id') }, ['action_id']),
    write('approval_approve', 'Approve Deft Action', 'Approve and execute one pending action assigned to the connected user through the canonical approval resolver.', { action_id: id('Approval action id') }, ['action_id']),
    write('approval_reject', 'Reject Deft Action', 'Reject one pending action assigned to the connected user.', { action_id: id('Approval action id'), reason: { type: 'string' } }, ['action_id']),
    write('project_create', 'Create Deft Project', 'Create a project with fixed Deft workflow defaults.', { name: { type: 'string' }, prefix: { type: 'string', minLength: 2, maxLength: 6 }, description: { type: 'string' }, color: { type: 'string' }, icon: { type: 'string' }, lead_id: id('Optional member user id') }, ['name', 'prefix']),
    write('project_update', 'Update Deft Project', 'Update editable fields on an active project. Prefixes remain immutable.', { project_id: id('Project id'), name: { type: 'string' }, description: { type: ['string', 'null'] }, color: { type: ['string', 'null'] }, icon: { type: ['string', 'null'] }, lead_id: { type: ['string', 'null'] } }, ['project_id']),
    write('project_archive', 'Archive Or Restore Deft Project', 'Archive or unarchive a project without deleting its task history.', { project_id: id('Project id'), archived: { type: 'boolean', description: 'Defaults to true.' } }, ['project_id']),
    read('task_saved_view_list', 'List Deft Task Saved Views', 'List personal and shared task views available to the connected user.', { project_id: id('Optional project id'), limit }),
    write('task_saved_view_create', 'Create Deft Task Saved View', 'Save task filters, sorting, grouping, and columns as a personal view. Admins may share it.', { name: { type: 'string' }, project_id: id('Optional project id'), config: { type: 'object', additionalProperties: true }, is_shared: { type: 'boolean' } }, ['name', 'config']),
    read('agent_employee_list', 'List Deft Agent Employees', 'List agent employees and their operational health without exposing credentials.', { include_paused: { type: 'boolean' }, limit }),
    read('agent_employee_get', 'Get Deft Agent Employee', "Read one agent employee's health, certification, limits, and recent contact state without exposing credentials.", { employee_id: id('Agent employee id') }, ['employee_id']),
    write('agent_employee_update_state', 'Update Deft Agent State', 'Owner/admin-only control to pause, resume, or clear an unhealthy circuit breaker. Credential operations remain UI-only.', { employee_id: id('Agent employee id'), state: { type: 'string', enum: ['active', 'paused', 'healthy'] } }, ['employee_id', 'state']),
  ];
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
    ...operationalHumanSchemas(),
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
      name: 'attention_digest',
      title: 'Get My Deft Attention Digest',
      description: 'Single-call triage for a connected human: unread messages, mentions, assigned tasks, overdue work, upcoming calendar items, and pending approvals. Use this first for "what needs my attention?" Human personal-MCP read: uses whichever read scopes are granted.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          space_id: { type: 'string', description: 'Optional space id to focus the digest.' },
          space_name: { type: 'string', description: 'Optional space name to focus the digest, such as marketing-launch.' },
          since: { type: 'string', description: 'Optional ISO timestamp lower bound.' },
          include_recent: { type: 'boolean', description: 'Include recent messages when there are no unread messages. Defaults to true.' },
          include_calendar: { type: 'boolean', description: 'Include upcoming calendar events when read:calendar is granted. Defaults to true.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
    },
    {
      name: 'messages_recent',
      title: 'Get Recent Deft Messages',
      description: 'Fetch recent visible chat messages without requiring a keyword. Use this when search is too narrow or the user asks for recent/unread context. Human personal-MCP read: requires read:messages.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          space_id: { type: 'string' },
          space_name: { type: 'string' },
          author_user_id: { type: 'string' },
          author_name: { type: 'string' },
          mentions_me: { type: 'boolean' },
          since: { type: 'string' },
          until: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
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
      name: 'resolve_project',
      title: 'Resolve Deft Project',
      description: 'Resolve a human project name, prefix, or task key fragment to a Deft project id before creating tasks. Returns resolved/ambiguous/not_found plus candidates and confidence. Use this when a user says a project name in natural language. Human personal-MCP read: requires read:workspace.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Project name, prefix, or task key fragment such as Marketing Launch, MKT, or MKT-18.' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
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
      name: 'resolve_space',
      title: 'Resolve Deft Space',
      description: 'Resolve a human channel/space name to a visible Deft space id before reading or posting messages. Handles #names and hyphen/space differences such as buyer updates -> buyer-updates. Returns resolved/ambiguous/not_found plus candidates and confidence. Human personal-MCP read: requires read:messages.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Space or channel name, with or without #.' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
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
      name: 'resolve_member',
      title: 'Resolve Deft Member',
      description: 'Resolve a human person name or email to an active Deft member id before assigning work or sending a DM. Returns resolved/ambiguous/not_found plus candidates and confidence. Human personal-MCP read: requires read:workspace.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Person name or email.' },
          include_agents: { type: 'boolean', description: 'Include agent/system users. Defaults to true.' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
    },
    {
      name: 'resolve_targets',
      title: 'Resolve Multiple Deft Targets',
      description: 'Resolve several natural-language Deft targets in one call: spaces, members, and projects. Use this before multi-step owner/operator workflows so later task_create, wiki_upsert, and send_message calls can use confirmed ids instead of guessing. Returns per-query resolved/ambiguous/not_found results. Human personal-MCP read: requires read:workspace and uses read:messages for spaces.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          spaces: { type: 'array', items: { type: 'string' }, maxItems: 10 },
          members: { type: 'array', items: { type: 'string' }, maxItems: 10 },
          projects: { type: 'array', items: { type: 'string' }, maxItems: 10 },
          include_agents: { type: 'boolean', description: 'Include agent/system users in member resolution. Defaults to true.' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
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
      name: 'task_saved_view_get',
      title: 'Get Deft Task Saved View',
      description: 'Read one personal or shared saved task view as query configuration. Saved layouts are read-only through MCP. Human personal-MCP read: requires read:tasks.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { saved_view_id: { type: 'string' } },
        required: ['saved_view_id'],
      },
    },
    {
      name: 'task_bulk_update',
      title: 'Bulk Update Deft Tasks',
      description: 'Update up to 50 visible tasks atomically with the same canonical fields used by the task table. Always include idempotency_key for retry-safe writes. Human personal-MCP write: requires write:tasks.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          task_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
          updates: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'] },
              priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
              assignee_id: { type: ['string', 'null'] },
              due_date: { type: ['string', 'null'] },
              start_date: { type: ['string', 'null'] },
              estimation: { type: ['string', 'null'] },
              add_label_ids: { type: 'array', items: { type: 'string' }, maxItems: 50 },
              remove_label_ids: { type: 'array', items: { type: 'string' }, maxItems: 50 },
            },
            additionalProperties: false,
          },
          idempotency_key: { type: 'string', description: 'Stable key for retry-safe writes. Reusing the same key returns the first successful result.' },
        },
        required: ['task_ids', 'updates'],
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
    {
      name: 'wiki_upsert',
      title: 'Create Or Update Deft Knowledge',
      description: 'Create or update a wiki page as the connected human. Prefer this over memory_write when adding durable knowledge because it updates an existing matching slug/title instead of creating duplicates. Always include idempotency_key for retry-safe writes. Human personal-MCP write: requires write:wiki.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          slug: { type: 'string', description: 'Optional stable slug. If it exists, the page is updated.' },
          content: { type: 'string' },
          summary: { type: 'string' },
          type: { type: 'string', enum: ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'] },
          scope: { type: 'string', enum: ['org', 'space', 'user'] },
          space_id: { type: 'string' },
          space_name: { type: 'string' },
          source_message_id: { type: 'string', description: 'Optional visible message id to cite as the source.' },
          tags: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          idempotency_key: { type: 'string', description: 'Stable key for retry-safe writes. Reusing the same key returns the first successful result.' },
        },
        required: ['title', 'content'],
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
        if (String(next.name) === 'memory_write') {
          next.description = `${next.description ?? ''} Prefer wiki_upsert for durable company knowledge because wiki_upsert can update an existing page by slug/title and keeps better receipts.`;
        }
        if (String(next.name) === 'task_create' && inputSchema?.properties) {
          next.description = `${next.description ?? ''} If the user gives project or assignee names instead of ids, call resolve_targets or resolve_project/resolve_member first when there is any ambiguity.`;
          inputSchema.properties.project_name = {
            type: 'string',
            description: 'Optional project name. Prefer project_id from resolve_project/resolve_targets when the name is fuzzy.',
          };
          inputSchema.properties.project_identifier = {
            type: 'string',
            description: 'Optional project prefix/key such as MKT or MKT-18. Deft resolves the project inside the user org.',
          };
          inputSchema.properties.assignee_email = {
            type: 'string',
            description: 'Optional assignee email. Use this when you know the person email but not the user id.',
          };
          inputSchema.properties.due_date = {
            type: 'string',
            description: 'Optional ISO date/timestamp for the task due date.',
          };
          inputSchema.properties.start_date = {
            type: 'string',
            description: 'Optional ISO date/timestamp for the task start date.',
          };
          inputSchema.properties.estimation = {
            type: 'string',
            description: 'Optional human estimation such as 30m, 2h, or 1d.',
          };
        }
        if (String(next.name) === 'send_message' && inputSchema?.properties) {
          next.description = 'Send a Deft chat message as the connected human. Target can be a space, thread, or person; person targets may use user_id, email, or person_name. Prefer this over message_post for human-facing workflows. Use resolve_targets/resolve_space/resolve_member first when a target name is fuzzy. Always include idempotency_key for retry-safe writes. Human personal-MCP write: requires write:messages.';
          inputSchema.properties.space_id = { type: 'string', description: 'Optional target space id. Prefer this after resolve_space/resolve_targets.' };
          inputSchema.properties.space_name = { type: 'string', description: 'Optional target space name such as marketing-launch. Exact and high-confidence human wording is accepted; otherwise resolve first.' };
          inputSchema.properties.thread_id = { type: 'string', description: 'Optional parent message id; sends as a thread reply.' };
          inputSchema.properties.user_id = { type: 'string', description: 'Optional DM target user id.' };
          inputSchema.properties.email = { type: 'string', description: 'Optional DM target email.' };
          inputSchema.properties.person_name = { type: 'string', description: 'Optional DM target person name. Prefer user_id from resolve_member/resolve_targets when the name is fuzzy.' };
          (next.inputSchema as Record<string, unknown>).additionalProperties = true;
        }
      } else {
        next.description = `${next.description ?? ''} Human personal-MCP read: scoped to the token owner's Deft permissions.`;
        next.annotations = { ...(next.annotations as Record<string, unknown> | undefined), readOnlyHint: true };
      }
      return next;
    });
  const existingNames = new Set(existing.map((schema) => String(schema.name ?? '')));
  return [
    ...compatibilitySchemas.filter((schema) => !existingNames.has(String(schema.name ?? ''))),
    ...existing,
  ];
}
