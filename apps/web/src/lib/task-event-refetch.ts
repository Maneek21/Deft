/**
 * Task events from the org room carry identifiers only (task id, project id,
 * names of changed fields). Lists never apply them as task data: they decide
 * whether the event can concern the current list and, if so, reload it
 * through the audience-checked list endpoint. Reloads are coalesced so a bulk
 * change or a burst of agent writes causes one request, not one per task.
 */

export type TaskEventPayload = {
  id?: unknown;
  task_id?: unknown;
  task_ids?: unknown;
  project_id?: unknown;
};

export type TaskListScope = {
  /** Project the list shows, or null when the list is not a single project. */
  projectId: string | null;
  /** True when membership in the list depends on fields the event does not carry (My Work, table filters). */
  dependsOnTaskFields: boolean;
  /** Ids currently shown. */
  shownIds: ReadonlySet<string>;
};

export function taskEventIds(payload: TaskEventPayload | null | undefined): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const ids: string[] = [];
  if (typeof payload.id === 'string') ids.push(payload.id);
  if (typeof payload.task_id === 'string') ids.push(payload.task_id);
  if (Array.isArray(payload.task_ids)) {
    for (const value of payload.task_ids) if (typeof value === 'string') ids.push(value);
  }
  return ids;
}

/** Whether a task event may change what the list shows. Unknown shapes answer true. */
export function taskEventConcernsList(payload: TaskEventPayload | null | undefined, scope: TaskListScope): boolean {
  const ids = taskEventIds(payload);
  if (ids.some((id) => scope.shownIds.has(id))) return true;
  if (scope.dependsOnTaskFields) return true;
  if (scope.projectId === null) return false;
  const projectId = payload && typeof payload.project_id === 'string' ? payload.project_id : null;
  return projectId === null || projectId === scope.projectId;
}

/**
 * Trailing-edge coalescer: `run` fires once, `delayMs` after the last
 * `schedule()` of a burst. A burst that never pauses still runs every
 * `maxWaitMs`, so a steady stream of events cannot postpone it for ever.
 */
export function createCoalescedRefetch(run: () => void, delayMs = 250, maxWaitMs = 2000) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let burstStartedAt = 0;
  return {
    schedule() {
      const now = Date.now();
      if (timer !== null) {
        if (now - burstStartedAt >= maxWaitMs) return;
        clearTimeout(timer);
      } else {
        burstStartedAt = now;
      }
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
