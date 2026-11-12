/**
 * Org-room task events.
 *
 * Every member of an org joins `org:<orgId>`, but a task may be restricted to
 * the people related to it (see `visibleTaskCondition`). Events sent to the
 * org room therefore carry only identifiers and the kind of change: the task
 * id(s), the project id (projects are visible to every member) and the names
 * of the fields that changed. Clients fetch task content through the
 * audience-checked task reads, which answer 404 to a member who cannot read
 * the task.
 */
export const ORG_TASK_EVENTS = [
  'task:created',
  'task:updated',
  'task:deleted',
  'task:bulk_updated',
  'task:reaction_changed',
] as const;

export type OrgTaskEvent = (typeof ORG_TASK_EVENTS)[number];

const ORG_TASK_EVENT_SET: ReadonlySet<string> = new Set(ORG_TASK_EVENTS);

export function isOrgTaskEvent(event: unknown): event is OrgTaskEvent {
  return typeof event === 'string' && ORG_TASK_EVENT_SET.has(event);
}

export type OrgTaskEventPayload = {
  id?: string;
  task_id?: string;
  task_ids?: string[];
  project_id?: string;
  changed_fields?: string[];
};

const ID_KEYS = new Set(['id', 'task_id', 'task_ids', 'project_id']);
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reduce any task event payload to the identifier-only shape. Values are
 * never copied except ids; field names are kept only when they look like
 * plain field identifiers. Unknown input produces an empty object.
 */
export function orgTaskEventPayload(event: OrgTaskEvent, payload: unknown): OrgTaskEventPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const source = payload as Record<string, unknown>;
  const out: OrgTaskEventPayload = {};
  const id = stringOrUndefined(source.id);
  const taskId = stringOrUndefined(source.task_id);
  const projectId = stringOrUndefined(source.project_id);
  if (id) out.id = id;
  if (taskId) out.task_id = taskId;
  if (Array.isArray(source.task_ids)) {
    out.task_ids = source.task_ids.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  if (projectId) out.project_id = projectId;

  if (event === 'task:updated' || event === 'task:bulk_updated') {
    const changedSource = event === 'task:bulk_updated'
      ? (source.changes && typeof source.changes === 'object' && !Array.isArray(source.changes)
        ? Object.keys(source.changes as Record<string, unknown>)
        : Array.isArray(source.changed_fields) ? source.changed_fields : [])
      : Array.isArray(source.changed_fields)
        ? source.changed_fields
        : Object.keys(source).filter((key) => !ID_KEYS.has(key));
    const changed = [...new Set(changedSource.filter((key): key is string => typeof key === 'string' && FIELD_NAME.test(key)))]
      .filter((key) => key !== 'changed_fields' && key !== 'changes');
    if (changed.length > 0) out.changed_fields = changed;
  }
  return out;
}
