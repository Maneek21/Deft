type UnknownRecord = Record<string, unknown>;

export function isModuleTaskClosed(status: string): boolean {
  return ['done', 'cancelled', 'won', 'lost'].includes(status);
}

export function moduleTaskDueLabel(task: Pick<ModuleRecordTaskLink, 'dueDate' | 'status'>, now = new Date()): string {
  const day = task.dueDate?.slice(0, 10);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'No due date';
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (!isModuleTaskClosed(task.status)) {
    if (day < today) return `Overdue · ${day}`;
    if (day === today) return 'Due today';
  }
  return `Due ${day}`;
}

export type TaskModuleRecordLink = {
  edgeId: string;
  resourceId: string;
  recordId: string;
  moduleSlug: string;
  moduleName: string;
  collectionKey: string;
  collectionName: string;
  title: string;
  url: string;
  createdAt: string;
};

export type ModuleRecordTaskLink = {
  edgeId: string;
  taskId: string;
  title: string;
  identifier: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  projectId: string;
  projectName: string;
  url: string;
  createdAt: string;
};

export type ModuleTaskQueueItem = Omit<ModuleRecordTaskLink, 'edgeId' | 'createdAt'> & {
  recordCount: number;
  records: { id: string; collectionKey: string; title: string; url: string }[];
};

export function normalizeModuleTaskQueue(value: unknown): { tasks: ModuleTaskQueueItem[]; nextOffset: number | null } {
  const body = record(value);
  const tasks = (Array.isArray(body.tasks) ? body.tasks : []).flatMap((value): ModuleTaskQueueItem[] => {
    const row = record(value);
    const taskId = text(row, 'task_id'), title = text(row, 'title'), status = text(row, 'status'), priority = text(row, 'priority');
    const projectId = text(row, 'project_id'), projectName = text(row, 'project_name'), url = text(row, 'url');
    if (!taskId || !title || !status || !priority || !projectId || !projectName || !url?.startsWith('/') || url.startsWith('//')) return [];
    const records = (Array.isArray(row.records) ? row.records : []).flatMap((value) => {
      const reference = record(value);
      const id = text(reference, 'id'), title = text(reference, 'title'), collectionKey = text(reference, 'collection_key'), url = text(reference, 'url');
      return id && title && collectionKey && url?.startsWith('/') && !url.startsWith('//') ? [{ id, title, collectionKey, url }] : [];
    });
    return [{ taskId, title, status, priority, projectId, projectName, url, records, recordCount: typeof row.record_count === 'number' && Number.isSafeInteger(row.record_count) && row.record_count >= records.length ? row.record_count : records.length,
      identifier: text(row, 'identifier'), dueDate: text(row, 'due_date'), assigneeId: text(row, 'assignee_id'), assigneeName: text(row, 'assignee_name') }];
  });
  return { tasks, nextOffset: typeof body.next_offset === 'number' && Number.isSafeInteger(body.next_offset) && body.next_offset > 0 ? body.next_offset : null };
}

export function moduleTaskCalendarDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(row: UnknownRecord, key: string): string | null {
  return typeof row[key] === 'string' ? row[key] as string : null;
}

function nextOffset(body: UnknownRecord): number | null {
  if (!Object.hasOwn(body, 'next_offset')) throw new Error('Invalid linked-resource page.');
  if (body.next_offset == null) return null;
  if (typeof body.next_offset !== 'number' || !Number.isSafeInteger(body.next_offset) || body.next_offset <= 0) {
    throw new Error('Invalid linked-resource page.');
  }
  return body.next_offset;
}

export type ModuleTaskLinkPage<T> = { links: T[]; nextOffset: number | null };

export function normalizeTaskModuleRecordLinks(value: unknown): TaskModuleRecordLink[] {
  const body = record(value);
  const rows = Array.isArray(body.links) ? body.links : [];
  return rows.flatMap((value) => {
    const row = record(value);
    const edgeId = text(row, 'edge_id');
    const resourceId = text(row, 'resource_id');
    const recordId = text(row, 'record_id');
    const moduleSlug = text(row, 'module_slug');
    const moduleName = text(row, 'module_name');
    const collectionKey = text(row, 'collection_key');
    const collectionName = text(row, 'collection_name');
    const title = text(row, 'title');
    const url = text(row, 'url');
    const createdAt = text(row, 'created_at');
    if (
      !edgeId || !resourceId || !/^module_record:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(resourceId) || !recordId
      || !moduleSlug || !moduleName || !collectionKey || !collectionName
      || !title || !url?.startsWith('/') || url.startsWith('//') || !createdAt
    ) return [];
    return [{
      edgeId,
      resourceId,
      recordId,
      moduleSlug,
      moduleName,
      collectionKey,
      collectionName,
      title,
      url,
      createdAt,
    }];
  });
}

export function normalizeTaskModuleRecordLinkPage(value: unknown): ModuleTaskLinkPage<TaskModuleRecordLink> {
  const body = record(value);
  if (!Array.isArray(body.links)) throw new Error('Invalid linked-resource page.');
  const links = normalizeTaskModuleRecordLinks(body);
  if (links.length !== body.links.length) throw new Error('Invalid linked-resource page.');
  return { links, nextOffset: nextOffset(body) };
}

export function normalizeModuleRecordTaskLinks(value: unknown): ModuleRecordTaskLink[] {
  const body = record(value);
  const rows = Array.isArray(body.links) ? body.links : [];
  return rows.flatMap((value) => {
    const row = record(value);
    const edgeId = text(row, 'edge_id');
    const taskId = text(row, 'task_id');
    const title = text(row, 'title');
    const identifier = row.identifier === null ? null : text(row, 'identifier');
    const status = text(row, 'status');
    const priority = text(row, 'priority');
    const projectId = text(row, 'project_id');
    const projectName = text(row, 'project_name');
    const url = text(row, 'url');
    const createdAt = text(row, 'created_at');
    if (
      !edgeId || !taskId || !title || !status || !priority || !projectId
      || !projectName || !url?.startsWith('/') || url.startsWith('//') || !createdAt
    ) return [];
    return [{
      edgeId,
      taskId,
      title,
      identifier,
      status,
      priority,
      dueDate: text(row, 'due_date'),
      assigneeId: text(row, 'assignee_id'),
      assigneeName: text(row, 'assignee_name'),
      projectId,
      projectName,
      url,
      createdAt,
    }];
  });
}

export function normalizeModuleRecordTaskLinkPage(value: unknown): ModuleTaskLinkPage<ModuleRecordTaskLink> {
  const body = record(value);
  if (!Array.isArray(body.links)) throw new Error('Invalid linked-resource page.');
  const links = normalizeModuleRecordTaskLinks(body);
  if (links.length !== body.links.length) throw new Error('Invalid linked-resource page.');
  return { links, nextOffset: nextOffset(body) };
}

export type ModuleNextTaskResult =
  | { state: 'available'; task: ModuleRecordTaskLink | null }
  | { state: 'unavailable' }
  | { state: 'error' };

export function normalizeModuleRecordNextTasks(value: unknown, requestedIds: string[]): Record<string, ModuleNextTaskResult> {
  const body = record(value);
  if (!Array.isArray(body.record_ids) || !Array.isArray(body.links)) throw new Error('Invalid next-task response.');
  const requested = new Set(requestedIds);
  const live = new Set<string>();
  for (const id of body.record_ids) {
    if (typeof id !== 'string' || !requested.has(id) || live.has(id)) throw new Error('Invalid next-task records.');
    live.add(id);
  }
  const tasks = new Map<string, ModuleRecordTaskLink>();
  for (const value of body.links) {
    const row = record(value);
    const id = text(row, 'record_id');
    const task = normalizeModuleRecordTaskLinks({ links: [row] })[0];
    if (!id || !live.has(id) || tasks.has(id) || !task || isModuleTaskClosed(task.status)) throw new Error('Invalid next task.');
    tasks.set(id, task);
  }
  return Object.fromEntries(requestedIds.map((id) => [id, live.has(id)
    ? { state: 'available', task: tasks.get(id) ?? null }
    : { state: 'unavailable' }]));
}
