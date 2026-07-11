import { and, eq } from 'drizzle-orm';
import { db } from './db.js';
import { tasks, taskActivity, projects, taskRelationships } from '@deft/db/schema';
import { reserveTaskNumberRange } from './task-numbering.js';
import { resolveAssigneeWithMatches } from './resolve-assignee.js';

const VALID_PRIORITY = new Set(['p0', 'p1', 'p2', 'p3']);
const MAX_SUBTASKS_PER_DRAFT = 20;
type TaskPriority = 'p0' | 'p1' | 'p2' | 'p3';

export type TaskBundleSubtaskInput = {
  title?: string;
  description?: string;
  assignee_id?: string;
  assignee_name?: string;
  priority?: string;
  due_date?: string;
  start_date?: string;
  estimation?: string;
  depends_on?: number[];
};

export type CreatedTaskSummary = {
  id: string;
  task_id: string;
  project_id: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_id: string | null;
  due_date: Date | null;
  start_date: Date | null;
  estimation: string | null;
  source_message_id: string | null;
  created_at: Date;
  parent_task_id: string | null;
};

export type TaskBundleCreateParams = {
  orgId: string;
  projectId: string;
  projectPrefix: string;
  projectName?: string | null;
  createdBy: string;
  title: string;
  description?: string | null;
  priority?: TaskPriority | string | null;
  assigneeId?: string | null;
  dueDate?: Date | string | null;
  startDate?: Date | string | null;
  estimation?: string | null;
  sourceMessageId?: string | null;
  actionId?: string | null;
  actingAgentEmployeeId?: string | null;
  subtasks?: TaskBundleSubtaskInput[] | null;
};

export type TaskBundleCreateResult = {
  parent: CreatedTaskSummary;
  subtasks: CreatedTaskSummary[];
  allTasks: CreatedTaskSummary[];
};

type NormalizedSubtask = {
  title: string;
  description: string | null;
  assigneeId: string | null;
  priority: TaskPriority;
  dueDate: Date | null;
  startDate: Date | null;
  estimation: string | null;
  dependsOn: number[];
};

export function normalizeTaskDescriptionForStorage(description: unknown): string | null {
  if (typeof description !== 'string') return null;
  const trimmed = description.trim();
  if (!trimmed) return null;
  if (/<(p|ul|ol|li|h[1-6]|blockquote|pre|div|br)\b/i.test(trimmed)) {
    return trimmed;
  }

  const blocks: string[] = [];
  let listItems: string[] = [];
  let orderedItems: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push(`<p>${escapeHtml(paragraphLines.join(' ').replace(/\s+/g, ' ').trim())}</p>`);
    paragraphLines = [];
  };
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push(`<ul>${listItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`);
      listItems = [];
    }
    if (orderedItems.length > 0) {
      blocks.push(`<ol>${orderedItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`);
      orderedItems = [];
    }
  };

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (orderedItems.length > 0) flushList();
      listItems.push(bullet[1]!.trim());
      continue;
    }

    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (listItems.length > 0) flushList();
      orderedItems.push(ordered[1]!.trim());
      continue;
    }

    const heading = line.match(/^#{1,4}\s+(.+)$/) ?? line.match(/^([A-Za-z][A-Za-z0-9 /&-]{2,48}):$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(`<h3>${escapeHtml((heading[1] ?? line).replace(/:$/, '').trim())}</h3>`);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();

  return blocks.join('');
}

export function summarizeTaskBundleParams(params: {
  title?: string;
  description?: string;
  subtasks?: TaskBundleSubtaskInput[] | null;
}) {
  const normalizedSubtasks = normalizeSubtaskInputs(params.subtasks);
  return {
    title: typeof params.title === 'string' ? params.title.trim() : '',
    description: normalizeTaskDescriptionForStorage(params.description),
    subtask_count: normalizedSubtasks.length,
    subtasks: normalizedSubtasks.map((subtask) => ({
      title: subtask.title,
      priority: subtask.priority,
      assignee_name: subtask.assignee_name ?? null,
      due_date: subtask.due_date ?? null,
    })),
  };
}

export async function createTaskBundle(params: TaskBundleCreateParams): Promise<TaskBundleCreateResult> {
  const title = params.title.trim();
  if (!title) throw new Error('task_create requires title');

  const [project] = await db
    .select({ id: projects.id, prefix: projects.prefix, name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, params.projectId), eq(projects.org_id, params.orgId)))
    .limit(1);
  if (!project) throw new Error('task_create: project not found');

  validateTaskBundleSubtasks(params.subtasks);
  const subtasks = await normalizeSubtasksForOrg(params.subtasks, params.orgId, params.priority);
  const count = 1 + subtasks.length;
  const created = await db.transaction(async (tx) => {
    const range = await reserveTaskNumberRange({
      projectId: params.projectId,
      orgId: params.orgId,
      count,
      executor: tx as any,
    });

    const [parent] = await tx
      .insert(tasks)
      .values({
        org_id: params.orgId,
        project_id: params.projectId,
        number: range.firstNumber,
        title,
        description: normalizeTaskDescriptionForStorage(params.description),
        status: 'backlog',
        priority: normalizePriority(params.priority, 'p2'),
        assignee_id: params.assigneeId ?? null,
        created_by: params.createdBy,
        due_date: normalizeDate(params.dueDate),
        start_date: normalizeDate(params.startDate),
        estimation: normalizeOptionalString(params.estimation),
        source_message_id: params.sourceMessageId ?? null,
      })
      .returning();

    if (!parent) throw new Error('task_create: failed to create parent task');

    const childRows: Array<typeof tasks.$inferSelect> = [];
    for (let index = 0; index < subtasks.length; index += 1) {
      const subtask = subtasks[index]!;
      const [child] = await tx
        .insert(tasks)
        .values({
          org_id: params.orgId,
          project_id: params.projectId,
          parent_task_id: parent.id,
          number: range.firstNumber + index + 1,
          title: subtask.title,
          description: subtask.description,
          status: 'backlog',
          priority: subtask.priority,
          assignee_id: subtask.assigneeId,
          created_by: params.createdBy,
          due_date: subtask.dueDate,
          start_date: subtask.startDate,
          estimation: subtask.estimation,
          source_message_id: params.sourceMessageId ?? null,
        })
        .returning();
      if (child) childRows.push(child);
    }

    const relationshipRows = subtasks.flatMap((subtask, index) =>
      subtask.dependsOn.map((dependencyIndex) => ({
        source_task_id: childRows[dependencyIndex - 1]!.id,
        target_task_id: childRows[index]!.id,
        type: 'blocks' as const,
      })),
    );
    if (relationshipRows.length > 0) {
      await tx.insert(taskRelationships).values(relationshipRows);
    }

    const activityRows = [parent, ...childRows].map((task) => ({
      org_id: params.orgId,
      task_id: task.id,
      user_id: params.createdBy,
      action: 'created',
      agent_action_id: params.actionId ?? null,
      acting_agent_employee_id: params.actingAgentEmployeeId ?? null,
    }));
    await tx.insert(taskActivity).values(activityRows);

    return { parent, children: childRows };
  });

  const parentSummary = toCreatedTaskSummary(created.parent, project.prefix);
  const subtaskSummaries = created.children.map((task) => toCreatedTaskSummary(task, project.prefix));
  return {
    parent: parentSummary,
    subtasks: subtaskSummaries,
    allTasks: [parentSummary, ...subtaskSummaries],
  };
}

function normalizeSubtaskInputs(subtasks: TaskBundleSubtaskInput[] | null | undefined) {
  if (!Array.isArray(subtasks)) return [];
  return subtasks
    .slice(0, MAX_SUBTASKS_PER_DRAFT)
    .map((subtask) => {
      const record = (subtask && typeof subtask === 'object' ? subtask : {}) as Partial<TaskBundleSubtaskInput>;
      return {
        ...record,
        title: typeof record.title === 'string' ? record.title.trim() : '',
        assignee_name: normalizeOptionalString(record.assignee_name) ?? undefined,
        due_date: normalizeOptionalString(record.due_date) ?? undefined,
      };
    })
    .filter((subtask) => subtask.title.length > 0);
}

export function validateTaskBundleSubtasks(subtasks: unknown): void {
  if (subtasks === undefined || subtasks === null) return;
  if (!Array.isArray(subtasks)) throw new Error('task_create: subtasks must be a list');
  if (subtasks.length > MAX_SUBTASKS_PER_DRAFT) {
    throw new Error(`task_create: no more than ${MAX_SUBTASKS_PER_DRAFT} subtasks are allowed`);
  }
  for (let index = 0; index < subtasks.length; index += 1) {
    const subtask = subtasks[index];
    if (!subtask || typeof subtask !== 'object' || Array.isArray(subtask)) {
      throw new Error(`task_create: subtask ${index + 1} must be an object`);
    }
    const record = subtask as Record<string, unknown>;
    if (typeof record.title !== 'string' || !record.title.trim()) {
      throw new Error(`task_create: subtask ${index + 1} requires a title`);
    }
    if (record.subtasks !== undefined) {
      throw new Error('task_create: nested subtasks are not supported');
    }
    if (record.depends_on !== undefined) {
      if (!Array.isArray(record.depends_on) || record.depends_on.some((value) => !Number.isInteger(value))) {
        throw new Error(`task_create: subtask ${index + 1} depends_on must contain subtask numbers`);
      }
      if (record.depends_on.some((value) => Number(value) < 1 || Number(value) > index)) {
        throw new Error(`task_create: subtask ${index + 1} may depend only on an earlier subtask`);
      }
    }
  }
}

async function normalizeSubtasksForOrg(
  subtasks: TaskBundleSubtaskInput[] | null | undefined,
  orgId: string,
  inheritedPriority?: string | null,
): Promise<NormalizedSubtask[]> {
  const normalized = normalizeSubtaskInputs(subtasks);
  const result: NormalizedSubtask[] = [];
  for (const subtask of normalized) {
    let assigneeId: string | null = null;
    const assigneeLookup = normalizeOptionalString(subtask.assignee_id) ?? normalizeOptionalString(subtask.assignee_name);
    if (assigneeLookup) {
      const resolved = await resolveAssigneeWithMatches(assigneeLookup, orgId);
      if (!resolved.ok) {
        if (resolved.ambiguous) {
          throw new Error(
            `task_create: ambiguous subtask assignee "${assigneeLookup}". Matches: ${resolved.matches
              .map((match) => match.name)
              .join(', ')}`,
          );
        }
        throw new Error(`task_create: subtask assignee "${assigneeLookup}" not found`);
      }
      assigneeId = resolved.value.id;
    }
    result.push({
      title: subtask.title,
      description: normalizeTaskDescriptionForStorage(subtask.description),
      assigneeId,
      priority: normalizePriority(subtask.priority, normalizePriority(inheritedPriority, 'p2')),
      dueDate: normalizeDate(subtask.due_date),
      startDate: normalizeDate(subtask.start_date),
      estimation: normalizeOptionalString(subtask.estimation),
      dependsOn: Array.isArray(subtask.depends_on) ? [...new Set(subtask.depends_on)] : [],
    });
  }
  return result;
}

export function normalizePriority(value: unknown, fallback: TaskPriority = 'p2'): TaskPriority {
  return typeof value === 'string' && VALID_PRIORITY.has(value) ? (value as TaskPriority) : fallback;
}

export function normalizeDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toCreatedTaskSummary(task: typeof tasks.$inferSelect, prefix: string): CreatedTaskSummary {
  return {
    id: task.id,
    task_id: task.id,
    project_id: task.project_id,
    number: task.number,
    identifier: `${prefix}-${task.number}`,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assignee_id: task.assignee_id,
    due_date: task.due_date,
    start_date: task.start_date,
    estimation: task.estimation,
    source_message_id: task.source_message_id,
    created_at: task.created_at,
    parent_task_id: task.parent_task_id,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
