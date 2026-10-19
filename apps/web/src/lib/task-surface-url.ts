import type { Filters } from '../components/task-filters';
import { parseTaskSurfaceView } from './task-view-config';

type Search = Pick<URLSearchParams, 'get' | 'toString'>;

export function taskSurfaceHref(search: Search, patch: Record<string, string | null>, resolvedProjectId?: string | null) {
  const params = new URLSearchParams(search.toString());
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  if (!params.has('project') && params.get('view') !== 'my' && resolvedProjectId
    && !Object.prototype.hasOwnProperty.call(patch, 'project')) params.set('project', resolvedProjectId);
  return `/tasks${params.size ? `?${params}` : ''}`;
}

export function taskProjectHref(search: Search, projectId: string) {
  return taskSurfaceHref(search, {
    project: projectId, view: parseTaskSurfaceView(search.get('view')),
    task: null, module_return: null,
    ...(search.get('filterProject') !== projectId ? { filterProject: null } : {}),
  });
}

export function taskFiltersFromSearch(search: Search): Filters {
  const list = (key: string) => search.get(key)?.split(',').filter(Boolean) ?? [];
  const due = search.get('dueDate');
  return { assigneeIds: list('assignee'), priorities: list('priority'), status: list('status'), labels: list('labels'),
    dueDate: due === 'overdue' || due === 'today' || due === 'this_week' ? due : null,
    dateFrom: search.get('dateFrom'), dateTo: search.get('dateTo'), projectId: search.get('filterProject') };
}

export function isCurrentTaskRoute(requested: string, current: string) {
  return requested === current;
}
