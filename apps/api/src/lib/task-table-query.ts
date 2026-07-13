import { z } from 'zod';

export const TASK_TABLE_SORT_FIELDS = [
  'number', 'title', 'status', 'priority', 'assignee', 'start_date',
  'due_date', 'estimation', 'labels', 'updated_at', 'project',
] as const;

export type TaskTableSortField = (typeof TASK_TABLE_SORT_FIELDS)[number];
export type TaskTableSort = {
  field: TaskTableSortField;
  direction: 'asc' | 'desc';
  nulls: 'first' | 'last';
};

const GROUP_FIELDS = ['status', 'priority', 'assignee', 'due_date', 'project', 'labels'] as const;

function csv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function parseSort(value: string | undefined): TaskTableSort[] | null {
  if (!value) return [];
  const clauses = value.split(',');
  if (clauses.length > 3) return null;
  const parsed = clauses.map((clause) => {
    const [field, direction, nulls] = clause.split(':');
    if (!(TASK_TABLE_SORT_FIELDS as readonly string[]).includes(field ?? '')) return null;
    if (direction !== 'asc' && direction !== 'desc') return null;
    if (nulls !== 'first' && nulls !== 'last') return null;
    return {
      field: field as TaskTableSortField,
      direction,
      nulls,
    } satisfies TaskTableSort;
  });
  return parsed.some((clause) => clause === null) ? null : parsed as TaskTableSort[];
}

function parseGroup(value: string | undefined): TaskTableSort | null {
  if (!value) return null;
  const [field, direction] = value.split(':');
  if (!(GROUP_FIELDS as readonly string[]).includes(field ?? '')) return null;
  return {
    field: field as TaskTableSortField,
    direction: direction === 'desc' ? 'desc' : 'asc',
    nulls: 'last',
  };
}

const rawQuerySchema = z.object({
  project_id: z.string().min(1).optional(),
  mine: z.enum(['true', 'false']).optional(),
  assignee: z.string().optional(),
  priority: z.string().optional(),
  status: z.string().optional(),
  labels: z.string().optional(),
  due: z.enum(['overdue', 'today', 'this_week']).optional(),
  date_from: z.iso.date().optional(),
  date_to: z.iso.date().optional(),
  sort: z.string().optional(),
  group: z.string().optional(),
  cursor: z.string().optional(),
  page_size: z.coerce.number().int().min(1).max(200).default(100),
});

export function parseTaskTableQuery(input: Record<string, string | undefined>) {
  const parsed = rawQuerySchema.safeParse(input);
  if (!parsed.success) return { success: false as const, error: parsed.error };
  if (!parsed.data.project_id && parsed.data.mine !== 'true') {
    return { success: false as const, error: new Error('project_id or mine=true is required') };
  }
  const sorts = parseSort(parsed.data.sort);
  const group = parseGroup(parsed.data.group);
  if (sorts === null || (parsed.data.group && group === null)) {
    return { success: false as const, error: new Error('Invalid sort or group clause') };
  }
  const priorities = csv(parsed.data.priority);
  const statuses = csv(parsed.data.status);
  if (priorities.some((value) => !['p0', 'p1', 'p2', 'p3'].includes(value))) {
    return { success: false as const, error: new Error('Invalid priority filter') };
  }
  if (statuses.some((value) => !['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'].includes(value))) {
    return { success: false as const, error: new Error('Invalid status filter') };
  }
  return {
    success: true as const,
    data: {
      projectId: parsed.data.project_id ?? null,
      mine: parsed.data.mine === 'true',
      assigneeIds: csv(parsed.data.assignee),
      priorities,
      statuses,
      labelIds: csv(parsed.data.labels),
      due: parsed.data.due ?? null,
      dateFrom: parsed.data.date_from ?? null,
      dateTo: parsed.data.date_to ?? null,
      sorts,
      group,
      cursor: parsed.data.cursor ?? null,
      pageSize: parsed.data.page_size,
    },
  };
}

const cursorSchema = z.object({
  v: z.literal(1),
  signature: z.string().min(1),
  values: z.array(z.union([z.string(), z.number(), z.null()])),
});

export function encodeTaskTableCursor(signature: string, values: Array<string | number | null>): string {
  return Buffer.from(JSON.stringify({ v: 1, signature, values }), 'utf8').toString('base64url');
}

export function decodeTaskTableCursor(value: string | null): { signature: string; values: Array<string | number | null> } | null {
  if (!value) return null;
  try {
    const decoded = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { signature: decoded.signature, values: decoded.values };
  } catch {
    return null;
  }
}
