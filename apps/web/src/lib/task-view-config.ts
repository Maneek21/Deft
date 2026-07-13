export const TASK_VIEW_CONFIG_VERSION = 1 as const;

export const TASK_SURFACE_VIEWS = ['board', 'table', 'timeline', 'calendar', 'pipeline'] as const;
export type TaskSurfaceView = (typeof TASK_SURFACE_VIEWS)[number];

export const TASK_CONFIG_VIEWS = ['board', 'table', 'timeline', 'calendar', 'pipeline'] as const;
export type TaskConfigView = (typeof TASK_CONFIG_VIEWS)[number];

export type TaskViewFiltersV1 = {
  assigneeIds: string[];
  priorities: string[];
  status: string[];
  labels: string[];
  dueDate: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  projectId: string | null;
};

export type TaskViewSortClauseV1 = {
  field: string;
  direction: 'asc' | 'desc';
  nulls: 'first' | 'last';
};

export type TaskViewGroupV1 = {
  field: string;
  direction: 'asc' | 'desc';
} | null;

export type TaskViewColumnV1 = {
  id: string;
  visible: boolean;
  position: number;
  width?: number;
  frozen?: boolean;
};

export type TaskViewConfigV1 = {
  version: typeof TASK_VIEW_CONFIG_VERSION;
  view: TaskConfigView;
  filters: TaskViewFiltersV1;
  sort: TaskViewSortClauseV1[];
  groupBy: TaskViewGroupV1;
  columns: TaskViewColumnV1[];
  density: 'compact' | 'comfortable';
  showSubtasks: boolean;
  projectId: string | null;
};

export const EMPTY_TASK_VIEW_FILTERS: TaskViewFiltersV1 = {
  assigneeIds: [],
  priorities: [],
  status: [],
  labels: [],
  dueDate: null,
  dateFrom: null,
  dateTo: null,
  projectId: null,
};

export const DEFAULT_TASK_VIEW_CONFIG: TaskViewConfigV1 = {
  version: TASK_VIEW_CONFIG_VERSION,
  view: 'board',
  filters: EMPTY_TASK_VIEW_FILTERS,
  sort: [],
  groupBy: null,
  columns: [],
  density: 'comfortable',
  showSubtasks: false,
  projectId: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeFilters(value: unknown): TaskViewFiltersV1 {
  const filters = isRecord(value) ? value : {};
  return {
    assigneeIds: stringArray(filters.assigneeIds),
    priorities: stringArray(filters.priorities),
    status: stringArray(filters.status),
    labels: stringArray(filters.labels),
    dueDate: nullableString(filters.dueDate),
    dateFrom: nullableString(filters.dateFrom),
    dateTo: nullableString(filters.dateTo),
    projectId: nullableString(filters.projectId),
  };
}

function normalizeConfigView(value: unknown): TaskConfigView {
  if (value === 'list') return 'table';
  return typeof value === 'string' && (TASK_CONFIG_VIEWS as readonly string[]).includes(value)
    ? value as TaskConfigView
    : 'board';
}

/**
 * Normalizes both versioned task-view configs and the legacy saved-view shape,
 * where the entire payload was only a Filters object.
 */
export function normalizeTaskViewConfig(value: unknown): TaskViewConfigV1 {
  const input = isRecord(value) ? value : {};
  const isVersioned = input.version === TASK_VIEW_CONFIG_VERSION;
  const rawFilters = isVersioned ? input.filters : input;

  const sort = Array.isArray(input.sort)
    ? input.sort.slice(0, 3).flatMap((item) => {
        if (!isRecord(item) || typeof item.field !== 'string') return [];
        return [{
          field: item.field,
          direction: item.direction === 'desc' ? 'desc' as const : 'asc' as const,
          nulls: item.nulls === 'first' ? 'first' as const : 'last' as const,
        }];
      })
    : [];

  const rawGroup = isRecord(input.groupBy) && typeof input.groupBy.field === 'string'
    ? {
        field: input.groupBy.field,
        direction: input.groupBy.direction === 'desc' ? 'desc' as const : 'asc' as const,
      }
    : null;

  const columns = Array.isArray(input.columns)
    ? input.columns.flatMap((item, index) => {
        if (!isRecord(item) || typeof item.id !== 'string') return [];
        const width = typeof item.width === 'number' && Number.isFinite(item.width)
          ? Math.max(64, Math.min(800, item.width))
          : undefined;
        return [{
          id: item.id,
          visible: item.visible !== false,
          position: typeof item.position === 'number' ? item.position : index,
          ...(width === undefined ? {} : { width }),
          ...(typeof item.frozen === 'boolean' ? { frozen: item.frozen } : {}),
        }];
      })
    : [];

  return {
    version: TASK_VIEW_CONFIG_VERSION,
    view: normalizeConfigView(input.view),
    filters: normalizeFilters(rawFilters),
    sort,
    groupBy: rawGroup,
    columns,
    density: input.density === 'compact' ? 'compact' : 'comfortable',
    showSubtasks: input.showSubtasks === true,
    projectId: nullableString(input.projectId),
  };
}

export function parseTaskSurfaceView(value: string | null): TaskSurfaceView | null {
  if (value === 'list') return 'table';
  return value && (TASK_SURFACE_VIEWS as readonly string[]).includes(value)
    ? value as TaskSurfaceView
    : null;
}

export function shouldApplyProjectDefaultView(params: {
  requestedView: string | null;
  userSelectedView: boolean;
  isMyTasksView: boolean;
}): boolean {
  return params.requestedView === null && !params.userSelectedView && !params.isMyTasksView;
}
