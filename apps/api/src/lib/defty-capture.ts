import { and, eq, sql } from 'drizzle-orm';
import { agentActions, messages, projects, projectSpaces, spaces, tasks, wikiPages, workIntents } from '@deft/db/schema';
import { db } from './db.js';
import { approveAction } from './agent-approval-resolver.js';
import { ensureDeftyEmployee } from './ensure-defty-membership.js';
import { toPlainText, truncatePlainText } from './plain-text.js';
import { resolveAssigneeWithMatches } from './resolve-assignee.js';

type ResolvedProject = { id: string; name: string };
type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
type ExistingTaskMatch = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  assignee_id: string | null;
  due_date: Date | null;
  project_prefix: string;
  number: number;
};
type TaskUpdatePatch = {
  status?: TaskStatus;
  priority?: 'p0' | 'p1' | 'p2' | 'p3';
  assignee_id?: string | null;
  due_date?: string | null;
  comment?: string;
  description?: string;
};
type TaskCaptureApprovalMode = 'approval' | 'passive';

async function resolveProjectForCapture(
  orgId: string,
  spaceId: string,
  projectName?: string | null,
): Promise<ResolvedProject | null> {
  const normalizedProjectName = projectName?.trim();
  if (normalizedProjectName) {
    const [proj] = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(
        eq(projects.org_id, orgId),
        eq(projects.name, normalizedProjectName),
        eq(projects.is_archived, false),
        eq(projects.is_deleted, false),
      ))
      .limit(1);
    if (proj) return proj;
  }

  const [linked] = await db
    .select({ id: projectSpaces.project_id, name: projects.name })
    .from(projectSpaces)
    .innerJoin(projects, and(
      eq(projectSpaces.project_id, projects.id),
      eq(projects.org_id, orgId),
    ))
    .where(and(
      eq(projectSpaces.space_id, spaceId),
      eq(projects.is_archived, false),
      eq(projects.is_deleted, false),
    ))
    .limit(1);
  if (linked) return linked;

  const [anyProj] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(
      eq(projects.org_id, orgId),
      eq(projects.is_archived, false),
      eq(projects.is_deleted, false),
    ))
    .limit(1);
  return anyProj ?? null;
}

function buildFallbackTitle(content: string): string {
  const plainContent = toPlainText(content);
  const explicit = plainContent.match(
    /\b(?:create|add|make|open|track)\b.{0,40}\b(?:tasks?|todos?|tickets?)\b\s*:?\s*(.+)$/i,
  );
  const candidate = (explicit?.[1]?.trim() || plainContent).replace(/[.!?]+$/g, '');
  return truncatePlainText(candidate.replace(/^please\s+/i, ''), 80) || 'Follow up from chat';
}

type DeftyKnowledgeWikiType = 'decision' | 'resource' | 'concept' | 'entity' | 'procedure' | 'preference' | 'fact';

function shouldAutoApproveKnowledgeCapture(params: {
  captureKind: 'decision_candidate' | 'resource_candidate' | 'note_candidate';
  targetScope: 'org' | 'space';
}): boolean {
  // Public decisions/resources are the durable work record. Auto-approve them
  // quietly so chat stays clean while receipts still preserve governance.
  return params.targetScope === 'org' &&
    (params.captureKind === 'decision_candidate' || params.captureKind === 'resource_candidate');
}

async function autoApproveDeftyCapture(params: {
  actionId?: string;
  deftyUserId: string;
  label: string;
}): Promise<void> {
  if (!params.actionId) return;
  const result = await approveAction(params.actionId, params.deftyUserId);
  if (result.status === 'error') {
    console.warn(
      `[defty-capture] Auto-approval failed for ${params.label} (${params.actionId}): ${result.code} ${result.message}`,
    );
  }
}

function normalizeComparable(value: string): string {
  return toPlainText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const tokensFor = (value: string) => new Set(
    normalizeComparable(value)
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
  const left = tokensFor(a);
  const right = tokensFor(b);
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return intersection / union;
}

function distinctiveReferenceTokens(value: string): Set<string> {
  return new Set(
    normalizeComparable(value)
      .split(/\s+/)
      .filter((token) => token.length >= 4 && /\d/.test(token)),
  );
}

function hasMissingDistinctiveReference(candidate: string, existing: string): boolean {
  const candidateRefs = distinctiveReferenceTokens(candidate);
  if (candidateRefs.size === 0) return false;
  const existingRefs = distinctiveReferenceTokens(existing);
  for (const ref of candidateRefs) {
    if (!existingRefs.has(ref)) return true;
  }
  return false;
}

function sameNormalizedText(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeComparable(a ?? '');
  const right = normalizeComparable(b ?? '');
  return left.length > 0 && left === right;
}

function containsNormalizedText(haystack: string | null | undefined, needle: string | null | undefined): boolean {
  const normalizedHaystack = normalizeComparable(haystack ?? '');
  const normalizedNeedle = normalizeComparable(needle ?? '');
  return normalizedNeedle.length > 0 && normalizedHaystack.includes(normalizedNeedle);
}

function equivalentKnowledgeCapture(params: {
  title: string;
  content: string;
}, row: {
  title: string;
  content: string;
  summary: string | null;
}): boolean {
  const existingBody = `${row.summary ?? ''}\n${row.content ?? ''}`;
  if (sameNormalizedText(params.content, row.content)) return true;
  if (sameNormalizedText(params.content, row.summary)) return true;
  if (sameNormalizedText(params.title, row.title) && containsNormalizedText(existingBody, params.content)) {
    return true;
  }

  const titleOverlap = tokenOverlap(params.title, row.title);
  const bodyOverlap = tokenOverlap(params.content, `${row.title}\n${existingBody}`);
  return titleOverlap >= 0.95 && bodyOverlap >= 0.9;
}

function isKnowledgeUpdateRequest(content: string): boolean {
  const plain = toPlainText(content).trim();
  return /^(?:(?:decision|fact|resource|note|knowledge|wiki|memory)\s*:\s*)?(?:update|correct|correction|amend|revise|change|replace)\b(?:\s+(?:the\s+)?(?:decision|fact|resource|note|knowledge|wiki|memory))?\b/i.test(plain)
    || /\b(?:update|correct|correction|amend|revise|change|replace)\b\s+(?:the\s+)?(?:decision|fact|resource|note|knowledge|wiki|memory)\b/i.test(plain);
}

function stripKnowledgeUpdatePrefix(content: string): string {
  const plain = toPlainText(content);
  const explicit = plain.match(/^(?:(?:decision|fact|resource|note|knowledge|wiki|memory)\s*:\s*)?(?:update|correct|correction|amend|revise|change|replace)\b(?:\s+(?:the\s+)?(?:decision|fact|resource|note|knowledge|wiki|memory))?\s*:?\s*(.+)$/i)
    ?? plain.match(/\b(?:update|correct|correction|amend|revise|change|replace)\b\s+(?:the\s+)?(?:decision|fact|resource|note|knowledge|wiki|memory)\s*:?\s*(.+)$/i);
  return explicit?.[1]?.trim() || plain;
}

function extractKnowledgeUpdateTarget(content: string): string {
  const stripped = stripKnowledgeUpdatePrefix(content)
    .replace(/^(?:the\s+)?(?:decision|fact|resource|note|knowledge|wiki|memory)\s+/i, '')
    .trim();
  const target = stripped.split(/\b(?:to|should|with|so that|because|and)\b/i)[0]?.trim() ?? '';
  return target || stripped;
}

async function findWikiPageForExplicitUpdate(params: {
  orgId: string;
  spaceId: string;
  title: string;
  content: string;
  wikiType: DeftyKnowledgeWikiType;
  scope: 'org' | 'space';
}): Promise<{ id: string; title: string; slug: string } | null> {
  const rows = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      slug: wikiPages.slug,
      content: wikiPages.content,
      summary: wikiPages.summary,
    })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, params.orgId),
      eq(wikiPages.is_deleted, false),
      eq(wikiPages.type, params.wikiType),
      eq(wikiPages.scope, params.scope),
      params.scope === 'space' ? eq(wikiPages.space_id, params.spaceId) : sql`TRUE`,
    ))
    .limit(250);

  const normalizedContent = normalizeComparable(params.content);
  const updateTarget = extractKnowledgeUpdateTarget(params.content);
  const normalizedTarget = normalizeComparable(updateTarget);
  const targetRefs = distinctiveReferenceTokens(updateTarget);
  const matches = rows.filter((row) => {
    const rowReferenceText = `${row.title}\n${row.summary ?? ''}\n${row.content}`;
    const rowRefs = distinctiveReferenceTokens(rowReferenceText);
    if (targetRefs.size > 0) {
      for (const ref of targetRefs) {
        if (!rowRefs.has(ref)) return false;
      }
    }

    const normalizedTitle = normalizeComparable(row.title);
    if (normalizedTitle && normalizedContent.includes(normalizedTitle)) return true;
    if (normalizedTarget && normalizedTarget.length >= 12) {
      if (targetRefs.size > 0 && tokenOverlap(updateTarget, row.title) >= 0.25) {
        return true;
      }
      if (normalizedTitle.includes(normalizedTarget) || normalizedTarget.includes(normalizedTitle)) {
        return true;
      }
      if (tokenOverlap(updateTarget, row.title) >= 0.4) {
        return true;
      }
    }
    const titleOverlap = tokenOverlap(params.title, row.title);
    const bodyOverlap = tokenOverlap(params.content, rowReferenceText);
    return titleOverlap >= 0.85 || bodyOverlap >= 0.82;
  });

  if (matches.length !== 1) return null;
  const match = matches[0]!;
  return { id: match.id, title: match.title, slug: match.slug };
}

function inferTaskStatusUpdate(content: string): TaskStatus | null {
  const normalized = normalizeComparable(content);
  if (!normalized) return null;
  if (/\b(cancelled|canceled|cancel|drop|dropped|wont do|won t do)\b/.test(normalized)) return 'cancelled';
  if (/\b(done|complete|completed|finished|closed|resolved|shipped)\b/.test(normalized)) return 'done';
  if (/\b(in review|ready for review|reviewing|needs review)\b/.test(normalized)) return 'in_review';
  if (/\b(in progress|started|working on|picked up|underway)\b/.test(normalized)) return 'in_progress';
  if (/\b(to do|todo|ready to start)\b/.test(normalized)) return 'todo';
  if (/\b(backlog|backlogged|later queue)\b/.test(normalized)) return 'backlog';
  return null;
}

function inferTaskPriorityUpdate(content: string): 'p0' | 'p1' | 'p2' | 'p3' | null {
  const normalized = normalizeComparable(content);
  const match = normalized.match(/\b(?:priority|prio|severity|make|set|raise|lower)\b.{0,30}\b(p[0-3])\b/);
  return (match?.[1] as 'p0' | 'p1' | 'p2' | 'p3' | undefined) ?? null;
}

function inferTaskDueDateUpdate(content: string): string | null | undefined {
  const clear = content.match(/\b(?:clear|remove|drop)\s+(?:the\s+)?(?:due date|deadline)\b/i);
  if (clear) return null;
  const explicit = content.match(/\b(?:due|deadline)\s*(?:date|on|by|to|is|:)?\s*(\d{4}-\d{2}-\d{2})\b/i);
  return explicit?.[1];
}

function inferTaskCommentUpdate(content: string): string | null {
  const match = content.match(/\b(?:add|leave|post)\s+(?:a\s+)?(?:task\s+)?comment\s*:?\s*(.+)$/i);
  const comment = match?.[1]?.trim();
  return comment ? truncatePlainText(comment, 1000) : null;
}

function inferTaskDescriptionUpdate(content: string): string | null {
  const match = content.match(/\b(?:update|set|change)\s+(?:the\s+)?(?:task\s+)?(?:description|desc)\s*(?:to|:)\s*(.+)$/i)
    ?? content.match(/\b(?:description|desc)\s*:\s*(.+)$/i);
  const description = match?.[1]?.trim();
  return description ? truncatePlainText(description, 4000) : null;
}

async function inferTaskAssigneeUpdate(
  orgId: string,
  content: string,
): Promise<{ assigneeId: string | null; assigneeName: string | null } | undefined> {
  if (/\b(?:unassign|clear assignee|remove assignee)\b/i.test(content)) {
    return { assigneeId: null, assigneeName: null };
  }
  const match = content.match(
    /\b(?:assign|reassign)\b(?:\s+(?:it|this|task|[A-Za-z0-9]{1,16}-?\d+))?\s*(?:to|:)\s+([A-Za-z0-9][A-Za-z0-9 .'-]{1,80})/i,
  ) || content.match(/\b(?:owner|owned by)\b\s*(?:is|:)?\s+([A-Za-z][A-Za-z .'-]{1,80})/i);
  const name = match?.[1]
    ?.split(/\.\s+|[!?]\s+|\b(?:and|with|because|due|priority|prio|add task comment|add comment|comment)\b/i)[0]
    ?.replace(/[.!?]+$/g, '')
    .trim();
  if (!name) return undefined;
  const resolved = await resolveAssigneeWithMatches(name, orgId);
  if (!resolved.ok) return undefined;
  return { assigneeId: resolved.value.id, assigneeName: resolved.value.name };
}

function contentMentionsTask(content: string, task: ExistingTaskMatch): boolean {
  const normalized = normalizeComparable(content);
  const prefix = normalizeComparable(task.project_prefix);
  if (!prefix) return false;
  const ref = `${prefix} ${task.number}`;
  const compactRef = `${prefix}${task.number}`;
  return normalized.includes(ref) || normalized.includes(compactRef);
}

async function findReferencedTaskUpdate(
  orgId: string,
  content: string,
): Promise<{
  task: ExistingTaskMatch;
  patch: TaskUpdatePatch;
  changeSummary: string;
  metadata: Record<string, unknown>;
  noChangeReason?: string;
} | null> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      assignee_id: tasks.assignee_id,
      due_date: tasks.due_date,
      project_prefix: projects.prefix,
      number: tasks.number,
    })
    .from(tasks)
    .innerJoin(projects, and(
      eq(projects.id, tasks.project_id),
      eq(projects.org_id, orgId),
    ))
    .where(and(
      eq(tasks.org_id, orgId),
      eq(tasks.is_deleted, false),
      eq(projects.is_deleted, false),
      eq(projects.is_archived, false),
    ))
    .limit(250);

  const matches = rows.filter((row) => contentMentionsTask(content, row as ExistingTaskMatch));
  if (matches.length !== 1) return null;

  const task = matches[0] as ExistingTaskMatch;
  const patch: TaskUpdatePatch = {};
  const metadata: Record<string, unknown> = {};
  const changes: string[] = [];
  let recognizedNoop = false;

  const status = inferTaskStatusUpdate(content);
  if (status && task.status !== status) {
    patch.status = status;
    changes.push(`status ${task.status} -> ${status}`);
    metadata.previous_status = task.status;
    metadata.proposed_status = status;
  } else if (status && task.status === status) {
    recognizedNoop = true;
    metadata.current_status = task.status;
  }

  const priority = inferTaskPriorityUpdate(content);
  if (priority && task.priority !== priority) {
    patch.priority = priority;
    changes.push(`priority ${task.priority} -> ${priority}`);
    metadata.previous_priority = task.priority;
    metadata.proposed_priority = priority;
  } else if (priority && task.priority === priority) {
    recognizedNoop = true;
    metadata.current_priority = task.priority;
  }

  const dueDate = inferTaskDueDateUpdate(content);
  const existingDueDate = task.due_date?.toISOString().slice(0, 10) ?? null;
  if (dueDate !== undefined && existingDueDate !== dueDate) {
    patch.due_date = dueDate;
    changes.push(dueDate ? `due date -> ${dueDate}` : 'clear due date');
    metadata.previous_due_date = existingDueDate;
    metadata.proposed_due_date = dueDate;
  } else if (dueDate !== undefined && existingDueDate === dueDate) {
    recognizedNoop = true;
    metadata.current_due_date = existingDueDate;
  }

  const assignee = await inferTaskAssigneeUpdate(orgId, content);
  if (assignee && task.assignee_id !== assignee.assigneeId) {
    patch.assignee_id = assignee.assigneeId;
    changes.push(assignee.assigneeName ? `assignee -> ${assignee.assigneeName}` : 'clear assignee');
    metadata.previous_assignee_id = task.assignee_id;
    metadata.proposed_assignee_id = assignee.assigneeId;
    metadata.proposed_assignee_name = assignee.assigneeName;
  } else if (assignee && task.assignee_id === assignee.assigneeId) {
    recognizedNoop = true;
    metadata.current_assignee_id = task.assignee_id;
  }

  const comment = inferTaskCommentUpdate(content);
  if (comment) {
    patch.comment = comment;
    changes.push('add task comment');
    metadata.proposed_comment = comment;
  }

  const description = inferTaskDescriptionUpdate(content);
  if (description) {
    patch.description = description;
    changes.push('update description');
    metadata.proposed_description = description;
  }

  if (Object.keys(patch).length === 0) {
    return recognizedNoop ? {
      task,
      patch,
      changeSummary: '',
      metadata,
      noChangeReason: status ? 'task_status_already_current' : 'task_update_already_current',
    } : null;
  }
  return {
    task,
    patch,
    changeSummary: changes.join(', '),
    metadata,
  };
}

async function findSimilarActiveTask(params: {
  orgId: string;
  projectId: string | null;
  title: string;
  content: string;
}): Promise<ExistingTaskMatch | null> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      assignee_id: tasks.assignee_id,
      due_date: tasks.due_date,
      project_prefix: projects.prefix,
      number: tasks.number,
    })
    .from(tasks)
    .innerJoin(projects, and(
      eq(projects.id, tasks.project_id),
      eq(projects.org_id, params.orgId),
    ))
    .where(and(
      eq(tasks.org_id, params.orgId),
      params.projectId ? eq(tasks.project_id, params.projectId) : sql`TRUE`,
      eq(tasks.is_deleted, false),
      eq(projects.is_deleted, false),
      eq(projects.is_archived, false),
      sql`${tasks.status} NOT IN ('done', 'cancelled')`,
    ))
    .limit(250);

  const wantedTitle = normalizeComparable(params.title);
  for (const row of rows) {
    const existingComparable = `${row.title}\n${row.description ?? ''}`;
    if (hasMissingDistinctiveReference(`${params.title}\n${params.content}`, existingComparable)) {
      continue;
    }
    const existingTitle = normalizeComparable(row.title);
    if (wantedTitle && existingTitle === wantedTitle) {
      return row as ExistingTaskMatch;
    }
    const titleOverlap = tokenOverlap(params.title, row.title);
    const bodyOverlap = tokenOverlap(params.content, existingComparable);
    if (titleOverlap >= 0.9 || (titleOverlap >= 0.75 && bodyOverlap >= 0.6)) {
      return row as ExistingTaskMatch;
    }
  }
  return null;
}

async function findSimilarWikiPage(params: {
  orgId: string;
  spaceId: string;
  title: string;
  content: string;
  wikiType: DeftyKnowledgeWikiType;
  scope: 'org' | 'space';
}): Promise<{ id: string; title: string; slug: string } | null> {
  const rows = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      slug: wikiPages.slug,
      content: wikiPages.content,
      summary: wikiPages.summary,
    })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, params.orgId),
      eq(wikiPages.is_deleted, false),
      eq(wikiPages.type, params.wikiType),
      eq(wikiPages.scope, params.scope),
      params.scope === 'space' ? eq(wikiPages.space_id, params.spaceId) : sql`TRUE`,
    ))
    .limit(250);

  for (const row of rows) {
    if (hasMissingDistinctiveReference(
      `${params.title}\n${params.content}`,
      `${row.title}\n${row.summary ?? ''}\n${row.content ?? ''}`,
    )) {
      continue;
    }
    if (equivalentKnowledgeCapture(params, row)) {
      return { id: row.id, title: row.title, slug: row.slug };
    }
  }
  return null;
}

async function findRelatedWikiPage(params: {
  orgId: string;
  spaceId: string;
  title: string;
  content: string;
  wikiType: DeftyKnowledgeWikiType;
  scope: 'org' | 'space';
}): Promise<{ id: string; title: string; slug: string } | null> {
  const rows = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      slug: wikiPages.slug,
      content: wikiPages.content,
      summary: wikiPages.summary,
    })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, params.orgId),
      eq(wikiPages.is_deleted, false),
      eq(wikiPages.type, params.wikiType),
      eq(wikiPages.scope, params.scope),
      params.scope === 'space' ? eq(wikiPages.space_id, params.spaceId) : sql`TRUE`,
    ))
    .limit(250);

  let best: { id: string; title: string; slug: string; score: number } | null = null;
  for (const row of rows) {
    const existingComparable = `${row.title}\n${row.summary ?? ''}\n${row.content ?? ''}`;
    if (hasMissingDistinctiveReference(`${params.title}\n${params.content}`, existingComparable)) {
      continue;
    }
    const candidateTitle = normalizeComparable(params.title);
    const existingTitle = normalizeComparable(row.title);
    const titleContains = existingTitle.length >= 12 &&
      (candidateTitle.includes(existingTitle) || existingTitle.includes(candidateTitle));
    const titleOverlap = tokenOverlap(params.title, row.title);
    const bodyOverlap = tokenOverlap(params.content, existingComparable);
    const score = titleContains ? 1 : (titleOverlap * 0.55) + (bodyOverlap * 0.45);
    const related =
      titleContains ||
      (titleOverlap >= 0.55 && bodyOverlap >= 0.24) ||
      bodyOverlap >= 0.48 ||
      (titleOverlap >= 0.72 && bodyOverlap >= 0.16);
    if (!related) continue;
    if (!best || score > best.score) {
      best = { id: row.id, title: row.title, slug: row.slug, score };
    }
  }
  return best ? { id: best.id, title: best.title, slug: best.slug } : null;
}

function buildKnowledgeTitle(content: string, type: DeftyKnowledgeWikiType): string {
  const plainContent = toPlainText(content);
  const prefix = type === 'decision'
    ? /\b(?:decision|decided|agreed)\s*:?\s*/i
    : /\b(?:resource|reference|link|doc|checklist)\s*:?\s*/i;
  const candidate = plainContent
    .replace(prefix, '')
    .replace(/^we\s+(?:will|decided\s+to|agreed\s+to)\s+/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  const fallback =
    type === 'decision' ? 'Decision from chat'
    : type === 'resource' ? 'Resource from chat'
    : 'Note from chat';
  return truncatePlainText(candidate || plainContent || fallback, 90) || fallback;
}

async function queueDeftyKnowledgeUpdateCapture(params: {
  orgId: string;
  sourceUserId: string;
  spaceId: string;
  messageId: string;
  content: string;
  targetPage: { id: string; title: string; slug: string };
  captureKind: 'decision_candidate' | 'resource_candidate' | 'note_candidate';
  captureReason?: string | null;
  extraction: 'llm' | 'deterministic' | 'classifier';
  metadata?: Record<string, unknown>;
  autoApprove?: boolean;
  preferUpdate?: boolean;
}): Promise<{ queued: boolean; actionId?: string; skippedReason?: string }> {
  const {
    orgId,
    sourceUserId,
    spaceId,
    messageId,
    content,
    targetPage,
    captureKind,
    captureReason,
    extraction,
    metadata = {},
    autoApprove = false,
  } = params;
  const defty = await ensureDeftyEmployee(orgId);
  const updatedBody = stripKnowledgeUpdatePrefix(content);
  if (!updatedBody) return { queued: false, skippedReason: 'empty_update' };

  const dedupeKey = `defty_capture:${captureKind}:wiki_update:${messageId}:${targetPage.slug}`;
  const title = `Update knowledge: ${targetPage.title}`;
  const summary = truncatePlainText(updatedBody, 240);

  const queued = await db.transaction(async (tx) => {
    const proposedParams = {
      caller_employee_slug: defty.slug,
      page_id: targetPage.id,
      slug: targetPage.slug,
      patch: {
        content: updatedBody,
        summary,
      },
      source_message_id: messageId,
      source_space_id: spaceId,
      source_user_id: sourceUserId,
      origin_message_id: messageId,
      origin_space_id: spaceId,
      origin_user_id: sourceUserId,
      capture_kind: captureKind,
      capture_reason: captureReason || 'A chat message explicitly requested an update to existing knowledge.',
      policy_reason: captureReason || 'A chat message explicitly requested an update to existing knowledge.',
      dedupe_key: dedupeKey,
      extraction,
      proposed_by: 'defty',
      target_wiki_page_id: targetPage.id,
      target_wiki_slug: targetPage.slug,
      target_wiki_title: targetPage.title,
      metadata: {
        ...metadata,
        target_wiki_page_id: targetPage.id,
        target_wiki_slug: targetPage.slug,
        update_kind: 'wiki_content',
      },
    };

    const [intent] = await tx
      .insert(workIntents)
      .values({
        org_id: orgId,
        space_id: spaceId,
        source_message_id: messageId,
        source_user_id: sourceUserId,
        agent_employee_id: defty.employeeId,
        kind: captureKind,
        status: 'proposed',
        title,
        summary,
        proposed_action: 'wiki_update',
        proposed_params: proposedParams,
        dedupe_key: dedupeKey,
        metadata: proposedParams.metadata,
      })
      .onConflictDoNothing({
        target: [workIntents.org_id, workIntents.dedupe_key],
      })
      .returning({ id: workIntents.id });

    let intentId = intent?.id;
    if (!intentId) {
      const [existingIntent] = await tx
        .select({ id: workIntents.id })
        .from(workIntents)
        .where(and(
          eq(workIntents.org_id, orgId),
          eq(workIntents.dedupe_key, dedupeKey),
        ))
        .limit(1);
      intentId = existingIntent?.id;
    }
    if (!intentId) throw new Error('Failed to create or recover Defty knowledge-update intent');

    const [existingAction] = await tx
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'defty_capture'),
        sql`${agentActions.params}->>'dedupe_key' = ${dedupeKey}`,
      ))
      .limit(1);
    if (existingAction) {
      return { queued: false, actionId: existingAction.id, skippedReason: 'duplicate' };
    }

    const [queuedAction] = await tx
      .insert(agentActions)
      .values({
        org_id: orgId,
        user_id: defty.userId,
        agent_employee_id: defty.employeeId,
        conversation_id: spaceId,
        action: 'wiki_update',
        message_id: messageId,
        params: {
          ...proposedParams,
          work_intent_id: intentId,
          work_intent_status: 'proposed',
        } as any,
        approval_tier: 'quick',
        approval_status: 'pending',
        source: 'defty_capture',
      })
      .returning({ id: agentActions.id });

    if (!queuedAction) throw new Error('Failed to create Defty knowledge-update approval');
    return { queued: true, actionId: queuedAction.id };
  });

  if (queued.queued && autoApprove) {
    await autoApproveDeftyCapture({
      actionId: queued.actionId,
      deftyUserId: defty.userId,
      label: `knowledge update ${targetPage.slug}`,
    });
  }

  return queued;
}

export async function queueDeftyKnowledgeCapture(params: {
  orgId: string;
  sourceUserId: string;
  spaceId: string;
  messageId: string;
  content: string;
  rawContent?: string | null;
  title?: string | null;
  summary?: string | null;
  wikiType: DeftyKnowledgeWikiType;
  captureKind: 'decision_candidate' | 'resource_candidate' | 'note_candidate';
  captureReason?: string | null;
  extraction?: 'llm' | 'deterministic' | 'classifier';
  tags?: string[];
  metadata?: Record<string, unknown>;
  autoApprove?: boolean;
  preferUpdate?: boolean;
}): Promise<{ queued: boolean; actionId?: string; skippedReason?: string }> {
  const {
    orgId,
    sourceUserId,
    spaceId,
    messageId,
    content,
    rawContent,
    title,
    summary,
    wikiType,
    captureKind,
    captureReason,
    extraction = 'classifier',
    tags = [],
    metadata = {},
    autoApprove: forceAutoApprove,
    preferUpdate = false,
  } = params;

  const plainContent = toPlainText(content);
  if (!plainContent) return { queued: false, skippedReason: 'empty_content' };
  const rawPlainContent = toPlainText(rawContent || content);

  const [sourceMessage] = await db
    .select({ id: messages.id, spaceType: spaces.type })
    .from(messages)
    .innerJoin(spaces, and(
      eq(spaces.id, messages.space_id),
      eq(spaces.org_id, orgId),
      eq(spaces.is_archived, false),
    ))
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
      eq(messages.space_id, spaceId),
      eq(messages.user_id, sourceUserId),
      eq(messages.is_deleted, false),
    ))
    .limit(1);
  if (!sourceMessage) return { queued: false, skippedReason: 'source_message_missing' };
  const targetScope = sourceMessage.spaceType === 'public' ? 'org' : 'space';
  const finalTitle = truncatePlainText(title || buildKnowledgeTitle(content, wikiType), 120);
  const finalSummary = truncatePlainText(summary || plainContent, 240);

  const explicitKnowledgeUpdate = isKnowledgeUpdateRequest(rawPlainContent);
  if (explicitKnowledgeUpdate) {
    const targetPage = await findWikiPageForExplicitUpdate({
      orgId,
      spaceId,
      title: finalTitle,
      content: rawPlainContent,
      wikiType,
      scope: targetScope,
    });
    if (targetPage) {
      return queueDeftyKnowledgeUpdateCapture({
        orgId,
        sourceUserId,
        spaceId,
        messageId,
        content: rawPlainContent,
        targetPage,
        captureKind,
        captureReason,
        extraction,
        metadata: {
          ...metadata,
          update_request: true,
          extracted_content: plainContent,
        },
        autoApprove: forceAutoApprove ?? shouldAutoApproveKnowledgeCapture({ captureKind, targetScope }),
      });
    }
    if (metadata.batch_capture !== true) {
      return { queued: false, skippedReason: 'knowledge_update_target_missing' };
    }
  }

  const similarPage = await findSimilarWikiPage({
    orgId,
    spaceId,
    title: finalTitle,
    content: plainContent,
    wikiType,
    scope: targetScope,
  });
  if (similarPage) {
    return { queued: false, skippedReason: 'knowledge_already_captured' };
  }

  if (preferUpdate) {
    const relatedPage = await findRelatedWikiPage({
      orgId,
      spaceId,
      title: finalTitle,
      content: plainContent,
      wikiType,
      scope: targetScope,
    });
    if (relatedPage) {
      return queueDeftyKnowledgeUpdateCapture({
        orgId,
        sourceUserId,
        spaceId,
        messageId,
        content: plainContent,
        targetPage: relatedPage,
        captureKind,
        captureReason: captureReason || 'A settled discussion refined existing durable knowledge.',
        extraction,
        metadata: {
          ...metadata,
          related_wiki_update: true,
          extracted_title: finalTitle,
          extracted_summary: finalSummary,
        },
        autoApprove: forceAutoApprove ?? shouldAutoApproveKnowledgeCapture({ captureKind, targetScope }),
      });
    }
  }

  const dedupeKey = `defty_capture:${captureKind}:wiki_create:${messageId}`;
  const [existingIntent] = await db
    .select({ id: workIntents.id })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, orgId),
      eq(workIntents.dedupe_key, dedupeKey),
    ))
    .limit(1);
  if (existingIntent) {
    const [existingAction] = await db
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'defty_capture'),
        sql`${agentActions.params}->>'work_intent_id' = ${existingIntent.id}`,
      ))
      .limit(1);
    if (existingAction) {
      return { queued: false, actionId: existingAction.id, skippedReason: 'duplicate' };
    }
  }

  const [existing] = await db
    .select({ id: agentActions.id })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, orgId),
      eq(agentActions.action, 'wiki_create'),
      sql`(
        ${agentActions.params}->>'dedupe_key' = ${dedupeKey}
        OR (
          ${agentActions.message_id} = ${messageId}
          AND COALESCE(${agentActions.params}->>'capture_kind', '') = ${captureKind}
        )
      )`,
    ))
    .limit(1);
  if (existing) return { queued: false, actionId: existing.id, skippedReason: 'duplicate' };

  const defty = await ensureDeftyEmployee(orgId);
  const finalMetadata = {
    extraction,
    ...metadata,
  };

  const autoApprove = forceAutoApprove ?? shouldAutoApproveKnowledgeCapture({ captureKind, targetScope });
  const queued = await db.transaction(async (tx) => {
    const proposedParams = {
      caller_employee_slug: defty.slug,
      title: finalTitle,
      content: plainContent,
      summary: finalSummary,
      type: wikiType,
      scope: targetScope,
      space_id: spaceId,
      source_message_id: messageId,
      source_space_id: spaceId,
      source_user_id: sourceUserId,
      origin_message_id: messageId,
      origin_space_id: spaceId,
      origin_user_id: sourceUserId,
      capture_kind: captureKind,
      capture_reason: captureReason || null,
      policy_reason: captureReason || null,
      dedupe_key: dedupeKey,
      extraction,
      proposed_by: 'defty',
      tags,
      metadata: finalMetadata,
    };

    const [intent] = await tx
      .insert(workIntents)
      .values({
        org_id: orgId,
        space_id: spaceId,
        source_message_id: messageId,
        source_user_id: sourceUserId,
        agent_employee_id: defty.employeeId,
        kind: captureKind,
        status: 'proposed',
        title: finalTitle,
        summary: finalSummary,
        proposed_action: 'wiki_create',
        proposed_params: proposedParams,
        dedupe_key: dedupeKey,
        metadata: finalMetadata,
      })
      .onConflictDoNothing({
        target: [workIntents.org_id, workIntents.dedupe_key],
      })
      .returning({ id: workIntents.id });

    let intentId = intent?.id;
    if (!intentId) {
      const [existingIntent] = await tx
        .select({ id: workIntents.id })
        .from(workIntents)
        .where(and(
          eq(workIntents.org_id, orgId),
          eq(workIntents.dedupe_key, dedupeKey),
        ))
        .limit(1);
      intentId = existingIntent?.id;
    }

    if (!intentId) {
      throw new Error('Failed to create or recover Defty knowledge intent');
    }

    const [existingAction] = await tx
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'defty_capture'),
        sql`${agentActions.params}->>'dedupe_key' = ${dedupeKey}`,
      ))
      .limit(1);
    if (existingAction) {
      return { queued: false, actionId: existingAction.id, skippedReason: 'duplicate' };
    }

    const [queuedAction] = await tx
      .insert(agentActions)
      .values({
        org_id: orgId,
        user_id: defty.userId,
        agent_employee_id: defty.employeeId,
        conversation_id: spaceId,
        action: 'wiki_create',
        message_id: messageId,
        params: {
          ...proposedParams,
          work_intent_id: intentId,
          work_intent_status: 'proposed',
          metadata: {
            ...finalMetadata,
            work_intent_id: intentId,
          },
        } as any,
        approval_tier: 'quick',
        approval_status: 'pending',
        source: 'defty_capture',
      })
      .returning({ id: agentActions.id });

    if (!queuedAction) {
      throw new Error('Failed to create Defty knowledge approval');
    }

    return { queued: true, actionId: queuedAction.id };
  });

  if (queued.queued && autoApprove) {
    await autoApproveDeftyCapture({
      actionId: queued.actionId,
      deftyUserId: defty.userId,
      label: `knowledge create ${dedupeKey}`,
    });
  }

  return queued;
}

async function queueDeftyTaskUpdateCapture(params: {
  orgId: string;
  sourceUserId: string;
  spaceId: string;
  messageId: string;
  content: string;
  targetTask: ExistingTaskMatch;
  patch: TaskUpdatePatch;
  changeSummary: string;
  updateMetadata?: Record<string, unknown>;
  captureKind: 'task_candidate' | 'blocker_candidate';
  captureReason?: string | null;
  extraction: 'llm' | 'deterministic' | 'classifier';
  approvalMode?: TaskCaptureApprovalMode;
}): Promise<{ queued: boolean; actionId?: string; skippedReason?: string }> {
  const {
    orgId,
    sourceUserId,
    spaceId,
    messageId,
    content,
    targetTask,
    patch,
    changeSummary,
    updateMetadata = {},
    captureKind,
    captureReason,
    extraction,
    approvalMode = 'approval',
  } = params;
  const defty = await ensureDeftyEmployee(orgId);
  const taskRef = `${targetTask.project_prefix}-${targetTask.number}`;
  const updateKind = Object.keys(patch).sort().join('_') || 'patch';
  const dedupeKey = `defty_capture:${captureKind}:task_update:${messageId}:${targetTask.id}:${updateKind}`;
  const title = `Update ${taskRef}: ${targetTask.title}`;
  const summary = changeSummary ? `Update ${taskRef}: ${changeSummary}.` : `Update ${taskRef}.`;

  return db.transaction(async (tx) => {
    const [intent] = await tx
      .insert(workIntents)
      .values({
        org_id: orgId,
        space_id: spaceId,
        source_message_id: messageId,
        source_user_id: sourceUserId,
        agent_employee_id: defty.employeeId,
        kind: captureKind,
        status: 'proposed',
        title,
        summary,
        proposed_action: 'task_update',
        proposed_params: {
          caller_employee_slug: defty.slug,
          task_id: targetTask.id,
          title,
          description: content,
          patch,
          source_message_id: messageId,
          source_space_id: spaceId,
          source_user_id: sourceUserId,
          origin_message_id: messageId,
          origin_space_id: spaceId,
          origin_user_id: sourceUserId,
          capture_kind: captureKind,
          capture_reason: captureReason || 'A chat message explicitly referenced an existing task and a status change.',
          policy_reason: captureReason || 'A chat message explicitly referenced an existing task and a status change.',
          dedupe_key: dedupeKey,
          work_intent_status: 'proposed',
          extraction,
          proposed_by: 'defty',
          target_task_ref: taskRef,
          approval_mode: approvalMode,
        },
        dedupe_key: dedupeKey,
        metadata: {
          extraction,
          update_kind: updateKind === 'status' ? 'task_status' : 'task_patch',
          update_fields: Object.keys(patch).sort(),
          target_task_id: targetTask.id,
          target_task_ref: taskRef,
          approval_mode: approvalMode,
          ...updateMetadata,
        },
      })
      .onConflictDoNothing({
        target: [workIntents.org_id, workIntents.dedupe_key],
      })
      .returning({ id: workIntents.id });

    let intentId = intent?.id;
    if (!intentId) {
      const [existingIntent] = await tx
        .select({ id: workIntents.id })
        .from(workIntents)
        .where(and(
          eq(workIntents.org_id, orgId),
          eq(workIntents.dedupe_key, dedupeKey),
        ))
        .limit(1);
      intentId = existingIntent?.id;
    }

    if (!intentId) throw new Error('Failed to create or recover Defty task-update intent');

    if (approvalMode === 'passive') {
      return { queued: true, skippedReason: 'passive_intent' };
    }

    const [existingAction] = await tx
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'defty_capture'),
        sql`${agentActions.params}->>'dedupe_key' = ${dedupeKey}`,
      ))
      .limit(1);
    if (existingAction) {
      return { queued: false, actionId: existingAction.id, skippedReason: 'duplicate' };
    }

    const [queuedAction] = await tx
      .insert(agentActions)
      .values({
        org_id: orgId,
        user_id: defty.userId,
        agent_employee_id: defty.employeeId,
        conversation_id: spaceId,
        action: 'task_update',
        message_id: messageId,
        params: {
          caller_employee_slug: defty.slug,
          task_id: targetTask.id,
          title,
          description: content,
          patch,
          source_message_id: messageId,
          source_space_id: spaceId,
          source_user_id: sourceUserId,
          origin_message_id: messageId,
          origin_space_id: spaceId,
          origin_user_id: sourceUserId,
          capture_kind: captureKind,
          capture_reason: captureReason || 'A chat message explicitly referenced an existing task and a status change.',
          policy_reason: captureReason || 'A chat message explicitly referenced an existing task and a status change.',
          dedupe_key: dedupeKey,
          work_intent_id: intentId,
          work_intent_status: 'proposed',
          extraction,
          proposed_by: 'defty',
          target_task_ref: taskRef,
          approval_mode: approvalMode,
        } as any,
        approval_tier: 'quick',
        approval_status: 'pending',
        source: 'defty_capture',
      })
      .returning({ id: agentActions.id });

    if (!queuedAction) throw new Error('Failed to create Defty task-update approval');
    return { queued: true, actionId: queuedAction.id };
  });
}

export async function queueDeftyCreateTaskCapture(params: {
  orgId: string;
  sourceUserId: string;
  spaceId: string;
  messageId: string;
  content: string;
  title?: string | null;
  description?: string | null;
  priority?: 'p0' | 'p1' | 'p2' | 'p3' | null;
  assigneeName?: string | null;
  projectName?: string | null;
  captureKind: 'task_candidate' | 'blocker_candidate';
  captureReason?: string | null;
  extraction?: 'llm' | 'deterministic' | 'classifier';
  approvalMode?: TaskCaptureApprovalMode;
}): Promise<{ queued: boolean; actionId?: string; skippedReason?: string }> {
  const {
    orgId,
    sourceUserId,
    spaceId,
    messageId,
    content,
    title,
    description,
    priority,
    assigneeName,
    projectName,
    captureKind,
    captureReason,
    extraction = 'classifier',
    approvalMode = 'approval',
  } = params;

  const plainContent = toPlainText(content);
  if (!plainContent) return { queued: false, skippedReason: 'empty_content' };

  const [sourceMessage] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
      eq(messages.space_id, spaceId),
      eq(messages.user_id, sourceUserId),
      eq(messages.is_deleted, false),
    ))
    .limit(1);
  if (!sourceMessage) return { queued: false, skippedReason: 'source_message_missing' };

  const dedupeKey = `defty_capture:${captureKind}:task_create:${messageId}`;
  const legacyDedupeKey = `defty_capture:${captureKind}:create_task:${messageId}`;
  const [existingIntent] = await db
    .select({ id: workIntents.id })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, orgId),
      eq(workIntents.dedupe_key, dedupeKey),
    ))
    .limit(1);
  if (existingIntent) {
    const [existingAction] = await db
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'defty_capture'),
        sql`${agentActions.params}->>'work_intent_id' = ${existingIntent.id}`,
      ))
      .limit(1);
    if (existingAction) {
      return { queued: false, actionId: existingAction.id, skippedReason: 'duplicate' };
    }
  }

  const [existing] = await db
    .select({ id: agentActions.id })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, orgId),
      sql`${agentActions.action} IN ('create_task', 'task_create')`,
      sql`(
        ${agentActions.params}->>'dedupe_key' IN (${dedupeKey}, ${legacyDedupeKey})
        OR (
          ${agentActions.message_id} = ${messageId}
          AND COALESCE(${agentActions.params}->>'capture_kind', '') IN ('', 'task_candidate', 'blocker_candidate')
        )
      )`,
    ))
    .limit(1);
  if (existing) return { queued: false, actionId: existing.id, skippedReason: 'duplicate' };

  const taskUpdate = await findReferencedTaskUpdate(orgId, plainContent);
  if (taskUpdate) {
    if (taskUpdate.noChangeReason) {
      return { queued: false, skippedReason: taskUpdate.noChangeReason };
    }
    return queueDeftyTaskUpdateCapture({
      orgId,
      sourceUserId,
      spaceId,
      messageId,
      content: plainContent,
      targetTask: taskUpdate.task,
      patch: taskUpdate.patch,
      changeSummary: taskUpdate.changeSummary,
      updateMetadata: taskUpdate.metadata,
      captureKind,
      captureReason,
      extraction,
      approvalMode,
    });
  }

  const project = await resolveProjectForCapture(orgId, spaceId, projectName);
  if (!project) return { queued: false, skippedReason: 'project_missing' };

  const defty = await ensureDeftyEmployee(orgId);
  const finalTitle = truncatePlainText(title || buildFallbackTitle(content), 80);
  if (captureKind === 'task_candidate') {
    const similarTask = await findSimilarActiveTask({
      orgId,
      projectId: project.id,
      title: finalTitle,
      content: description || plainContent,
    });
    if (similarTask) {
      return { queued: false, skippedReason: 'task_already_captured' };
    }
  }

  let assigneeId: string | null = null;
  let resolvedAssigneeName: string | null = null;
  const requestedAssigneeName = assigneeName?.trim() || null;
  if (requestedAssigneeName) {
    const resolved = await resolveAssigneeWithMatches(requestedAssigneeName, orgId);
    if (resolved.ok) {
      assigneeId = resolved.value.id;
      resolvedAssigneeName = resolved.value.name;
    }
  }

  return db.transaction(async (tx) => {
    const [intent] = await tx
      .insert(workIntents)
      .values({
        org_id: orgId,
        space_id: spaceId,
        source_message_id: messageId,
        source_user_id: sourceUserId,
        agent_employee_id: defty.employeeId,
        kind: captureKind,
        status: 'proposed',
        title: finalTitle,
        summary: description || plainContent,
        proposed_action: 'task_create',
        proposed_params: {
          title: finalTitle,
          description: description || plainContent,
          priority: priority || 'p2',
          project_id: project.id,
          space_id: spaceId,
          assignee_id: assigneeId,
          assignee_name: resolvedAssigneeName,
          project_name: project.name,
          source_message_id: messageId,
          source_space_id: spaceId,
          source_user_id: sourceUserId,
          capture_kind: captureKind,
          capture_reason: captureReason || null,
          extraction,
          approval_mode: approvalMode,
        },
        dedupe_key: dedupeKey,
        metadata: {
          extraction,
          legacy_dedupe_key: legacyDedupeKey,
          approval_mode: approvalMode,
        },
      })
      .onConflictDoNothing({
        target: [workIntents.org_id, workIntents.dedupe_key],
      })
      .returning({ id: workIntents.id });

    let intentId = intent?.id;
    if (!intentId) {
      const [existingIntent] = await tx
        .select({ id: workIntents.id })
        .from(workIntents)
        .where(and(
          eq(workIntents.org_id, orgId),
          eq(workIntents.dedupe_key, dedupeKey),
        ))
        .limit(1);
      intentId = existingIntent?.id;
    }

    if (!intentId) {
      throw new Error('Failed to create or recover Defty work intent');
    }

    if (approvalMode === 'passive') {
      return { queued: true, skippedReason: 'passive_intent' };
    }

    await tx.execute(sql`
      SELECT id
      FROM work_intents
      WHERE id = ${intentId}
        AND org_id = ${orgId}
      FOR UPDATE
    `);

    const [existingAction] = await tx
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'defty_capture'),
        sql`${agentActions.params}->>'dedupe_key' = ${dedupeKey}`,
      ))
      .limit(1);
    if (existingAction) {
      return { queued: false, actionId: existingAction.id, skippedReason: 'duplicate' };
    }

    const [queuedAction] = await tx
      .insert(agentActions)
      .values({
        org_id: orgId,
        user_id: defty.userId,
        agent_employee_id: defty.employeeId,
        conversation_id: spaceId,
        action: 'task_create',
        message_id: messageId,
        params: {
          caller_employee_slug: defty.slug,
          title: finalTitle,
          description: description || plainContent,
          priority: priority || 'p2',
          project_id: project.id,
          space_id: spaceId,
          assignee_id: assigneeId,
          assignee_name: resolvedAssigneeName,
          project_name: project.name,
          source_message_id: messageId,
          source_space_id: spaceId,
          source_user_id: sourceUserId,
          origin_message_id: messageId,
          origin_space_id: spaceId,
          origin_user_id: sourceUserId,
          capture_kind: captureKind,
          capture_reason: captureReason || null,
          policy_reason: captureReason || null,
          dedupe_key: dedupeKey,
          work_intent_id: intentId,
          work_intent_status: 'proposed',
          extraction,
          proposed_by: 'defty',
          approval_mode: approvalMode,
        } as any,
        approval_tier: 'quick',
        approval_status: 'pending',
        source: 'defty_capture',
      })
      .returning({ id: agentActions.id });

    if (!queuedAction) {
      throw new Error('Failed to create Defty capture approval');
    }

    return { queued: true, actionId: queuedAction.id };
  });
}
