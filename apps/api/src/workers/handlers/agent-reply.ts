// Handler: process @agent/@deft mentions in chat and generate AI replies in-thread
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { messages, users, spaces, spaceMembers, projects, tasks, wikiPages, notes } from '@deft/db/schema';
import { getApprovalTier } from '../../lib/agent-approval.js';
import { eq, and, desc, sql, ne, lt, inArray } from 'drizzle-orm';
import { getIO } from '../../socket.js';
import { runAgentQuery } from '../../lib/agent-runner.js';
import { ensureDeftyMembership, DEFTY_NAME } from '../../lib/ensure-defty-membership.js';
import { toPlainText, truncatePlainText } from '../../lib/plain-text.js';
import { resolveSpaceTarget } from '../../lib/resolve-space-target.js';
import { resolveAssigneeWithMatches } from '../../lib/resolve-assignee.js';
import { resolveProjectTarget } from '../../lib/resolve-project-target.js';
import {
  compileDeftyActionDraft,
  persistAgentReplyWithActions,
  sanitizeAgentReplyActionMetadata,
  validateRegisteredProposalAction,
} from '../../lib/agent-action-proposals.js';

function stripMentionSyntax(content: string): string {
  return toPlainText(content)
    .replace(/<@[a-zA-Z0-9_-]+(?:\|[^>]+)?>/g, '')
    .replace(/@(agent|defty|deft)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasExplicitCreateTaskIntent(content: string): boolean {
  const plain = stripMentionSyntax(content);
  const positive =
    /\b(?:create|add|make|open|track)\b.{0,80}\b(?:task|todo|ticket)\b/i.test(plain) ||
    /\b(?:task|todo|ticket)\b.{0,40}\b(?:needs? to|should|for)\b/i.test(plain);
  if (!positive) return false;

  return !/\b(?:do\s+not|don't|dont|never|without|avoid|no\s+need\s+to)\s+(?:\S+\s+){0,6}?(?:create|creating|make|making|add|adding|open|opening|track|tracking)\s+(?:\S+\s+){0,6}?(?:task|todo|ticket)s?\b/i.test(plain);
}

export function hasExplicitRegisteredWriteIntent(content: string): boolean {
  const plain = stripMentionSyntax(content);
  const asksForChange = /\b(?:create|add|make|open|track|write|save|record|capture|post|send|put|share|update|edit|change|set|mark|move|close|reopen|assign|comment|label|link|unlink|remove|promote|convert)\b/i.test(plain);
  const namesWorkspaceObject =
    /\b(?:tasks?|todos?|tickets?|subtasks?|messages?|announcements?|channels?|spaces?|wiki|pages?|knowledge|facts?|decisions?|resources?|notes?|canvas|reminders?|status|assignees?|priorities|due dates?|labels?|dependencies|thread replies)\b/i.test(plain) ||
    /\b(?:post|send|put|share)\b.{0,80}(?:#|\bchannel\s+|\bspace\s+)[a-z0-9]/i.test(plain);
  if (!asksForChange || !namesWorkspaceObject) return false;

  if (/\b(?:do\s+not|don't|dont|never)\s+(?:create|queue|post|send|write|save|record|update|edit|change|mark|move|close|assign)(?:\s+or\s+(?:create|queue|post|send|write|update))?\s+(?:any\s+)?(?:tasks?|actions?|changes?|messages?|posts?|pages?|notes?|reminders?)\b/i.test(plain)) {
    return false;
  }

  return !/\b(?:do\s+not|don't|dont|never|without|avoid|no\s+need\s+to)\s+(?:\S+\s+){0,6}?(?:create|add|make|write|save|record|capture|post|send|update|edit|change|set|mark|move|close|reopen|assign|link|remove)\b/i.test(plain);
}

export function shouldCompileRuntimeWikiSuggestion(
  content: string,
  executedActions: Array<{ action?: unknown }>,
): boolean {
  const asksForEdit = /\b(?:update|edit|revise|correct|append|add)\b/i.test(stripMentionSyntax(content));
  return asksForEdit && executedActions.some((action) => action.action === 'wiki_suggest_update');
}

export function mergeWikiUpdateContent(
  existingContent: string,
  requestedContent: string,
  operation: unknown,
): string {
  const existing = existingContent.trim();
  const requested = requestedContent.trim();
  if (operation !== 'append' || !existing || !requested) return requested || existing;
  if (existing.toLowerCase().includes(requested.toLowerCase())) return existing;
  return `${existing}\n\n${requested}`;
}

function titleCaseTaskFragment(value: string): string {
  const cleaned = value
    .replace(/\b(?:a|an|the)\s+/i, '')
    .replace(/\b(?:needs?|should|has)\s+to\s+(?:go\s+out\s+to\s+)?/i, '')
    .replace(/\b(?:please|pls)\b/gi, '')
    .replace(/\s+[-:]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned
    .split(/\s+/)
    .map((word) => {
      if (/^[A-Z0-9-]{2,}$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function inferTaskTitle(content: string): string | null {
  const plain = stripMentionSyntax(content);
  const quoted = plain.match(/\b(?:task|todo|ticket)\s+(?:titled|called|named)\s+"([^"]+)"/i)?.[1]
    ?? plain.match(/\b(?:task|todo|ticket)\s+(?:titled|called|named)\s+'([^']+)'/i)?.[1]
    ?? plain.match(/\bname\s+(?:it|this|the\s+(?:task|todo|ticket))\s+"([^"]+)"/i)?.[1]
    ?? plain.match(/\bname\s+(?:it|this|the\s+(?:task|todo|ticket))\s+'([^']+)'/i)?.[1];
  if (quoted?.trim()) return truncatePlainText(quoted.trim(), 80);

  const subject =
    plain.match(/\bname\s+(?:it|this|the\s+(?:task|todo|ticket))\s+(.+?)(?:\s+(?:and|assign|assigned|due|with|by|for)\b|[.;\n]|$)/i)?.[1] ??
    plain.match(/\b(?:task|todo|ticket)\s+(?:for|about|to)\s+(.+?)(?:\s+(?:assigned?|assign|due|with|by|for)\b|[.;\n]|$)/i)?.[1] ??
    plain.match(/\b(?:create|add|make|open|track)\b.{0,30}\b(?:task|todo|ticket)(?:\s+draft)?\s+(?:from|for|about|to)\s+(.+?)(?:\s+(?:assigned?|assign|due|with|by|for)\b|[.;\n]|$)/i)?.[1] ??
    plain.match(/\b(?:create|add|make|open|track)\b.{0,30}\b(?:task|todo|ticket)\b(?:\s+with\s+[^.]+)?[.;]\s*(.+?)(?:\s+(?:assigned?|assign|due|with|by|for)\b|[.;\n]|$)/i)?.[1] ??
    plain.match(/\b(?:a|an|the)\s+(.+?)\s+(?:needs?|should|has)\s+to\s+(?:go\s+out\s+to\s+)?(.+?)(?:\s+(?:assigned?|assign|due|with|by)\b|[.;\n]|$)/i)?.slice(1).filter(Boolean).join(' to ');

  const title = titleCaseTaskFragment(subject ?? '');
  return title ? truncatePlainText(title, 80) : null;
}

function inferAssigneeName(content: string): string | undefined {
  const plain = stripMentionSyntax(content);
  const match =
    plain.match(/\bassign(?:\s+it)?\s+to\s+([^.;\n]+?)(?:\s+(?:and|with|for|by|due)\b|[.;\n]|$)/i)?.[1] ??
    plain.match(/\bassign\s+((?!(?:and|with|for|by|due)\b)[\p{L}][\p{L}.'-]*(?:\s+(?!(?:and|with|for|by|due)\b)[\p{L}][\p{L}.'-]*)?)(?=\s+(?:and|with|for|by|due)\b|[.;\n]|$)/iu)?.[1] ??
    plain.match(/\bassigned\s+to\s+([^.;\n]+?)(?:\s+(?:and|with|for|by|due)\b|[.;\n]|$)/i)?.[1] ??
    plain.match(/\b(?:next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|today|\d{4}-\d{2}-\d{2})\s+to\s+([^.;\n]+?)(?:\s+(?:and|with|for|by|due)\b|[.;\n]|$)/i)?.[1] ??
    plain.match(/\bfor\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?:\s+(?:by|due|to|with)\b|[.;\n]|$)/)?.[1];
  return match?.trim();
}

function nextWeekdayIso(now: Date, weekday: number): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const current = date.getUTCDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) delta = 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function addDaysIso(now: Date, days: number): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inferDueDate(content: string, now = new Date()): string | undefined {
  const plain = stripMentionSyntax(content);
  const iso = plain.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (iso) return iso;
  if (/\btoday\b/i.test(plain)) return addDaysIso(now, 0);
  if (/\btomorrow\b/i.test(plain)) return addDaysIso(now, 1);
  if (/\bnext\s+monday\b/i.test(plain)) return nextWeekdayIso(now, 1);
  if (/\bnext\s+tuesday\b/i.test(plain)) return nextWeekdayIso(now, 2);
  if (/\bnext\s+wednesday\b/i.test(plain)) return nextWeekdayIso(now, 3);
  if (/\bnext\s+thursday\b/i.test(plain)) return nextWeekdayIso(now, 4);
  if (/\bnext\s+friday\b/i.test(plain)) return nextWeekdayIso(now, 5);
  if (/\bnext\s+saturday\b/i.test(plain)) return nextWeekdayIso(now, 6);
  if (/\bnext\s+sunday\b/i.test(plain)) return nextWeekdayIso(now, 0);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function resolvePendingActionTargets(
  orgId: string,
  userId: string,
  sourceSpaceId: string,
  actions: any[],
): Promise<{ actions: any[]; warnings: string[] }> {
  const resolvedActions: any[] = [];
  const warnings: string[] = [];

  for (const action of actions) {
    if (!isRecord(action?.params)) {
      resolvedActions.push(action);
      continue;
    }

    if (action.action === 'create_task') {
      const params = action.params;
      let projectName = typeof params.project_name === 'string' ? params.project_name.trim() : '';
      if (!projectName) {
        projectName = extractExplicitProjectName(
          [params.title, params.description].filter(Boolean).join('\n'),
        ) ?? '';
      }

      const projectResolution = await resolveProjectTarget(orgId, {
        projectName,
        sourceSpaceId: typeof params.source_space_id === 'string' ? params.source_space_id : sourceSpaceId,
      });
      if (projectResolution.status !== 'resolved') {
        warnings.push(projectResolution.message);
        continue;
      }
      const project = projectResolution.project;

      if (typeof params.assignee_name === 'string' && params.assignee_name.trim()) {
        const resolvedAssignee = await resolveAssigneeWithMatches(params.assignee_name.trim(), orgId);
        if (!resolvedAssignee.ok) {
          if (resolvedAssignee.ambiguous) {
            warnings.push(`I need the exact assignee. "${params.assignee_name}" matches: ${resolvedAssignee.matches.map((m) => m.name).join(', ')}.`);
          } else {
            warnings.push(`I could not find a workspace member named "${params.assignee_name}".`);
          }
          continue;
        }
      }

      resolvedActions.push({
        ...action,
        params: {
          ...params,
          project_name: project.name,
          resolved_project_id: project.id,
        },
      });
      continue;
    }

    if (action.action === 'update_task_status') {
      const taskIdentifier = typeof action.params.task_identifier === 'string'
        ? action.params.task_identifier.trim()
        : '';
      const newStatus = typeof action.params.new_status === 'string'
        ? action.params.new_status.trim()
        : '';
      if (!taskIdentifier) {
        warnings.push('I need the exact task id before I can create the status-update approval card.');
        continue;
      }
      if (!['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'].includes(newStatus)) {
        warnings.push(`I need a valid target status for ${taskIdentifier}: backlog, todo, in_progress, in_review, done, or cancelled.`);
        continue;
      }

      let resolvedTaskId = '';
      const shorthand = taskIdentifier.match(/^([A-Z]+)-(\d+)$/i);
      if (shorthand) {
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.org_id, orgId), eq(projects.prefix, shorthand[1]!.toUpperCase())))
          .limit(1);
        if (project) {
          const [foundTask] = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(
              eq(tasks.org_id, orgId),
              eq(tasks.project_id, project.id),
              eq(tasks.number, Number.parseInt(shorthand[2]!, 10)),
            ))
            .limit(1);
          resolvedTaskId = foundTask?.id ?? '';
        }
      } else {
        const [foundTask] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.org_id, orgId), eq(tasks.id, taskIdentifier)))
          .limit(1);
        resolvedTaskId = foundTask?.id ?? '';
      }

      if (!resolvedTaskId) {
        warnings.push(`I could not find task "${taskIdentifier}" in this workspace.`);
        continue;
      }

      resolvedActions.push({
        ...action,
        params: {
          ...action.params,
          task_identifier: shorthand ? taskIdentifier.toUpperCase() : taskIdentifier,
          resolved_task_id: resolvedTaskId,
        },
      });
      continue;
    }

    if (action.action === 'post_message') {
      const resolution = await resolveSpaceTarget(orgId, {
        spaceId: action.params.space_id ?? action.params.resolved_space_id,
        spaceName: action.params.space_name,
      });

      if (resolution.status !== 'resolved') {
        warnings.push(resolution.message);
        continue;
      }

      const requestedName = typeof action.params.space_name === 'string'
        ? action.params.space_name.trim().replace(/^#/, '')
        : null;
      resolvedActions.push({
        ...action,
        params: {
          ...action.params,
          space_id: resolution.space.id,
          space_name: resolution.space.name,
          requested_space_name: requestedName && requestedName !== resolution.space.name
            ? requestedName
            : action.params.requested_space_name,
        },
      });
      continue;
    }

    if (action.action === 'wiki_write') {
      const params = action.params;
      const requestedSlug = typeof params.slug === 'string' ? params.slug.trim() : '';
      const requestedTitle = typeof params.title === 'string' ? params.title.trim() : '';
      const candidateSlug = requestedTitle
        ? requestedTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
        : '';
      const [existingPage] = requestedSlug || requestedTitle
        ? await db
          .select({
            id: wikiPages.id,
            slug: wikiPages.slug,
            title: wikiPages.title,
            content: wikiPages.content,
            type: wikiPages.type,
            scope: wikiPages.scope,
            space_id: wikiPages.space_id,
          })
          .from(wikiPages)
          .where(and(
            eq(wikiPages.org_id, orgId),
            eq(wikiPages.is_deleted, false),
            requestedSlug
              ? eq(wikiPages.slug, requestedSlug)
              : sql`(lower(${wikiPages.title}) = lower(${requestedTitle}) OR ${wikiPages.slug} = ${candidateSlug})`,
          ))
          .limit(1)
        : [];
      const requestedMode = params.requested_wiki_write_mode === 'create' || params.requested_wiki_write_mode === 'update'
        ? params.requested_wiki_write_mode
        : undefined;
      if (!existingPage && (requestedMode === 'update' || (requestedSlug && requestedMode !== 'create'))) {
        warnings.push(`I could not find wiki page "${requestedSlug}".`);
        continue;
      }
      if (existingPage?.scope === 'space' && existingPage.space_id) {
        const [membership] = await db.select({ user_id: spaceMembers.user_id }).from(spaceMembers).where(and(
          eq(spaceMembers.space_id, existingPage.space_id),
          eq(spaceMembers.user_id, userId),
        )).limit(1);
        if (!membership) {
          warnings.push(`You do not have access to update wiki page "${existingPage.title}".`);
          continue;
        }
      }
      const resolvedParams = existingPage
        ? {
          ...params,
          slug: existingPage.slug,
          title: existingPage.title,
          content: mergeWikiUpdateContent(
            existingPage.content,
            typeof params.content === 'string' ? params.content : '',
            params.requested_wiki_update_operation,
          ),
          type: params.requested_wiki_type_change === true ? params.type : existingPage.type,
          wiki_write_mode: 'update',
          resolved_wiki_page_id: existingPage.id,
        }
        : { ...params, slug: undefined, wiki_write_mode: 'create' };
      resolvedActions.push({
        ...action,
        params: resolvedParams,
      });
      continue;
    }

    if (action.action === 'create_note' && action.params.visibility === 'space') {
      const spaceId = typeof action.params.visibility_space_id === 'string' ? action.params.visibility_space_id : '';
      const [targetSpace] = spaceId ? await db.select({ id: spaces.id, name: spaces.name }).from(spaces).innerJoin(
        spaceMembers,
        and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, userId)),
      ).where(and(
        eq(spaces.id, spaceId),
        eq(spaces.org_id, orgId),
        eq(spaces.is_archived, false),
      )).limit(1) : [];
      if (!targetSpace) {
        warnings.push('I could not verify access to the target space for this note.');
        continue;
      }
      resolvedActions.push(action);
      continue;
    }

    if (action.action === 'note_to_wiki') {
      const noteId = typeof action.params.note_id === 'string' ? action.params.note_id : '';
      const [visibleNote] = noteId ? await db.select({ id: notes.id, title: notes.title }).from(notes).where(and(
        eq(notes.id, noteId),
        eq(notes.org_id, orgId),
        eq(notes.is_deleted, false),
        sql`(
          ${notes.user_id} = ${userId}
          OR ${notes.visibility} = 'org'
          OR (${notes.visibility} = 'space' AND EXISTS (
            SELECT 1 FROM space_members sm
            WHERE sm.space_id = ${notes.visibility_space_id} AND sm.user_id = ${userId}
          ))
        )`,
      )).limit(1) : [];
      if (!visibleNote) {
        warnings.push('I could not find that note or you do not have access to it.');
        continue;
      }
      resolvedActions.push({ ...action, params: { ...action.params, resolved_note_title: visibleNote.title } });
      continue;
    }

    if (action.action === 'link_decision_to_tasks' || action.action === 'mark_decision_implemented') {
      const decisionId = typeof action.params.decision_id === 'string' ? action.params.decision_id : '';
      const [decision] = decisionId ? await db.select({ id: wikiPages.id, title: wikiPages.title }).from(wikiPages).where(and(
        eq(wikiPages.id, decisionId),
        eq(wikiPages.org_id, orgId),
        eq(wikiPages.type, 'decision'),
        eq(wikiPages.is_deleted, false),
      )).limit(1) : [];
      if (!decision) {
        warnings.push('I could not find that active decision in this workspace.');
        continue;
      }
      if (action.action === 'link_decision_to_tasks') {
        const taskIds = Array.isArray(action.params.task_ids)
          ? action.params.task_ids.filter((id: unknown): id is string => typeof id === 'string')
          : [];
        const foundTasks = taskIds.length ? await db.select({ id: tasks.id }).from(tasks).where(and(
          eq(tasks.org_id, orgId),
          inArray(tasks.id, taskIds),
        )) : [];
        if (foundTasks.length !== taskIds.length) {
          warnings.push('One or more selected tasks no longer exist in this workspace.');
          continue;
        }
      }
      resolvedActions.push({ ...action, params: { ...action.params, resolved_decision_title: decision.title } });
      continue;
    }

    resolvedActions.push(action);
  }

  return { actions: resolvedActions, warnings };
}

function buildTargetClarificationMessage(warnings: string[]) {
  const uniqueWarnings = [...new Set(warnings)].filter(Boolean);
  if (uniqueWarnings.length === 0) return '';
  return [
    'I need one clarification before I can create the approval card.',
    ...uniqueWarnings.map((warning) => `- ${warning}`),
    'Reply with the missing detail or a narrower request and I will draft it again.',
  ].join('\n');
}

const MAX_INLINE_APPROVAL_ACTIONS = 3;
const INLINE_STATUS_UPDATE_APPROVAL_TIER = 'quick' as const;

function normalizePendingApprovalTier(action: any) {
  const approvalTier = action?.approval_tier ?? getApprovalTier(action?.action);
  return {
    ...action,
    approval_tier: approvalTier === 'auto' ? 'quick' : approvalTier,
  };
}

export function extractExplicitCreateTaskAction(
  content: string,
  sourceMessageId: string,
  options: { projectName?: string | null; now?: Date; callerName?: string | null } = {},
) {
  if (!hasExplicitCreateTaskIntent(content)) {
    return null;
  }

  const title = inferTaskTitle(content);
  if (!title) return null;

  const explicitProjectName = content.match(/\bproject\s+"([^"]+)"/i)?.[1]
    ?? content.match(/\bproject\s+'([^']+)'/i)?.[1]
    ?? content.match(/\bin\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 &+_-]{2,80})\s+project\b/i)?.[1];
  const projectName = explicitProjectName && /^[A-Z]/.test(explicitProjectName.trim())
    ? explicitProjectName.trim()
    : options.projectName ?? explicitProjectName?.trim() ?? undefined;
  if (!projectName) return null;

  const inferredAssigneeName = inferAssigneeName(content);
  const normalizedAssigneeToken = inferredAssigneeName?.replace(/[?!.,;:]+$/g, '').trim();
  const assigneeName = normalizedAssigneeToken && /^(?:me|myself)$/i.test(normalizedAssigneeToken)
    ? options.callerName ?? undefined
    : inferredAssigneeName;
  const dueDate = inferDueDate(content, options.now);
  const description = stripMentionSyntax(content);

  return {
    action: 'create_task',
    params: {
      title,
      project_name: projectName,
      ...(assigneeName ? { assignee_name: assigneeName } : {}),
      ...(dueDate ? { due_date: dueDate } : {}),
      description,
      source_message_id: sourceMessageId,
    },
    approval_tier: getApprovalTier('create_task'),
    tool_use_id: null,
    source: 'deterministic_create_task_fallback',
  };
}

function normalizeTaskStatusToken(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[_\s-]+/g, ' ').trim();
  if (/^(?:done|complete|completed|closed|finish|finished)$/.test(normalized)) return 'done';
  if (/^(?:todo|to do|open|reopened|reopen)$/.test(normalized)) return 'todo';
  if (/^(?:in progress|doing|started)$/.test(normalized)) return 'in_progress';
  if (/^(?:in review|review|reviewing|ready for review)$/.test(normalized)) return 'in_review';
  if (/^(?:backlog|later)$/.test(normalized)) return 'backlog';
  if (/^(?:cancelled|canceled|cancel)$/.test(normalized)) return 'cancelled';
  return null;
}

function inferStatusUpdateTargetStatus(content: string): string | null {
  const plain = stripMentionSyntax(content);
  const statusPhrase =
    plain.match(/\b(?:to|as|status\s+to)\s+(done|complete|completed|in progress|in review|todo|to do|backlog|cancelled|canceled)\b/i)?.[1] ??
    plain.match(/\b(done|complete|completed|in progress|in review|todo|to do|backlog|cancelled|canceled)\b/i)?.[1];
  const explicitStatus = normalizeTaskStatusToken(statusPhrase);
  if (explicitStatus) return explicitStatus;
  if (/\b(?:close|closed)\b/i.test(plain)) return 'done';
  if (/\b(?:reopen|reopened)\b/i.test(plain)) return 'todo';
  return null;
}

function hasExplicitStatusUpdateIntent(content: string): boolean {
  const plain = stripMentionSyntax(content);
  const positive =
    /\b(?:mark|move|set|change|update|transition|close|reopen)\b.{0,80}\b(?:[A-Z]{2,12}-\d+|[0-9a-f]{8}-[0-9a-f-]{27})\b/i.test(plain) ||
    /\b(?:[A-Z]{2,12}-\d+|[0-9a-f]{8}-[0-9a-f-]{27})\b.{0,80}\b(?:done|complete|completed|in progress|in review|todo|to do|backlog|cancelled|canceled)\b/i.test(plain);
  if (!positive) return false;

  return !/\b(?:do\s+not|don't|dont|never|without|avoid|no\s+need\s+to)\s+(?:\S+\s+){0,6}?(?:mark|move|set|change|update|transition|close|reopen)\b/i.test(plain);
}

export function extractStatusUpdateAction(content: string, sourceMessageId: string) {
  if (!hasExplicitStatusUpdateIntent(content)) return null;
  const plain = stripMentionSyntax(content);
  const taskIdentifier = plain.match(/\b([A-Z]{2,12}-\d+|[0-9a-f]{8}-[0-9a-f-]{27})\b/i)?.[1];
  if (!taskIdentifier) return null;

  const newStatus = inferStatusUpdateTargetStatus(plain);
  if (!newStatus) return null;

  return {
    action: 'update_task_status',
    params: {
      task_identifier: taskIdentifier.toUpperCase(),
      new_status: newStatus,
      source_message_id: sourceMessageId,
    },
    approval_tier: INLINE_STATUS_UPDATE_APPROVAL_TIER,
    tool_use_id: null,
    source: 'deterministic_status_update_fallback',
  };
}

type ReferentialStatusSelector = {
  mode: 'all' | 'first' | 'last';
  count?: number;
};

const SMALL_COUNTS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

function parseSmallCount(value: string | undefined | null): number | undefined {
  const token = value?.trim().toLowerCase();
  if (!token) return undefined;
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
  return SMALL_COUNTS[token];
}

function hasNegatedStatusUpdateIntent(content: string): boolean {
  const plain = stripMentionSyntax(content);
  return /\b(?:do\s+not|don't|dont|never|without|avoid|no\s+need\s+to)\s+(?:\S+\s+){0,6}?(?:mark|move|set|change|update|transition|close|reopen)\b/i.test(plain);
}

export function extractReferentialStatusUpdateRequest(content: string): {
  new_status: string;
  selector: ReferentialStatusSelector;
} | null {
  if (hasNegatedStatusUpdateIntent(content)) return null;
  const plain = stripMentionSyntax(content);
  if (!/\b(?:mark|move|set|change|update|transition|close|reopen)\b/i.test(plain)) return null;

  const newStatus = inferStatusUpdateTargetStatus(plain);
  if (!newStatus) return null;

  const firstLastMatch = plain.match(/\b(?:the\s+)?(first|last)\s+(one|two|three|four|five|\d+)\b/i);
  if (firstLastMatch) {
    const count = parseSmallCount(firstLastMatch[2]);
    if (!count) return null;
    return {
      new_status: newStatus,
      selector: {
        mode: firstLastMatch[1]!.toLowerCase() === 'last' ? 'last' : 'first',
        count,
      },
    };
  }

  const allCountMatch = plain.match(/\ball\s+(one|two|three|four|five|\d+)\b/i);
  if (allCountMatch) {
    const count = parseSmallCount(allCountMatch[1]);
    if (!count) return null;
    return { new_status: newStatus, selector: { mode: 'all', count } };
  }

  if (/\bboth\b/i.test(plain)) {
    return { new_status: newStatus, selector: { mode: 'all', count: 2 } };
  }

  if (/\b(?:all\s+of\s+)?(?:these|those|them|the above|the listed tasks|the tasks)\b/i.test(plain)) {
    return { new_status: newStatus, selector: { mode: 'all' } };
  }

  return null;
}

function normalizeTaskReference(value: string): string {
  const trimmed = value.trim();
  return /^[A-Z]{2,12}-\d+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

function uniqueTaskReferences(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = normalizeTaskReference(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function extractTaskReferencesFromText(text: string): string[] {
  return uniqueTaskReferences(
    [...toPlainText(text).matchAll(/\b([A-Z]{2,12}-\d+)\b/g)].map((match) => match[1]!),
  );
}

export function extractTaskReferencesFromAgentReply(content: string, metadata: unknown): string[] {
  const primaryReplyText = toPlainText(content).split(/\bSources?:/i)[0] ?? content;
  const textReferences = extractTaskReferencesFromText(primaryReplyText);
  if (textReferences.length > 0) return textReferences;

  const citations = isRecord(metadata) && Array.isArray(metadata.citations)
    ? metadata.citations
    : [];
  const citationReferences: string[] = [];
  for (const citation of citations) {
    if (!isRecord(citation) || citation.type !== 'task') continue;
    const title = typeof citation.title === 'string' ? citation.title : '';
    const code = title.match(/\b([A-Z]{2,12}-\d+)\b/)?.[1];
    if (code) {
      citationReferences.push(code);
      continue;
    }
    if (typeof citation.id === 'string' && citation.id.trim()) {
      citationReferences.push(citation.id.trim());
    }
  }
  return uniqueTaskReferences(citationReferences);
}

function selectReferencedTasks(
  references: string[],
  selector: ReferentialStatusSelector,
): string[] {
  const unique = uniqueTaskReferences(references);
  const count = selector.count ?? unique.length;
  if (count <= 0) return [];
  if (selector.count && unique.length < selector.count) return [];
  if (!selector.count && count > MAX_INLINE_APPROVAL_ACTIONS) return [];
  if (count > MAX_INLINE_APPROVAL_ACTIONS) return [];
  if (selector.mode === 'first') return unique.slice(0, count);
  if (selector.mode === 'last') return unique.slice(-count);
  return unique.slice(0, count);
}

export function buildReferentialStatusUpdateActions(
  content: string,
  sourceMessageId: string,
  references: string[],
) {
  const request = extractReferentialStatusUpdateRequest(content);
  if (!request) return null;
  const selectedReferences = selectReferencedTasks(references, request.selector);
  if (selectedReferences.length === 0) return null;

  return selectedReferences.map((taskIdentifier) => ({
    action: 'update_task_status',
    params: {
      task_identifier: taskIdentifier,
      new_status: request.new_status,
      source_message_id: sourceMessageId,
    },
    approval_tier: INLINE_STATUS_UPDATE_APPROVAL_TIER,
    tool_use_id: null,
    source: 'deterministic_referential_status_update_fallback',
  }));
}

async function buildReferentialStatusUpdateFallback(options: {
  orgId: string;
  spaceId: string;
  agentUserId: string;
  messageId: string;
  parentId?: string | null;
  content: string;
}) {
  if (!extractReferentialStatusUpdateRequest(options.content)) return null;

  const [trigger] = await db
    .select({ created_at: messages.created_at })
    .from(messages)
    .where(and(
      eq(messages.id, options.messageId),
      eq(messages.org_id, options.orgId),
    ))
    .limit(1);
  if (!trigger) return null;

  const parentScope = options.parentId
    ? eq(messages.parent_id, options.parentId)
    : sql`${messages.parent_id} IS NULL`;

  const priorAgentReplies = await db
    .select({
      content: messages.content,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(and(
      eq(messages.org_id, options.orgId),
      eq(messages.space_id, options.spaceId),
      eq(messages.user_id, options.agentUserId),
      eq(messages.is_deleted, false),
      parentScope,
      lt(messages.created_at, trigger.created_at),
    ))
    .orderBy(desc(messages.created_at))
    .limit(5);

  for (const reply of priorAgentReplies) {
    const references = extractTaskReferencesFromAgentReply(reply.content, reply.metadata);
    const actions = buildReferentialStatusUpdateActions(options.content, options.messageId, references);
    if (actions && actions.length > 0) return actions;
  }

  return null;
}

async function collectRecentAgentTaskReferences(options: {
  orgId: string;
  spaceId: string;
  agentUserId: string;
  messageId: string;
  parentId?: string | null;
  promptContent: string;
}) {
  const [trigger] = await db
    .select({ created_at: messages.created_at })
    .from(messages)
    .where(and(
      eq(messages.id, options.messageId),
      eq(messages.org_id, options.orgId),
    ))
    .limit(1);
  if (!trigger) return [];

  const parentScope = options.parentId
    ? eq(messages.parent_id, options.parentId)
    : sql`${messages.parent_id} IS NULL`;

  const priorAgentReplies = await db
    .select({
      content: messages.content,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(and(
      eq(messages.org_id, options.orgId),
      eq(messages.space_id, options.spaceId),
      eq(messages.user_id, options.agentUserId),
      eq(messages.is_deleted, false),
      parentScope,
      lt(messages.created_at, trigger.created_at),
    ))
    .orderBy(desc(messages.created_at))
    .limit(5);

  const references = uniqueTaskReferences(
    priorAgentReplies.flatMap((reply) => extractTaskReferencesFromAgentReply(reply.content, reply.metadata)),
  );
  if (!/\bsubtasks?\b/i.test(stripMentionSyntax(options.promptContent)) || references.length === 0) {
    return references.slice(0, MAX_INLINE_APPROVAL_ACTIONS);
  }

  const referencedTasks = await db
    .select({
      id: tasks.id,
      parent_task_id: tasks.parent_task_id,
      identifier: sql<string>`${projects.prefix} || '-' || ${tasks.number}`,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .where(and(
      eq(tasks.org_id, options.orgId),
      eq(tasks.is_deleted, false),
      inArray(sql<string>`${projects.prefix} || '-' || ${tasks.number}`, references),
    ));
  const parentIds = referencedTasks.filter((task) => !task.parent_task_id).map((task) => task.id);
  if (parentIds.length === 0) return references.slice(0, MAX_INLINE_APPROVAL_ACTIONS);

  const childTasks = await db
    .select({
      identifier: sql<string>`${projects.prefix} || '-' || ${tasks.number}`,
      number: tasks.number,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .where(and(
      eq(tasks.org_id, options.orgId),
      eq(tasks.is_deleted, false),
      inArray(tasks.parent_task_id, parentIds),
    ))
    .orderBy(tasks.number);
  if (childTasks.length === 0) return references.slice(0, MAX_INLINE_APPROVAL_ACTIONS);

  return preferSubtaskReferences(references, referencedTasks, childTasks);
}

export function preferSubtaskReferences(
  references: string[],
  referencedTasks: Array<{ identifier: string; parent_task_id: string | null }>,
  childTasks: Array<{ identifier: string; number: number }>,
) {
  const parentReferences = new Set(
    referencedTasks.filter((task) => !task.parent_task_id).map((task) => task.identifier.toUpperCase()),
  );
  return uniqueTaskReferences([
    ...references.filter((reference) => !parentReferences.has(reference.toUpperCase())),
    ...childTasks.sort((left, right) => left.number - right.number).map((task) => task.identifier),
  ]).slice(0, MAX_INLINE_APPROVAL_ACTIONS);
}

function hasExplicitPostMessageIntent(content: string): boolean {
  const plain = stripMentionSyntax(content);
  const positive =
    /\b(?:post|send|put|share)\b.{0,50}\b(?:message|update|note|announcement)\b/i.test(plain) ||
    /\b(?:post|send|put|share)\b.{0,50}\b(?:in|to)\s+#?[A-Za-z0-9][A-Za-z0-9 &+_-]{1,80}\b/i.test(plain);
  if (!positive) return false;
  return !/\b(?:do\s+not|don't|dont|never|without|avoid|no\s+need\s+to)\s+(?:\S+\s+){0,6}?(?:post|send|put|share)\b/i.test(plain);
}

function hasLiteralPostMessagePayload(content: string): boolean {
  const plain = stripMentionSyntax(content);
  return /["'][\s\S]{8,}["']/.test(plain) || /\b(?:in|to)\s+#?[A-Za-z0-9][A-Za-z0-9 &+_-]{1,80}?(?:\s+(?:channel|space))?[.:;]\s+\S+/i.test(plain);
}

export function extractPostMessageAction(content: string, sourceMessageId: string) {
  if (!hasExplicitPostMessageIntent(content)) return null;
  const plain = stripMentionSyntax(content);
  if (/\b(?:dm|direct message|private message)\b/i.test(plain)) return null;

  const quotedContent =
    plain.match(/\b(?:saying|that says|with text)\s+"([^"]+)"/i)?.[1] ??
    plain.match(/\b(?:saying|that says|with text)\s+'([^']+)'/i)?.[1];
  const channelMatch =
    plain.match(/\b(?:in|to)\s+#([A-Za-z0-9][A-Za-z0-9_-]{1,80})\b/i)?.[1] ??
    plain.match(/\b(?:in|to)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 &+_-]{1,80}?)(?:\s+(?:channel|space)\b|[.:;]\s+|\s+saying\b|\s+that\b)/i)?.[1];

  let messageContent = quotedContent?.trim();
  if (!messageContent) {
    messageContent =
      plain.match(/\b(?:in|to)\s+#?[A-Za-z0-9][A-Za-z0-9 &+_-]{1,80}?(?:\s+(?:channel|space))?[.:;]\s+(.+)$/i)?.[1]?.trim() ??
      plain.match(/\b(?:in|to)\s+#?[A-Za-z0-9][A-Za-z0-9 &+_-]{1,80}?\s+(?:saying|that)\s+(.+)$/i)?.[1]?.trim();
  }

  messageContent = messageContent?.replace(/^["']|["']$/g, '').trim();

  if (!channelMatch?.trim() || !messageContent) return null;

  return {
    action: 'post_message',
    params: {
      space_name: channelMatch.trim().replace(/^#/, ''),
      content: truncatePlainText(messageContent, 4000),
      source_message_id: sourceMessageId,
    },
    approval_tier: getApprovalTier('post_message'),
    tool_use_id: null,
    source: 'deterministic_post_message_fallback',
  };
}

function hasApprovalQueuedClaim(text: string): boolean {
  return /\b(?:queued|ready|prepared|drafted|set up).{0,80}\b(?:approval|approve|card)\b/i.test(toPlainText(text));
}

function buildWriteIntentClarification(content: string, replyText: string): string {
  const claimedQueued = hasApprovalQueuedClaim(replyText);
  if (hasExplicitStatusUpdateIntent(content)) {
    return [
      'I need one detail before I can create the approval card.',
      'Please include the exact task id and target status, for example: "mark MKT-18 done."',
    ].join('\n');
  }
  if (hasExplicitPostMessageIntent(content)) {
    if (/\b(?:dm|direct message|private message)\b/i.test(stripMentionSyntax(content))) {
      return [
        'I need one clarification before I can draft that message.',
        'This approval flow can safely post to a named channel right now. Tell me the exact channel, or use MCP send_message for direct DMs.',
      ].join('\n');
    }
    return [
      'I need one detail before I can create the approval card.',
      'Please include the exact destination channel and the full message text.',
    ].join('\n');
  }
  if (hasExplicitCreateTaskIntent(content)) {
    return [
      'I need one detail before I can create the approval card.',
      'Please include the target project and a clear task title or outcome.',
    ].join('\n');
  }
  if (claimedQueued) {
    return 'I could not create a valid approval card for that draft. Please restate the action with the exact target and I will try again.';
  }
  return '';
}

export function normalizeApprovalSurfaceCopy(text: string): string {
  const inlineApprovalCopy =
    'Use the approval card below this message to approve or dismiss it. It is also mirrored in Inbox under Needs you.';
  let normalized = text
    .replace(
      /(?:Please\s+)?(?:check|open|go to)\s+(?:your\s+)?Inbox\s+(?:under|in)\s+the\s+["']?Approvals["']?\s+tab\s+to\s+approve\s+or\s+reject[^.\n]*(?:\.|$)/gi,
      inlineApprovalCopy,
    )
    .replace(
      /You can also manage this in your Inbox under the Approvals tab\.?/gi,
      'It is also mirrored in Inbox under Needs you.',
    );

  const mentionsInlineCard = /\b(?:approval card|approve\/reject button|approve or dismiss|below this message|here to finalize)\b/i.test(normalized);
  if (!mentionsInlineCard) {
    normalized = `${normalized.trim()}\n\n${inlineApprovalCopy}`;
  }
  return normalized;
}

async function resolveProjectNameForMentionFallback(
  orgId: string,
  spaceId: string,
  content: string,
): Promise<string | null> {
  const explicitProjectName = extractExplicitProjectName(content);
  const resolution = await resolveProjectTarget(orgId, {
    projectName: explicitProjectName,
    sourceSpaceId: spaceId,
  });
  return resolution.status === 'resolved' ? resolution.project.name : null;
}

function extractExplicitProjectName(content: string): string | null {
  return content.match(/\bproject\s+"([^"]+)"/i)?.[1]?.trim()
    ?? content.match(/\bproject\s+'([^']+)'/i)?.[1]?.trim()
    ?? content.match(/\bin\s+(?:the\s+)?([A-Z][A-Za-z0-9 &+_-]{2,80})\s+project\b/i)?.[1]?.trim()
    ?? null;
}

function extractDiscussionTaskActionFromReply(replyText: string, sourceMessageId: string) {
  const plain = toPlainText(replyText);
  const normalized = plain.replace(/\*\*/g, '').replace(/^\s*[-*]\s*/gm, '');
  if (!/\b(?:task proposal|proposed task creation|title\s*:|i will create a detailed task|approve this task creation|queued for your approval)\b/i.test(normalized)) {
    return null;
  }
  if (/\b(?:clarify|clarification|need more information|not enough context)\b/i.test(normalized) && !/\btitle\s*:/i.test(normalized)) {
    return null;
  }

  const labelField = (label: string) => {
    const labels = 'title|project|description|assignee|priority|due date|source|owners|additional notes';
    const match = normalized.match(new RegExp(`\\b${label}\\s*:\\s*(.+?)(?=\\s+(?:${labels})\\s*:|$)`, 'i'));
    return match?.[1]?.replace(/^[#:\s-]+/, '').trim();
  };

  const title = labelField('title');
  if (!title) return null;

  const projectName = labelField('project');
  const assigneeName = labelField('assignee');
  const priorityMatch = normalized.match(/\bpriority\s*:\s*(p[0-3])\b/i)?.[1]?.toLowerCase();
  const dueDate = normalized.match(/\bdue date\s*:\s*(\d{4}-\d{2}-\d{2})\b/i)?.[1];

  return {
    action: 'create_task',
    params: {
      title: truncatePlainText(title, 80),
      ...(projectName ? { project_name: truncatePlainText(projectName, 120) } : {}),
      ...(assigneeName ? { assignee_name: truncatePlainText(assigneeName, 120) } : {}),
      ...(priorityMatch ? { priority: priorityMatch } : {}),
      ...(dueDate ? { due_date: dueDate } : {}),
      description: plain,
      source_message_id: sourceMessageId,
    },
    approval_tier: getApprovalTier('create_task'),
    tool_use_id: null,
    source: 'mention',
  };
}

function fallbackDiscussionTaskTitle(content: string): string {
  const plain = toPlainText(content);
  const match = plain.match(/\bfor\s+(?:the\s+)?(.+?)(?:\.|,|;|$)/i);
  return truncatePlainText(match?.[1]?.trim() || 'Follow up from discussion', 80) || 'Follow up from discussion';
}

function buildDiscussionTaskFallbackAction(params: {
  command: string;
  sourceMessageId: string;
  sourceMessages: DiscussionSourceMessage[];
}) {
  const highlights = params.sourceMessages
    .slice(-12)
    .map(formatDiscussionHighlight)
    .filter((line) => line.trim().length > 3);
  const description = [
    'Review-only task proposal created from a Defty discussion command.',
    '',
    'The model did not return a usable tool call, so Defty preserved the recent source discussion for human review instead of taking silent action.',
    '',
    '**Source discussion highlights:**',
    ...highlights,
  ].join('\n');

  return {
    action: 'create_task',
    params: {
      title: fallbackDiscussionTaskTitle(params.command),
      description,
      source_message_id: params.sourceMessageId,
      metadata: {
        command_message_id: params.sourceMessageId,
        context_mode: 'discussion',
        discussion_source_message_ids: params.sourceMessages.map((message) => message.id),
      },
    },
    approval_tier: getApprovalTier('create_task'),
    tool_use_id: null,
    source: 'mention',
  };
}

export function isDiscussionTaskCommand(content: string): boolean {
  const plain = toPlainText(content);
  const positiveMatch =
    /\b(?:create|make|draft|turn|convert)\b.{0,80}\b(?:tasks?|todos?|tickets?)\b/i.exec(plain) ??
    /\bsummari[sz]e\b.{0,80}\b(?:into|as)\b.{0,30}\b(?:tasks?|todos?|tickets?)\b/i.exec(plain);
  if (!positiveMatch) return false;

  // A lot of real user prompts ask Defty to summarize a discussion while
  // explicitly saying "do not create tasks yet". The old detector saw the
  // words "create tasks" and queued a fallback action anyway. Only suppress
  // the command when the negation owns the first task-creation phrase; still
  // allow prompts like "create one task, but don't create duplicates".
  const negatedCreationMatch = /\b(?:do\s+not|don't|dont|never|without|avoid|no\s+need\s+to)\s+(?:\S+\s+){0,6}?(?:create|creating|make|making|add|adding|open|opening|turn|turning|convert|converting|draft|drafting)\s+(?:\S+\s+){0,6}?(?:tasks?|todos?|tickets?)\b/i.exec(plain);
  if (negatedCreationMatch && negatedCreationMatch.index <= positiveMatch.index) return false;

  return /\b(?:discussion|thread|chat|conversation|above|this)\b/i.test(plain);
}

export function isThreadTaskContinuationCommand(
  content: string,
  sourceMessages: DiscussionSourceMessage[],
): boolean {
  if (sourceMessages.length === 0) return false;
  const plain = stripMentionSyntax(content).toLowerCase();
  const isContinuation =
    /^(?:do\s+(?:it|that|the\s+above)|go\s+ahead|yes|yep|yeah|please\s+do|make\s+it\s+happen|proceed)(?:[.!?\s]|$)/i.test(plain) ||
    /\b(?:do\s+(?:it|that|the\s+above)|go\s+ahead|please\s+do|make\s+it\s+happen|proceed)\b/i.test(plain);
  if (!isContinuation) return false;

  return sourceMessages.some((message) => {
    const messageText = toPlainText(message.content);
    return hasExplicitCreateTaskIntent(messageText) ||
      /\b(?:task creation request|proposed task creation|create the task|queued for your approval|approve this task creation)\b/i.test(messageText);
  });
}

function isDiscussionBoundaryMessage(content: string): boolean {
  const plain = toPlainText(content);
  return /(?:^|\s)@(agent|defty|deft)\b/i.test(plain) || isDiscussionTaskCommand(plain);
}

function isSocialOnlyDiscussionMessage(content: string): boolean {
  const plain = toPlainText(content)
    .toLowerCase()
    .replace(/\b(?:human|chat|dense|edge)[a-z0-9_-]*-[a-z0-9_-]{6,}\b/g, '');
  const hasSocialTopic = /\b(?:pizza|deep dish|thin crust|pineapple|jalapeno|mushroom|cheese|lunch|breakfast|dinner|snack|coffee|tea|cake|eat|eating|birthday|party|weekend|movie|music|sports)\b/i.test(plain);
  if (!hasSocialTopic) return false;

  const hasWorkSignal = /\b(?:task|todo|ticket|project|launch|buyer|route|truck|capacity|crate|harvest|handoff|sheet|qc|sampling|sample|label|pack|packing|cold|greenhouse|irrigation|pest|blocked|blocker|stuck|dependency|deadline|due|owner|owns|assign|confirm|update|status|decision|agreed|resolution|ship|delivery|market)\b/i.test(plain);
  return !hasWorkSignal;
}

function discussionTaskPrompt(content: string): string {
  return `${content}

This is an explicit Defty command to synthesize the surrounding discussion into work.
Use the recent discussion context already provided in the conversation history.
If the discussion clearly converged on work, queue a small number of precise create_task proposals.
Prefer one well-scoped task unless the user explicitly asked for multiple tasks.
Preserve material disagreement details, source documents/sheets mentioned, owner commitments, timing, and the final resolution.
The task description should make clear what each named person said or owns when that matters to execution.
Include the source message id automatically supplied by the system.
Do not create knowledge/wiki entries from this command; task proposals only.
If owner, project, or scope is genuinely ambiguous, ask a short clarification instead of guessing.`;
}

type DiscussionSourceMessage = {
  id: string;
  userName: string;
  content: string;
};

function formatDiscussionHighlight(message: DiscussionSourceMessage): string {
  const content = truncatePlainText(
    toPlainText(message.content)
      .replace(/^[A-Z0-9][A-Z0-9_-]{2,80}:\s*/, '')
      .replace(/\s+/g, ' ')
      .trim(),
    260,
  );
  return `- ${message.userName}: ${content}`;
}

function enrichDiscussionTaskActions(
  actions: any[],
  sourceMessages: DiscussionSourceMessage[],
): any[] {
  if (sourceMessages.length === 0) return actions;
  const highlights = sourceMessages
    .slice(-12)
    .map(formatDiscussionHighlight)
    .filter((line) => line.trim().length > 3);
  if (highlights.length === 0) return actions;

  const appendix = `\n\n**Source discussion highlights:**\n${highlights.join('\n')}`;
  return actions.map((action) => {
    if (action?.action !== 'create_task' && action?.action !== 'task_create') return action;
    const params = action.params ?? {};
    const description = String(params.description ?? '').trim();
    const metadata = {
      ...(params.metadata ?? {}),
      discussion_source_message_ids: sourceMessages.map((message) => message.id),
      context_mode: 'discussion',
    };
    if (description.includes('Source discussion highlights')) {
      return {
        ...action,
        params: {
          ...params,
          metadata,
        },
      };
    }
    return {
      ...action,
      params: {
        ...params,
        description: `${description || 'Task created from discussion.'}${appendix}`,
        metadata,
      },
    };
  });
}

function withMentionProvenance(params: {
  action: any;
  commandMessageId: string;
  spaceId: string;
  discussionSourceMessages: DiscussionSourceMessage[];
}) {
  const { action, commandMessageId, spaceId, discussionSourceMessages } = params;
  if (!action || typeof action !== 'object') return action;
  const actionParams = action.params && typeof action.params === 'object' ? action.params : {};
  const isWriteAction = [
    'create_task',
    'task_create',
    'update_task_status',
    'task_update',
    'update_task',
    'task_transition',
    'comment_on_task',
    'post_message',
  ].includes(String(action.action ?? ''));
  if (!isWriteAction) return action;

  const sourceIds = discussionSourceMessages.map((message) => message.id);
  return {
    ...action,
    params: {
      ...actionParams,
      source_message_id: commandMessageId,
      source_space_id: spaceId,
      origin_message_id: commandMessageId,
      origin_space_id: spaceId,
      metadata: {
        ...(actionParams.metadata ?? {}),
        command_message_id: commandMessageId,
        context_mode: sourceIds.length > 0 ? 'discussion' : 'message',
        ...(sourceIds.length > 0 ? { discussion_source_message_ids: sourceIds } : {}),
      },
    },
  };
}

export async function handleAgentReply(job: JobData): Promise<void> {
  const {
    orgId,
    spaceId,
    messageId,
    parentId,
    userId,
    orgName,
    content,
  } = job.data as {
    orgId: string;
    spaceId: string;
    messageId: string;
    parentId?: string;
    userId: string;
    orgName: string;
    content: string;
  };

  console.log(`[agent-reply] Processing agent reply for message ${messageId} in space ${spaceId}`);

  try {
    // Load space context — type drives both threading behavior and the
    // system-prompt hint so the agent adapts tone (DM vs channel).
    const [space] = await db
      .select({ type: spaces.type, name: spaces.name })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1);

    const isDmLike = space?.type === 'dm' || space?.type === 'group_dm' || space?.type === 'agent_conversation';

    // Threading rule:
    // - In channels: thread off the triggering message (or its parent thread root)
    //   so the channel isn't cluttered.
    // - In DMs: reply flat (no parent_id) UNLESS the user explicitly threaded —
    //   DMs read like a normal conversation, not a tree of threads.
    const threadParentId = isDmLike ? (parentId ?? null) : (parentId || messageId);
    // The thread we load history from — for DMs without explicit threading,
    // we still want recent flat history; agent-runner gets it via conversationHistory.
    const historyParentId = parentId || messageId;

    // Load conversation history.
    // - DM (no explicit thread): last 10 top-level messages in the space.
    // - Channel or explicit thread: last 10 messages in the thread + the
    //   thread root for context.
    const agentUserId = await ensureDeftyMembership(orgId);
    const [callerUser] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const conversationHistory: { role: string; content: string }[] = [];
    const threadContextMessages: DiscussionSourceMessage[] = [];

    if (isDmLike && !parentId) {
      const recent = await db.select({
        id: messages.id,
        content: messages.content,
        user_id: messages.user_id,
        user_name: users.name,
      })
        .from(messages)
        .innerJoin(users, eq(messages.user_id, users.id))
        .where(and(
          eq(messages.space_id, spaceId),
          eq(messages.org_id, orgId),
          eq(messages.is_deleted, false),
          sql`${messages.parent_id} IS NULL`,
          ne(messages.id, messageId),
        ))
        .orderBy(desc(messages.created_at))
        .limit(10);
      for (const msg of recent.reverse()) {
        conversationHistory.push({
          role: msg.user_id === agentUserId ? 'assistant' : 'user',
          content: msg.user_id === agentUserId ? msg.content : `[${msg.user_name}]: ${msg.content}`,
        });
      }
    } else {
      const threadMessages = await db.select({
        id: messages.id,
        content: messages.content,
        user_id: messages.user_id,
        user_name: users.name,
      })
        .from(messages)
        .innerJoin(users, eq(messages.user_id, users.id))
        .where(and(
          eq(messages.parent_id, historyParentId),
          eq(messages.org_id, orgId),
          eq(messages.is_deleted, false),
        ))
        .orderBy(desc(messages.created_at))
        .limit(10);

      const [parentMsg] = await db.select({
        id: messages.id,
        content: messages.content,
        user_id: messages.user_id,
        user_name: users.name,
      })
        .from(messages)
        .innerJoin(users, eq(messages.user_id, users.id))
        .where(eq(messages.id, historyParentId))
        .limit(1);

      if (parentMsg && parentMsg.id !== messageId) {
        threadContextMessages.push({
          id: parentMsg.id,
          userName: parentMsg.user_name,
          content: parentMsg.content,
        });
        conversationHistory.push({
          role: parentMsg.user_id === agentUserId ? 'assistant' : 'user',
          content: parentMsg.user_id === agentUserId ? parentMsg.content : `[${parentMsg.user_name}]: ${parentMsg.content}`,
        });
      }

      for (const msg of [...threadMessages].reverse()) {
        if (msg.id === messageId) continue;
        threadContextMessages.push({
          id: msg.id,
          userName: msg.user_name,
          content: msg.content,
        });
        conversationHistory.push({
          role: msg.user_id === agentUserId ? 'assistant' : 'user',
          content: msg.user_id === agentUserId ? msg.content : `[${msg.user_name}]: ${msg.content}`,
        });
      }
    }

    // Resolve the other DM member's name (if any) for the system prompt hint.
    let otherMemberName: string | undefined;
    if (isDmLike) {
      const [other] = await db.select({ name: users.name })
        .from(spaceMembers)
        .innerJoin(users, eq(users.id, spaceMembers.user_id))
        .where(and(
          eq(spaceMembers.space_id, spaceId),
          ne(spaceMembers.user_id, agentUserId),
        ))
        .limit(1);
      otherMemberName = other?.name;
    }

    // Strip the @agent/@deft mention from the content for a cleaner prompt
    const cleanContent = content.replace(/<@[^|]*\|Defty?>/gi, '').replace(/@(agent|defty|deft)\b/gi, '').trim();
    const wantsDiscussionTask = isDiscussionTaskCommand(cleanContent) ||
      Boolean(parentId && isThreadTaskContinuationCommand(cleanContent, threadContextMessages));
    const discussionSourceMessages: DiscussionSourceMessage[] = [];
    if (wantsDiscussionTask && parentId && threadContextMessages.length > 0) {
      discussionSourceMessages.push(
        ...threadContextMessages.filter((message) => !isSocialOnlyDiscussionMessage(message.content)),
      );
    }

    if (wantsDiscussionTask && !isDmLike && !parentId) {
      const [trigger] = await db
        .select({ created_at: messages.created_at })
        .from(messages)
        .where(and(
          eq(messages.id, messageId),
          eq(messages.org_id, orgId),
        ))
        .limit(1);

      if (trigger) {
        const recentChannelMessages = await db.select({
          id: messages.id,
          content: messages.content,
          user_id: messages.user_id,
          user_name: users.name,
        })
          .from(messages)
          .innerJoin(users, eq(messages.user_id, users.id))
          .where(and(
            eq(messages.space_id, spaceId),
            eq(messages.org_id, orgId),
            eq(messages.is_deleted, false),
            sql`${messages.parent_id} IS NULL`,
            lt(messages.created_at, trigger.created_at),
            ne(messages.user_id, agentUserId),
          ))
          .orderBy(desc(messages.created_at))
          .limit(80);

        const orderedRecentMessages = recentChannelMessages.reverse();
        let previousBoundaryIndex = -1;
        for (let index = orderedRecentMessages.length - 1; index >= 0; index -= 1) {
          if (isDiscussionBoundaryMessage(orderedRecentMessages[index]!.content)) {
            previousBoundaryIndex = index;
            break;
          }
        }
        const scopedRecentMessages = previousBoundaryIndex >= 0
          ? orderedRecentMessages.slice(previousBoundaryIndex + 1).slice(-40)
          : orderedRecentMessages.slice(-40);
        const workScopedRecentMessages = scopedRecentMessages.filter((msg) =>
          !isSocialOnlyDiscussionMessage(msg.content),
        );

        if (workScopedRecentMessages.length > 0) {
          conversationHistory.push({
            role: 'user',
            content: '[Recent channel discussion before this Defty request]',
          });
          for (const msg of workScopedRecentMessages) {
            discussionSourceMessages.push({
              id: msg.id,
              userName: msg.user_name,
              content: msg.content,
            });
            conversationHistory.push({
              role: 'user',
              content: `[${msg.user_name}]: ${msg.content}`,
            });
          }
        }
      }
    }

    const promptContent = wantsDiscussionTask
      ? discussionTaskPrompt(cleanContent || 'Create tasks from this discussion.')
      : cleanContent || 'Hey, what can you help me with?';
    const hasWriteIntent = !wantsDiscussionTask && hasExplicitRegisteredWriteIntent(promptContent);

    // Explicit writes go through the typed action compiler first. The general
    // reasoning loop remains the fallback for reads, discussion synthesis, and
    // requests the compiler cannot safely resolve. This avoids paying for two
    // independent reasoning passes for a straightforward governed write.
    let fallbackProjectName: string | null = null;
    let compiledActionDraft: Awaited<ReturnType<typeof compileDeftyActionDraft>> | null = null;
    if (hasWriteIntent) {
      try {
        fallbackProjectName = await resolveProjectNameForMentionFallback(orgId, spaceId, promptContent);
        const priorTaskReferences = await collectRecentAgentTaskReferences({
          orgId,
          spaceId,
          agentUserId,
          messageId,
          parentId: threadParentId,
          promptContent,
        });
        compiledActionDraft = await compileDeftyActionDraft({
          orgId,
          promptContent,
          sourceMessageId: messageId,
          projectNameHint: fallbackProjectName,
          priorTaskReferences,
          spaceName: space?.name ?? null,
          callerName: callerUser?.name ?? null,
        });
      } catch (err) {
        console.warn('[agent-reply] Fast action compiler failed; using the general reasoning path', {
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Call the agent reasoning engine with a 60s hard timeout so a stuck
    // MCP tool / Anthropic call can never wedge the worker.
    const AGENT_TIMEOUT_MS = 60_000;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), AGENT_TIMEOUT_MS);
    let result: Awaited<ReturnType<typeof runAgentQuery>>;
    try {
      if (compiledActionDraft && (compiledActionDraft.actions.length > 0 || compiledActionDraft.clarification)) {
        result = {
          text: compiledActionDraft.summary
            ?? compiledActionDraft.clarification
            ?? 'I drafted the requested update for review.',
          pendingActions: [],
          executedActions: [],
          assistantBlocks: [],
          model: compiledActionDraft.metrics.model,
          tokensIn: compiledActionDraft.metrics.tokens_in,
          tokensOut: compiledActionDraft.metrics.tokens_out,
          citations: [],
          metrics: {
            total_ms: compiledActionDraft.metrics.duration_ms,
            retrieval_ms: 0,
            reasoning_ms: compiledActionDraft.metrics.duration_ms,
            iterations: 1,
          },
        } as Awaited<ReturnType<typeof runAgentQuery>>;
      } else {
        result = await Promise.race([
      runAgentQuery({
        content: promptContent,
        orgId,
        userId,
        orgName,
        conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
        // Task 3.2 — thread the triggering message id so write actions like
        // create_task can inherit source_message_id without the LLM having
        // to know about it.
        sourceMessageId: messageId,
        spaceContext: space ? {
          type: space.type as 'dm' | 'group_dm' | 'agent_conversation' | 'public' | 'private',
          name: space.name,
          otherMemberName,
        } : undefined,
        abortSignal: abort.signal,
        maxIterations: hasWriteIntent ? 4 : undefined,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('agent-reply: runAgentQuery timeout after 60s')), AGENT_TIMEOUT_MS),
      ),
        ]);
      }
    } catch (err) {
      if (!wantsDiscussionTask || discussionSourceMessages.length === 0) throw err;
      const fallbackAction = buildDiscussionTaskFallbackAction({
        command: cleanContent,
        sourceMessageId: messageId,
        sourceMessages: discussionSourceMessages,
      });
      console.warn('[agent-reply] Falling back to deterministic discussion task proposal', {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      result = {
        text: 'I could not complete the full reasoning pass, so I prepared a conservative task proposal from the recent discussion for human review.',
        pendingActions: [fallbackAction],
        executedActions: [],
        assistantBlocks: [],
        model: 'deterministic-discussion-fallback',
        tokensIn: 0,
        tokensOut: 0,
        citations: [],
        metrics: { total_ms: 0, retrieval_ms: 0, reasoning_ms: 0, iterations: 0 },
      } as Awaited<ReturnType<typeof runAgentQuery>>;
    } finally {
      clearTimeout(timeout);
    }

    if (!result.text) {
      if (!wantsDiscussionTask || discussionSourceMessages.length === 0) {
        console.warn('[agent-reply] Agent returned empty text, skipping reply');
        return;
      }
      const fallbackAction = buildDiscussionTaskFallbackAction({
        command: cleanContent,
        sourceMessageId: messageId,
        sourceMessages: discussionSourceMessages,
      });
      result = {
        text: 'I prepared a conservative task proposal from the recent discussion for human review.',
        pendingActions: [fallbackAction],
        executedActions: [],
        assistantBlocks: [],
        model: 'deterministic-discussion-fallback',
        tokensIn: 0,
        tokensOut: 0,
        citations: [],
        metrics: { total_ms: 0, retrieval_ms: 0, reasoning_ms: 0, iterations: 0 },
      } as Awaited<ReturnType<typeof runAgentQuery>>;
    }

    const discussionFallbackContent = discussionSourceMessages.map((message) => message.content).join('\n');
    const discussionFallbackProjectName = result.pendingActions.length === 0 && wantsDiscussionTask && discussionFallbackContent
      ? await resolveProjectNameForMentionFallback(orgId, spaceId, `${discussionFallbackContent}\n${cleanContent}`)
      : null;
    const explicitDiscussionFallback = result.pendingActions.length === 0 && wantsDiscussionTask && discussionFallbackContent
      ? extractExplicitCreateTaskAction(discussionFallbackContent, messageId, {
        projectName: discussionFallbackProjectName,
        callerName: callerUser?.name ?? null,
      })
      : null;
    if (fallbackProjectName === null && result.pendingActions.length === 0 && !wantsDiscussionTask) {
      fallbackProjectName = await resolveProjectNameForMentionFallback(orgId, spaceId, promptContent);
    }
    const referentialStatusRequest = result.pendingActions.length === 0 && !wantsDiscussionTask
      ? extractReferentialStatusUpdateRequest(promptContent)
      : null;
    const runtimeResolvedWikiUpdate = shouldCompileRuntimeWikiSuggestion(promptContent, result.executedActions);
    const shouldCompileActionDraft = !wantsDiscussionTask && (
      hasWriteIntent ||
      Boolean(referentialStatusRequest) ||
      runtimeResolvedWikiUpdate ||
      hasApprovalQueuedClaim(result.text)
    );
    if (shouldCompileActionDraft && !compiledActionDraft) {
      try {
        const priorTaskReferences = await collectRecentAgentTaskReferences({
          orgId,
          spaceId,
          agentUserId,
          messageId,
          parentId: threadParentId,
          promptContent,
        });
        compiledActionDraft = await compileDeftyActionDraft({
          orgId,
          promptContent,
          agentReplyText: result.text,
          sourceMessageId: messageId,
          projectNameHint: fallbackProjectName,
          priorTaskReferences,
          spaceName: space?.name ?? null,
          callerName: callerUser?.name ?? null,
          allowedActionNames: runtimeResolvedWikiUpdate ? ['wiki_write'] : undefined,
        });
      } catch (err) {
        console.warn('[agent-reply] Action draft compiler failed; falling back to deterministic extractors', {
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const fallbackStatusUpdate = result.pendingActions.length === 0 && !wantsDiscussionTask
      ? extractStatusUpdateAction(promptContent, messageId)
      : null;
    const fallbackReferentialStatusUpdates = result.pendingActions.length === 0 && !wantsDiscussionTask && !fallbackStatusUpdate
      ? await buildReferentialStatusUpdateFallback({
        orgId,
        spaceId,
        agentUserId,
        messageId,
        parentId: threadParentId,
        content: promptContent,
      })
      : null;
    const explicitPostMessageAction = !wantsDiscussionTask
      ? extractPostMessageAction(promptContent, messageId)
      : null;
    const literalPostMessageOverride = explicitPostMessageAction && hasLiteralPostMessagePayload(promptContent)
      ? explicitPostMessageAction
      : null;
    const fallbackPostMessage = result.pendingActions.length === 0 && !wantsDiscussionTask && !fallbackStatusUpdate && !fallbackReferentialStatusUpdates
      ? explicitPostMessageAction
      : null;
    const fallbackCreateTask = result.pendingActions.length === 0 && !fallbackStatusUpdate && !fallbackReferentialStatusUpdates && !fallbackPostMessage
      ? wantsDiscussionTask
        ? explicitDiscussionFallback ?? extractDiscussionTaskActionFromReply(result.text, messageId) ?? (
          discussionSourceMessages.length > 0
            ? buildDiscussionTaskFallbackAction({
              command: cleanContent,
              sourceMessageId: messageId,
              sourceMessages: discussionSourceMessages,
            })
            : null
        )
        : extractExplicitCreateTaskAction(promptContent, messageId, {
          projectName: fallbackProjectName,
          callerName: callerUser?.name ?? null,
        })
      : null;
    const fallbackWriteAction = fallbackStatusUpdate ?? fallbackPostMessage ?? fallbackCreateTask;
    const compiledActions = compiledActionDraft?.actions?.length ? compiledActionDraft.actions : null;
    const rawPendingActions = fallbackReferentialStatusUpdates
      ?? (literalPostMessageOverride ? [literalPostMessageOverride] : null)
      ?? (compiledActionDraft ? compiledActionDraft.actions : null)
      ?? (fallbackWriteAction ? [fallbackWriteAction] : result.pendingActions);
    const enrichedPendingActions = wantsDiscussionTask
      ? enrichDiscussionTaskActions(rawPendingActions, discussionSourceMessages)
      : rawPendingActions;
    const pendingActionsWithProvenance = enrichedPendingActions.map((action: any) =>
      withMentionProvenance({
        action,
        commandMessageId: messageId,
        spaceId,
        discussionSourceMessages,
      }),
    );
    const validatedPendingActions: any[] = [];
    const proposalValidationWarnings: string[] = [];
    for (const action of pendingActionsWithProvenance) {
      const validation = validateRegisteredProposalAction(action);
      if (validation.ok) validatedPendingActions.push(action);
      else proposalValidationWarnings.push(validation.message);
    }
    const resolvedPendingActions = await resolvePendingActionTargets(orgId, userId, spaceId, validatedPendingActions);
    let pendingActions = resolvedPendingActions.actions.map(normalizePendingApprovalTier);
    const pendingActionTargetWarnings = [...proposalValidationWarnings, ...resolvedPendingActions.warnings];
    if (pendingActions.length > MAX_INLINE_APPROVAL_ACTIONS) {
      pendingActionTargetWarnings.push(
        `That request produced ${pendingActions.length} separate write actions. Ask me for the top ${MAX_INLINE_APPROVAL_ACTIONS}, or ask for a plan first so we can review it safely.`,
      );
      pendingActions = [];
    }
    if (fallbackCreateTask) {
      console.warn('[agent-reply] Added deterministic create_task fallback for explicit task-create prompt', {
        messageId,
        title: fallbackCreateTask.params.title,
      });
    }
    if (fallbackStatusUpdate) {
      console.warn('[agent-reply] Added deterministic update_task_status fallback for explicit status prompt', {
        messageId,
        task_identifier: fallbackStatusUpdate.params.task_identifier,
        new_status: fallbackStatusUpdate.params.new_status,
      });
    }
    if (fallbackReferentialStatusUpdates) {
      console.warn('[agent-reply] Added deterministic referential update_task_status fallback for prior task list', {
        messageId,
        task_identifiers: fallbackReferentialStatusUpdates.map((action: any) => action.params.task_identifier),
        new_status: fallbackReferentialStatusUpdates[0]?.params?.new_status,
      });
    }
    if (fallbackPostMessage) {
      console.warn('[agent-reply] Added deterministic post_message fallback for explicit message prompt', {
        messageId,
        space_name: fallbackPostMessage.params.space_name,
      });
    }
    const targetClarificationMessage = buildTargetClarificationMessage(pendingActionTargetWarnings);
    const writeIntentClarificationMessage = pendingActions.length === 0 && !wantsDiscussionTask
      ? (compiledActionDraft?.clarification || buildWriteIntentClarification(promptContent, result.text))
      : '';
    const referentialApprovalReplyText = fallbackReferentialStatusUpdates?.length
      ? normalizeApprovalSurfaceCopy([
        `I drafted ${fallbackReferentialStatusUpdates.length} task status update${fallbackReferentialStatusUpdates.length === 1 ? '' : 's'} for approval:`,
        ...fallbackReferentialStatusUpdates.map((action: any) => `- ${action.params.task_identifier} → ${action.params.new_status}`),
      ].join('\n'))
      : null;
    const literalPostApprovalReplyText = literalPostMessageOverride
      ? normalizeApprovalSurfaceCopy(`I drafted a message for #${literalPostMessageOverride.params.space_name}.`)
      : null;
    const approvalReplyText = referentialApprovalReplyText ?? literalPostApprovalReplyText ?? (compiledActions && compiledActionDraft?.summary
      ? normalizeApprovalSurfaceCopy(compiledActionDraft.summary)
      : normalizeApprovalSurfaceCopy(result.text));
    const agentReplyContent = targetClarificationMessage && pendingActions.length === 0
      ? targetClarificationMessage
      : pendingActions.length > 0
        ? [
          approvalReplyText,
          targetClarificationMessage || null,
        ].filter(Boolean).join('\n\n')
        : writeIntentClarificationMessage || result.text;

    // Insert the agent's reply as a message in the space.
    // Phase 2 — populate agent_blocks / model / tokens so <AgentMessageBlocks/>
    // can render tool chips, citations footer, and the model+tokens detail
    // (parity with the agent-stream-loop path).
    const replyMetadata = {
      is_agent_reply: true,
      agent_blocks: result.assistantBlocks ?? undefined,
      model: result.model,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      citations: result.citations.length > 0 ? result.citations : undefined,
      pending_actions: pendingActions.length > 0 ? pendingActions : undefined,
      action_compiler_metrics: compiledActionDraft?.metrics,
      action_graph: compiledActionDraft?.graph,
      agent_run_metrics: result.metrics,
    };

    let agentMessage: typeof messages.$inferSelect;
    try {
      const persisted = await persistAgentReplyWithActions({
        orgId,
        spaceId,
        userId,
        agentUserId,
        content: agentReplyContent,
        parentId: threadParentId,
        metadata: replyMetadata,
        pendingActions,
      });
      agentMessage = persisted.message;
    } catch (err) {
      if (pendingActions.length === 0) throw err;
      const pendingActionPersistError = err instanceof Error ? err.message : String(err);
      console.error('[agent-reply] Failed to persist agent reply with pending actions:', err);
      const failedApprovalContent = [
        'I drafted the action, but I could not create the approval card.',
        'Please try again or create it manually.',
      ].join(' ');
      const [fallbackMessage] = await db.insert(messages).values({
        org_id: orgId,
        space_id: spaceId,
        user_id: agentUserId,
        content: failedApprovalContent,
        parent_id: threadParentId,
        metadata: {
          ...sanitizeAgentReplyActionMetadata(replyMetadata),
          pending_actions: undefined,
          pending_actions_error: pendingActionPersistError,
        } as never,
      }).returning();
      if (!fallbackMessage) throw err;
      agentMessage = fallbackMessage;
    }

    // Persist pending write actions as agent_actions rows so the inline
    // <AgentActionCard/> on the reply and the /inbox?tab=approvals queue
    // can render them. Without this, write-intent chat mentions were
    // ghost-queued — stored in metadata.pending_actions but invisible to
    // the approval UI (parity with agent-stream-loop.ts:208).
    // Get the agent user info for the broadcast
    const [agentUserData] = await db.select({
      name: users.name,
      avatar_url: users.avatar_url,
    }).from(users).where(eq(users.id, agentUserId)).limit(1);

    const messageWithUser = {
      ...agentMessage,
      user_name: agentUserData?.name ?? DEFTY_NAME,
      user_avatar: agentUserData?.avatar_url ?? null,
      reactions: [],
      reply_count: 0,
      latest_reply_at: null,
    };

    // Broadcast via Socket.io
    const io = getIO();
    if (io) {
      io.to(`space:${spaceId}`).emit('message:new', messageWithUser);

      // Only emit thread:updated when the reply is actually in a thread.
      if (threadParentId) {
        const [replyStats] = await db.select({
          count: sql<number>`count(*)::int`,
          latest: sql<string>`to_char(max(${messages.created_at}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        })
          .from(messages)
          .where(and(
            eq(messages.parent_id, threadParentId),
            eq(messages.is_deleted, false),
          ));

        io.to(`space:${spaceId}`).emit('thread:updated', {
          parent_id: threadParentId,
          reply_count: replyStats?.count ?? 1,
          latest_reply_at: replyStats?.latest ?? agentMessage.created_at,
        });
      }
    }

    console.log(`[agent-reply] Posted agent reply ${agentMessage.id} in space ${spaceId}${threadParentId ? ` thread ${threadParentId}` : ' (flat)'}`);
  } catch (err) {
    console.error('[agent-reply] Failed to generate agent reply:', err);
    throw err; // Re-throw so the PostgreSQL queue worker can retry.
  }
}
