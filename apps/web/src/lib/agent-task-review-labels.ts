type RecordValue = Record<string, unknown>;
export type TaskReviewTarget = { kind: 'members' | 'projects'; id: string };
export type TaskReviewLabels = { key: string; names: Record<string, string> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const id = (params: RecordValue, field: string) => text(params[field]) || text(object(params.patch)[field]);

export function taskReviewTargets(params: RecordValue): TaskReviewTarget[] {
  const targets: TaskReviewTarget[] = [];
  const add = (kind: TaskReviewTarget['kind'], value: string) => {
    if (UUID.test(value) && !targets.some(target => target.kind === kind && target.id === value)) targets.push({ kind, id: value });
  };
  add('members', id(params, 'assignee_id'));
  add('projects', id(params, 'project_id'));
  for (const subtask of Array.isArray(params.subtasks) ? params.subtasks : []) add('members', id(object(subtask), 'assignee_id'));
  // Presentation lookups are bounded; remaining targets still show their exact IDs.
  return targets.slice(0, 32);
}

export function taskReviewTargetLabel(kind: TaskReviewTarget['kind'], targetId: string, labels?: TaskReviewLabels | null) {
  const name = labels?.names[`${kind}:${targetId}`];
  return name ? `${name} (ID: ${targetId})` : `ID: ${targetId}`;
}

export function taskReviewAssignmentLines(params: RecordValue, labels?: TaskReviewLabels | null) {
  return ([['Assignee', 'members', 'assignee_id'], ['Project', 'projects', 'project_id']] as const)
    .flatMap(([label, kind, field]) => {
      const targetId = id(params, field);
      return targetId ? [`${label}: ${taskReviewTargetLabel(kind, targetId, labels)}`] : [];
    }).join('\n');
}

/** Display-only copy. Never pass this to approval or persist it as action params. */
export function taskReviewDisplayParams(params: RecordValue, labels?: TaskReviewLabels | null): RecordValue {
  const display: RecordValue & { patch: RecordValue } = { ...params, patch: { ...object(params.patch) } };
  const assigneeId = id(params, 'assignee_id'), projectId = id(params, 'project_id');
  if (assigneeId) {
    delete display.assignee;
    delete display.patch.assignee_name;
    display.assignee_name = labels?.names[`members:${assigneeId}`];
  }
  if (projectId) {
    delete display.project;
    delete display.project_title;
    display.project_name = labels?.names[`projects:${projectId}`];
  }
  return display;
}

export function loadTaskReviewLabels(options: {
  key: string;
  targets: TaskReviewTarget[];
  current: () => boolean;
  request: (path: string, options: { signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  publish: (labels: TaskReviewLabels) => void;
}) {
  const controller = new AbortController();
  const current = () => !controller.signal.aborted && options.current();
  const finished = (async () => {
    const names: Record<string, string> = {};
    const targets = options.targets.filter((target, index, all) => UUID.test(target.id)
      && all.findIndex(other => other.kind === target.kind && other.id === target.id) === index).slice(0, 32);
    await Promise.all(targets.map(async target => {
      try {
        if (!current()) return;
        const response = await options.request(`/api/${target.kind}/${encodeURIComponent(target.id)}`, { signal: controller.signal });
        if (!current() || !response.ok) return;
        const value = object(await response.json());
        if (!current() || value.id !== target.id || value.is_deleted === true || value.is_active === false) return;
        const name = text(value.name);
        if (name) names[`${target.kind}:${target.id}`] = name;
      } catch { /* Names are optional display metadata; canonical targets stay reviewable. */ }
    }));
    if (current()) options.publish({ key: options.key, names });
  })();
  return { finished, dispose: () => controller.abort() };
}
