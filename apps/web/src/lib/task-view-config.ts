export const TASK_VIEW_CONFIG_VERSION = 1 as const;

export const TASK_SURFACE_VIEWS = ['board', 'table', 'timeline', 'calendar'] as const;
export type TaskSurfaceView = (typeof TASK_SURFACE_VIEWS)[number];

export const TASK_CONFIG_VIEWS = ['board', 'table', 'timeline', 'calendar'] as const;
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

export const TASK_TABLE_COLUMNS = [
  { id: 'number', label: 'ID', width: '80px', required: true },
  { id: 'title', label: 'Title', width: '1fr', required: true },
  { id: 'status', label: 'Status', width: '130px' },
  { id: 'priority', label: 'Priority', width: '80px' },
  { id: 'assignee', label: 'Assignee', width: '140px' },
  { id: 'start_date', label: 'Start', width: '120px' },
  { id: 'due_date', label: 'Due', width: '110px' },
  { id: 'estimation', label: 'Estimate', width: '90px' },
  { id: 'labels', label: 'Labels', width: '180px' },
  { id: 'updated_at', label: 'Updated', width: '110px' },
] as const;

export type TaskTableColumnId = (typeof TASK_TABLE_COLUMNS)[number]['id'];

export function taskTableColumnConfig(config: TaskViewConfigV1, id: TaskTableColumnId) {
  const fallback = TASK_TABLE_COLUMNS.findIndex((column) => column.id === id);
  const saved = config.columns.find((column) => column.id === id);
  return {
    visible: saved?.visible !== false,
    position: saved?.position ?? fallback,
    width: saved?.width,
  };
}

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

export function isTaskTableColumnVisible(config: TaskViewConfigV1, id: TaskTableColumnId): boolean {
  return taskTableColumnConfig(config, id).visible;
}

export function setTaskTableColumnVisibility(
  config: TaskViewConfigV1,
  id: TaskTableColumnId,
  visible: boolean,
): TaskViewConfigV1 {
  const existing = config.columns.some((column) => column.id === id);
  const columns = existing
    ? config.columns.map((column) => column.id === id ? { ...column, visible } : column)
    : [...config.columns, { id, visible, position: TASK_TABLE_COLUMNS.findIndex((column) => column.id === id) }];
  return { ...config, columns };
}

export function setTaskTableColumnWidth(
  config: TaskViewConfigV1,
  id: TaskTableColumnId,
  width: number,
): TaskViewConfigV1 {
  const bounded = Math.max(64, Math.min(800, width));
  const existing = config.columns.some((column) => column.id === id);
  const columns = existing
    ? config.columns.map((column) => column.id === id ? { ...column, width: bounded } : column)
    : [...config.columns, { id, visible: true, position: TASK_TABLE_COLUMNS.findIndex((column) => column.id === id), width: bounded }];
  return { ...config, columns };
}

export function moveTaskTableColumn(
  config: TaskViewConfigV1,
  id: TaskTableColumnId,
  direction: -1 | 1,
): TaskViewConfigV1 {
  if (id === 'number' || id === 'title') return config;
  const ordered = TASK_TABLE_COLUMNS.map((column) => ({
    id: column.id,
    position: taskTableColumnConfig(config, column.id).position,
  })).sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((column) => column.id === id);
  const target = index + direction;
  if (index < 0 || target < 2 || target >= ordered.length) return config;
  [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
  const positions = new Map(ordered.map((column, position) => [column.id, position]));
  return {
    ...config,
    columns: TASK_TABLE_COLUMNS.map((column) => {
      const current = config.columns.find((candidate) => candidate.id === column.id);
      return { id: column.id, visible: current?.visible !== false, position: positions.get(column.id)!, ...(current?.width ? { width: current.width } : {}) };
    }),
  };
}

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
  const dueDate = filters.dueDate === 'overdue' || filters.dueDate === 'today' || filters.dueDate === 'this_week'
    ? filters.dueDate
    : null;
  return {
    assigneeIds: stringArray(filters.assigneeIds),
    priorities: stringArray(filters.priorities),
    status: stringArray(filters.status),
    labels: stringArray(filters.labels),
    dueDate,
    dateFrom: nullableString(filters.dateFrom),
    dateTo: nullableString(filters.dateTo),
    projectId: nullableString(filters.projectId),
  };
}

function normalizeConfigView(value: unknown): TaskConfigView {
  if (value === 'list') return 'table';
  if (value === 'pipeline') return 'board';
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
  if (value === 'pipeline') return 'board';
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
