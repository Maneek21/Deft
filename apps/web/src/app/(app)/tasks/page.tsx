'use client';

import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useSearchParams, useRouter } from 'next/navigation';
import { TaskBoard } from '@/components/task-board';
import { TaskTable } from '@/components/task-list';
import { TaskDetail } from '@/components/task-detail';
import { TaskFilters, type Filters } from '@/components/task-filters';
import { TaskQuickCreate } from '@/components/task-quick-create';
import { registerOpenTaskQuickCreate } from '@/lib/quick-actions';
import { TaskCalendarView } from '@/components/task-calendar-view';
import { TaskPipelineView } from '@/components/task-pipeline-view';
import { statusLabel } from '@/lib/task-status-labels';
import { useProjectResolvedConfig } from '@/hooks/use-project-resolved-config';
import {
  ChevronDown,
  LayoutGrid,
  List,
  Plus,
  Loader2,
  FolderKanban,
  CheckSquare,
  User,
  MousePointerSquareDashed,
  X,
  Trash2,
  GanttChartSquare,
  CalendarDays,
  GitBranch,
  FileText,
} from 'lucide-react';
import { TabStrip } from '@/components/tab-strip';
import { AppMenu } from '@/components/overlay-primitives';

const TaskTimeline = lazy(() => import('./timeline'));
import { EmptyState } from '@/components/empty-state';
import { CreateProjectModal } from '@/components/create-project-modal';
import { PersonAvatar } from '@/components/person-avatar';
import {
  DEFAULT_TASK_VIEW_CONFIG,
  normalizeTaskViewConfig,
  parseTaskSurfaceView,
  shouldApplyProjectDefaultView,
  type TaskSurfaceView,
  type TaskViewConfigV1,
} from '@/lib/task-view-config';

type Task = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  // Wide string — resolved skill configs define arbitrary status IDs
  // (e.g. 'lead' / 'qualified' for Sales).
  status: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  created_by: string;
  creator_name: string | null;
  due_date: string | null;
  start_date: string | null;
  sort_order: number;
  source_message_id: string | null;
  is_deleted: boolean;
  project_id: string;
  project_prefix: string;
  project_name: string;
  project_color: string | null;
  labels: { id: string; name: string; color: string }[];
  parent_task_id: string | null;
  subtask_count: number;
  subtask_done_count: number;
  estimation?: string | null;
  created_at: string;
  updated_at: string;
};

type Project = {
  id: string;
  name: string;
  prefix: string;
  color: string | null;
  task_counter: number;
  total_tasks: number;
  done_tasks: number;
};

type TaskPatch = Partial<Pick<Task, 'title' | 'status' | 'priority' | 'assignee_id' | 'due_date' | 'start_date' | 'estimation'>> & {
  label_ids?: string[];
};

const STATUS_OPTIONS = [
  { value: 'backlog', label: statusLabel('backlog') },
  { value: 'todo', label: statusLabel('todo') },
  { value: 'in_progress', label: statusLabel('in_progress') },
  { value: 'in_review', label: statusLabel('in_review') },
  { value: 'done', label: statusLabel('done') },
];

const PRIORITY_OPTIONS = [
  { value: 'p0', label: 'P0 — Urgent' },
  { value: 'p1', label: 'P1 — High' },
  { value: 'p2', label: 'P2 — Medium' },
  { value: 'p3', label: 'P3 — Low' },
];

export default function TasksPage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // Fix 1: derive view from URL (falls back to 'board')
  type View = TaskSurfaceView;
  const requestedView = searchParams.get('view');
  const view: View = parseTaskSurfaceView(requestedView) ?? 'board';

  // Task 4.9 — once the user toggles the view manually, we stop auto-selecting
  // the resolved-config default so their preference wins.
  const [userSelectedView, setUserSelectedView] = useState(false);

  // Fix 1: helper to patch URL query params
  const setQuery = useCallback((patch: Record<string, string | null>) => {
    const qs = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) qs.delete(k);
      else qs.set(k, v);
    }
    const str = qs.toString();
    router.replace(`/tasks${str ? '?' + str : ''}`);
  }, [searchParams, router]);

  useEffect(() => {
    if (requestedView === 'list') setQuery({ view: 'table' });
  }, [requestedView, setQuery]);

  // Fix 1: initialize filters from URL params on mount
  const [filters, setFilters] = useState<Filters>(() => {
    return {
      assigneeIds: searchParams.get('assignee') ? searchParams.get('assignee')!.split(',') : [],
      priorities: searchParams.get('priority') ? searchParams.get('priority')!.split(',') : [],
      status: searchParams.get('status') ? searchParams.get('status')!.split(',') : [],
      labels: searchParams.get('labels') ? searchParams.get('labels')!.split(',') : [],
      dueDate: (searchParams.get('dueDate') as Filters['dueDate']) || null,
      dateFrom: searchParams.get('dateFrom') || null,
      dateTo: searchParams.get('dateTo') || null,
      projectId: searchParams.get('filterProject') || null,
    };
  });
  const [layoutConfig, setLayoutConfig] = useState<TaskViewConfigV1>(() => ({
    ...DEFAULT_TASK_VIEW_CONFIG,
    view: 'table',
  }));
  const [loading, setLoading] = useState(true);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [templatesDropdownOpen, setTemplatesDropdownOpen] = useState(false);
  const [quickCreateStatus, setQuickCreateStatus] = useState<string | undefined>(undefined);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [bulkActionDropdown, setBulkActionDropdown] = useState<string | null>(null);
  const [orgMembers, setOrgMembers] = useState<{ id: string; name: string; avatar_url: string | null }[]>([]);
  const [orgLabels, setOrgLabels] = useState<{ id: string; name: string; color: string }[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [velocity, setVelocity] = useState<{ average: number } | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [tablePage, setTablePage] = useState({
    serverBacked: false,
    total: 0,
    cursor: null as string | null,
    nextCursor: null as string | null,
    previousCursors: [] as Array<string | null>,
    loading: false,
  });
  const viewMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const viewOptions = useMemo(() => [
    { value: 'board' as View, label: 'Board', icon: <LayoutGrid size={14} /> },
    { value: 'table' as View, label: 'Table', icon: <List size={14} /> },
    { value: 'timeline' as View, label: 'Timeline', icon: <GanttChartSquare size={14} /> },
    { value: 'calendar' as View, label: 'Calendar', icon: <CalendarDays size={14} /> },
    { value: 'pipeline' as View, label: 'Pipeline', icon: <GitBranch size={14} /> },
  ], []);

  const activeViewOption = viewOptions.find((option) => option.value === view) ?? viewOptions[0]!;
  const mobileViewOptions = viewOptions.filter((option) => option.value !== 'calendar');

  // Mobile-spillover P2-2: calendar cells (~55px wide) can't fit task content
  // on mobile. Auto-redirect to list view when width < 768 and calendar is active.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.innerWidth < 768 && view === 'calendar') {
      setQuery({ view: 'table' });
    }
  }, [view]);

  const currentProjectId = searchParams.get('project');
  const isMyTasksView = searchParams.get('view') === 'my';

  // Task 4.9 — resolved skill config drives status/vocab/view/prefix
  const { config: resolvedConfig } = useProjectResolvedConfig(selectedProject?.id ?? null);

  // Auto-select the project's default view once when the config loads, unless
  // the user has already picked a view. "timeline" is kept engineering-only
  // (not a valid skill default today but guarded anyway).
  useEffect(() => {
    if (!resolvedConfig || !shouldApplyProjectDefaultView({ requestedView, userSelectedView, isMyTasksView })) return;
    const dv = resolvedConfig.default_view;
    if (dv && dv !== view && (dv === 'board' || dv === 'list' || dv === 'timeline' || dv === 'calendar' || dv === 'pipeline')) {
      setQuery({ view: dv === 'list' ? 'table' : dv });
    }
  }, [resolvedConfig, requestedView, userSelectedView, isMyTasksView, view, setQuery]);

  // Load projects
  useEffect(() => {
    if (!user) return;
    async function loadProjects() {
      const res = await api.get('/api/projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data);
        // If a project ID is in the URL, select it
        if (currentProjectId) {
          const urlProject = data.find((p: Project) => p.id === currentProjectId);
          if (urlProject) {
            setSelectedProject(urlProject);
          } else if (data.length > 0) {
            setSelectedProject(data[0]);
          }
        } else if (!isMyTasksView && data.length > 0 && !selectedProject) {
          // Default: select first project if no view param
          setSelectedProject(data[0]);
        }
      }
      setLoading(false);
    }
    loadProjects();
  }, [user]);

  // Sync selectedProject when URL changes
  useEffect(() => {
    if (currentProjectId && projects.length > 0) {
      const urlProject = projects.find((p) => p.id === currentProjectId);
      if (urlProject && urlProject.id !== selectedProject?.id) {
        setSelectedProject(urlProject);
        setSelectedTask(null);
      }
    }
  }, [currentProjectId, projects]);

  // Load tasks when project changes (or for My Tasks view)
  const loadTasks = useCallback(async (cursor: string | null = null) => {
    if (view === 'table') {
      const params = new URLSearchParams();
      if (isMyTasksView) params.set('mine', 'true');
      const projectId = isMyTasksView ? filters.projectId : selectedProject?.id;
      if (projectId) params.set('project_id', projectId);
      if (filters.assigneeIds.length) params.set('assignee', filters.assigneeIds.join(','));
      if (filters.priorities.length) params.set('priority', filters.priorities.join(','));
      if (filters.status.length) params.set('status', filters.status.join(','));
      if (filters.labels.length) params.set('labels', filters.labels.join(','));
      if (filters.dueDate) params.set('due', filters.dueDate);
      if (filters.dateFrom) params.set('date_from', filters.dateFrom);
      if (filters.dateTo) params.set('date_to', filters.dateTo);
      if (layoutConfig.sort.length) {
        params.set('sort', layoutConfig.sort.slice(0, 3).map((sort) => `${sort.field}:${sort.direction}:${sort.nulls}`).join(','));
      }
      if (layoutConfig.groupBy) params.set('group', `${layoutConfig.groupBy.field}:${layoutConfig.groupBy.direction}`);
      if (cursor) params.set('cursor', cursor);
      params.set('page_size', isMobile ? '50' : '200');

      setTablePage((current) => ({ ...current, loading: true }));
      const tableResponse = await api.get(`/api/tasks/table?${params}`);
      if (tableResponse.ok) {
        const page = await tableResponse.json();
        setTasks(page.data);
        setTablePage((current) => ({
          ...current,
          serverBacked: true,
          total: page.total,
          cursor,
          nextCursor: page.next_cursor,
          previousCursors: cursor === null ? [] : current.previousCursors,
          loading: false,
        }));
        return;
      }
      // Keep the pre-Loop-3 loader as a safe rollback path.
      setTablePage((current) => ({ ...current, serverBacked: false, loading: false }));
    }
    if (isMyTasksView) {
      // Load all tasks assigned to the current user across all projects
      const res = await api.get('/api/tasks/my');
      if (res.ok) {
        const data = await res.json();
        setTasks(data);
      }
      return;
    }
    if (!selectedProject) return;
    const res = await api.get(`/api/projects/${selectedProject.id}/tasks`);
    if (res.ok) {
      const data = await res.json();
      setTasks(data);
    }
  }, [selectedProject, isMyTasksView, view, filters, layoutConfig.sort, layoutConfig.groupBy, isMobile]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // Socket: live updates for task list (task:created / task:updated / task:deleted)
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('deft-access-token') : null;
    if (!token) return;
    const socket = getSocket(token);

    const isInScope = (t: Partial<Task>): boolean => {
      if (isMyTasksView) {
        return !!t.assignee_id && t.assignee_id === user?.id;
      }
      if (selectedProject) {
        return t.project_id === selectedProject.id;
      }
      return false;
    };

    const onCreated = (payload: Task) => {
      if (!isInScope(payload)) return;
      if (view === 'table') {
        void loadTasks(tablePage.cursor);
        return;
      }
      setTasks((prev) => (prev.some((t) => t.id === payload.id) ? prev : [...prev, payload]));
    };

    const onUpdated = (payload: Partial<Task> & { id: string }) => {
      if (view === 'table') {
        void loadTasks(tablePage.cursor);
        return;
      }
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === payload.id);
        if (idx === -1) {
          // Not in list — if it became in-scope, refetch to pick up full shape
          if (isInScope(payload)) {
            loadTasks();
          }
          return prev;
        }
        const next = [...prev];
        next[idx] = { ...next[idx], ...payload } as Task;
        return next;
      });
    };

    const onDeleted = (payload: { id: string }) => {
      if (view === 'table') {
        void loadTasks(tablePage.cursor);
        setSelectedTask((prev) => (prev && prev.id === payload.id ? null : prev));
        return;
      }
      setTasks((prev) => prev.filter((t) => t.id !== payload.id));
      setSelectedTask((prev) => (prev && prev.id === payload.id ? null : prev));
    };

    // Task 5.5 — batched updates from PATCH /bulk. Apply the shared `changes`
    // to every task in scope and refetch if the target list may now have
    // shifted (new in-scope items after bulk assign).
    const onBulkUpdated = (payload: { task_ids: string[]; changes: Partial<Task> }) => {
      if (!payload || !Array.isArray(payload.task_ids)) return;
      if (view === 'table') {
        void loadTasks(tablePage.cursor);
        return;
      }
      const ids = new Set(payload.task_ids);
      setTasks((prev) => {
        let touched = false;
        const next = prev.map((t) => {
          if (!ids.has(t.id)) return t;
          touched = true;
          return { ...t, ...payload.changes } as Task;
        });
        return touched ? next : prev;
      });
      // If the bulk change may have pulled tasks in/out of scope
      // (e.g. reassign to current user on my-tasks view), refresh.
      if (
        (isMyTasksView && 'assignee_id' in payload.changes) ||
        ('status' in payload.changes)
      ) {
        loadTasks();
      }
    };

    socket.on('task:created', onCreated);
    socket.on('task:updated', onUpdated);
    socket.on('task:bulk_updated', onBulkUpdated);
    socket.on('task:deleted', onDeleted);

    return () => {
      socket.off('task:created', onCreated);
      socket.off('task:updated', onUpdated);
      socket.off('task:bulk_updated', onBulkUpdated);
      socket.off('task:deleted', onDeleted);
    };
  }, [selectedProject, isMyTasksView, user?.id, loadTasks, view, tablePage.cursor]);

  // Load org members for assignee dropdown in bulk actions
  useEffect(() => {
    if (!user) return;
    api.get('/api/members').then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        const list = data.members || data || [];
        setOrgMembers(list);
      }
    });
  }, [user]);

  useEffect(() => {
    if (!user) return;
    api.get('/api/tasks/labels').then(async (res) => {
      if (res.ok) setOrgLabels(await res.json());
    });
  }, [user]);

  // Fetch rolling velocity for selected project
  useEffect(() => {
    if (!selectedProject) return;
    api.get(`/api/projects/${selectedProject.id}/velocity`).then(async res => {
      if (res.ok) setVelocity(await res.json());
    }).catch(() => {});
  }, [selectedProject?.id]);

  // Clear selection when leaving selection mode
  useEffect(() => {
    if (!selectionMode) {
      setSelectedTaskIds(new Set());
      setBulkActionDropdown(null);
    }
  }, [selectionMode]);

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const handleToggleSelect = useCallback((taskId: string) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  const handleBulkStatusChange = async (status: string) => {
    const ids = Array.from(selectedTaskIds);
    const res = await api.patch('/api/tasks/bulk', { task_ids: ids, updates: { status } });
    if (res.ok) {
      setSelectedTaskIds(new Set());
      setSelectionMode(false);
      setBulkActionDropdown(null);
      await loadTasks();
      setToast(`${ids.length} task${ids.length !== 1 ? 's' : ''} moved to ${statusLabel(status)}`);
    }
  };

  const handleBulkAssigneeChange = async (assigneeId: string | null) => {
    const ids = Array.from(selectedTaskIds);
    const res = await api.patch('/api/tasks/bulk', { task_ids: ids, updates: { assignee_id: assigneeId } });
    if (res.ok) {
      setSelectedTaskIds(new Set());
      setSelectionMode(false);
      setBulkActionDropdown(null);
      await loadTasks();
      const name = assigneeId ? orgMembers.find((m) => m.id === assigneeId)?.name || 'someone' : 'Unassigned';
      setToast(`${ids.length} task${ids.length !== 1 ? 's' : ''} assigned to ${name}`);
    }
  };

  const handleBulkPriorityChange = async (priority: string) => {
    const ids = Array.from(selectedTaskIds);
    const res = await api.patch('/api/tasks/bulk', { task_ids: ids, updates: { priority } });
    if (res.ok) {
      setSelectedTaskIds(new Set());
      setSelectionMode(false);
      setBulkActionDropdown(null);
      await loadTasks();
      setToast(`${ids.length} task${ids.length !== 1 ? 's' : ''} set to ${priority.toUpperCase()}`);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedTaskIds);
    if (!confirm(`Delete ${ids.length} task${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    const res = await api.post('/api/tasks/bulk-delete', { task_ids: ids });
    if (res.ok) {
      setSelectedTaskIds(new Set());
      setSelectionMode(false);
      setBulkActionDropdown(null);
      await loadTasks();
      setToast(`${ids.length} task${ids.length !== 1 ? 's' : ''} deleted`);
    }
  };

  // External callers (command palette, etc.) can request the quick-create
  // dialog two ways: a module-level callback for in-page calls, and the
  // `?new=1` URL param for cross-page navigation (avoids a mount-time race).
  useEffect(() => {
    return registerOpenTaskQuickCreate(() => {
      setQuickCreateStatus(undefined);
      setQuickCreateOpen(true);
    });
  }, []);
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setQuickCreateStatus(undefined);
      setQuickCreateOpen(true);
      // Strip the param so reloads don't keep re-opening it.
      const params = new URLSearchParams(searchParams.toString());
      params.delete('new');
      router.replace(`/tasks${params.toString() ? `?${params.toString()}` : ''}`);
    }
  }, [searchParams, router]);

  // Keyboard shortcut: 'c' to quick-create
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isEditing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isEditing) return;
        e.preventDefault();
        setQuickCreateStatus(undefined);
        setQuickCreateOpen(true);
      }
      if (e.key === 'Escape') {
        if (isEditing) return;
        // If in selection mode, clear selection first
        if (selectedTaskIds.size > 0) {
          setSelectedTaskIds(new Set());
          return;
        }
        if (selectionMode) {
          setSelectionMode(false);
          return;
        }
        if (selectedTask) {
          setSelectedTask(null);
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedTask, selectionMode, selectedTaskIds]);

  // On mount: if URL has ?task=DEFT-5 or ?task=<task-id>, find and open that task.
  // If the task belongs to a different project, switch to that project first.
  useEffect(() => {
    const taskParam = searchParams.get('task');
    if (taskParam && projects.length > 0) {
      const rawTaskId = taskParam.startsWith('task:') ? taskParam.slice('task:'.length) : taskParam;
      const looksLikeId = /^[0-9a-fA-F-]{20,}$/.test(rawTaskId) && !rawTaskId.includes('--');
      if (looksLikeId) {
        const existing = tasks.find(t => t.id === rawTaskId);
        if (existing) {
          if (existing.project_id !== selectedProject?.id) {
            const targetProject = projects.find(p => p.id === existing.project_id);
            if (targetProject) setSelectedProject(targetProject);
          }
          setSelectedTask(existing);
          return;
        }
        api.get(`/api/tasks/${rawTaskId}`).then(async (res) => {
          if (!res.ok) return;
          const detail = await res.json();
          const targetProject = projects.find(p => p.id === detail.project_id);
          if (targetProject && targetProject.id !== selectedProject?.id) {
            setSelectedProject(targetProject);
          }
          setSelectedTask({
            id: detail.id,
            number: detail.number,
            title: detail.title,
            description: detail.description,
            status: detail.status,
            priority: detail.priority,
            assignee_id: detail.assignee_id,
            assignee_name: detail.assignee?.name ?? null,
            assignee_avatar: detail.assignee?.avatar_url ?? null,
            created_by: detail.created_by,
            creator_name: detail.creator?.name ?? null,
            due_date: detail.due_date,
            start_date: detail.start_date,
            sort_order: detail.sort_order ?? 0,
            source_message_id: detail.source_message_id ?? null,
            is_deleted: detail.is_deleted ?? false,
            project_id: detail.project_id,
            project_prefix: detail.project_prefix,
            project_name: detail.project_name,
            project_color: targetProject?.color ?? null,
            labels: detail.labels ?? [],
            parent_task_id: detail.parent_task_id ?? null,
            subtask_count: Array.isArray(detail.subtasks) ? detail.subtasks.length : 0,
            subtask_done_count: Array.isArray(detail.subtasks) ? detail.subtasks.filter((task: Task) => task.status === 'done').length : 0,
            estimation: detail.estimation ?? null,
            created_at: detail.created_at,
            updated_at: detail.updated_at,
          });
        });
        return;
      }
      const [prefix, numStr] = taskParam.split('-');
      const num = parseInt(numStr);
      if (prefix && !isNaN(num)) {
        // Check if we need to switch projects
        const targetProject = projects.find(p => p.prefix === prefix);
        if (targetProject && targetProject.id !== selectedProject?.id) {
          setSelectedProject(targetProject);
          // Tasks will reload via the loadTasks effect after project switch
          // Fetch the specific task directly so we can open it before the full list loads
          api.get(`/api/projects/${targetProject.id}/tasks`).then(async (res) => {
            if (res.ok) {
              const allTasks: Task[] = await res.json();
              setTasks(allTasks);
              const task = allTasks.find(t => t.project_prefix === prefix && t.number === num);
              if (task) setSelectedTask(task);
            }
          });
          return; // Don't try to find in stale tasks list
        }
        // Try to find and open the task in current tasks list
        if (tasks.length > 0) {
          const task = tasks.find(t => t.project_prefix === prefix && t.number === num);
          if (task) setSelectedTask(task);
        }
      }
    }
  }, [tasks, searchParams, projects, selectedProject?.id]);

  // Filter tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (task.is_deleted) return false;
      if (isMyTasksView) {
        // In My Tasks view, only show tasks assigned to the current user
        if (task.assignee_id !== user?.id) return false;
      }
      if (filters.assigneeIds.length > 0 && !filters.assigneeIds.includes(task.assignee_id || '')) return false;
      if (filters.priorities.length > 0 && !filters.priorities.includes(task.priority)) return false;
      if (filters.status.length > 0 && !filters.status.includes(task.status)) return false;
      if (filters.labels.length > 0 && !task.labels.some((l) => filters.labels.includes(l.id))) return false;
      if (filters.projectId && task.project_id !== filters.projectId) return false;
      if (filters.dueDate || filters.dateFrom || filters.dateTo) {
        if (!task.due_date) return false;
        const due = new Date(task.due_date);
        if (filters.dueDate) {
          const now = new Date();
          const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const endOfWeek = new Date(today);
          endOfWeek.setDate(today.getDate() + (7 - today.getDay()));
          if (filters.dueDate === 'overdue' && due >= today) return false;
          if (filters.dueDate === 'today' && (due < today || due >= new Date(today.getTime() + 86400000))) return false;
          if (filters.dueDate === 'this_week' && (due < today || due > endOfWeek)) return false;
        }
        if (filters.dateFrom && due < new Date(filters.dateFrom)) return false;
        if (filters.dateTo && due > new Date(filters.dateTo + 'T23:59:59')) return false;
      }
      return true;
    });
  }, [tasks, filters, user?.id, isMyTasksView]);

  // Group tasks by project (for My Tasks view)
  const groupedByProject = useMemo(() => {
    const map = new Map<string, { name: string; prefix: string; color: string; tasks: Task[] }>();
    filteredTasks.forEach(task => {
      if (!map.has(task.project_id)) {
        map.set(task.project_id, {
          name: task.project_name,
          prefix: task.project_prefix,
          color: task.project_color || '#6B7280',
          tasks: [],
        });
      }
      map.get(task.project_id)!.tasks.push(task);
    });
    return Array.from(map.values());
  }, [filteredTasks]);

  const handleTaskPatch = async (taskId: string, patch: TaskPatch): Promise<boolean> => {
    const previousTask = tasks.find((task) => task.id === taskId);
    if (!previousTask) return false;

    const member = patch.assignee_id !== undefined
      ? orgMembers.find((candidate) => candidate.id === patch.assignee_id)
      : null;
    const optimistic: Task = {
      ...previousTask,
      ...patch,
      ...(patch.assignee_id !== undefined ? {
        assignee_name: member?.name ?? null,
        assignee_avatar: member?.avatar_url ?? null,
      } : {}),
      ...(patch.label_ids ? { labels: orgLabels.filter((label) => patch.label_ids!.includes(label.id)) } : {}),
    };

    setTasks((prev) => prev.map((task) => task.id === taskId ? optimistic : task));
    if (selectedTask?.id === taskId) {
      setSelectedTask(optimistic);
    }
    const res = await api.patch(`/api/tasks/${taskId}`, {
      ...patch,
      expected_updated_at: previousTask.updated_at,
    });

    if (res.ok) {
      const updated = await res.json();
      setTasks((prev) => prev.map((task) => task.id === taskId ? { ...optimistic, ...updated } : task));
      if (selectedTask?.id === taskId) {
        setSelectedTask({ ...optimistic, ...updated });
      }
      return true;
    }

    setTasks((prev) => prev.map((task) => task.id === taskId ? previousTask : task));
    if (selectedTask?.id === taskId) setSelectedTask(previousTask);

    let code = '';
    try {
      const body = await res.json();
      code = typeof body?.code === 'string' ? body.code : '';
    } catch {}

    setToast(code === 'TASK_STALE'
      ? 'This task changed elsewhere. The latest version is being loaded.'
      : 'Update failed. Your previous value was restored.');
    if (code === 'TASK_STALE') await loadTasks();
    return false;
  };

  const handleStatusChange = async (taskId: string, newStatus: string) => {
    await handleTaskPatch(taskId, { status: newStatus });
  };

  const handleReorder = async (taskId: string, newSortOrder: number) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, sort_order: newSortOrder } : t))
    );
    await api.patch(`/api/tasks/${taskId}`, { sort_order: newSortOrder });
  };

  const handleTaskClick = (task: Task) => {
    setSelectedTask(task);
    const params = new URLSearchParams(searchParams.toString());
    params.set('task', task.project_prefix + '-' + task.number);
    router.push('/tasks?' + params.toString(), { scroll: false });
  };

  const handleTaskUpdated = (updatedTask: any) => {
    setTasks((prev) => prev.map((t) => (t.id === updatedTask.id ? updatedTask : t)));
    if (selectedTask?.id === updatedTask.id) {
      setSelectedTask(updatedTask);
    }
  };

  // Fix 1: sync filter changes to URL
  const handleFiltersChange = useCallback((next: Filters) => {
    setFilters(next);
    setQuery({
      assignee: next.assigneeIds.length > 0 ? next.assigneeIds.join(',') : null,
      priority: next.priorities.length > 0 ? next.priorities.join(',') : null,
      status: next.status.length > 0 ? next.status.join(',') : null,
      labels: next.labels.length > 0 ? next.labels.join(',') : null,
      dueDate: next.dueDate || null,
      dateFrom: next.dateFrom || null,
      dateTo: next.dateTo || null,
      filterProject: next.projectId || null,
    });
  }, [setQuery]);

  const currentViewConfig = useMemo<TaskViewConfigV1>(() => ({
    ...layoutConfig,
    view,
    filters,
    projectId: selectedProject?.id ?? null,
  }), [layoutConfig, view, filters, selectedProject?.id]);

  const handleTableNextPage = useCallback(async () => {
    if (!tablePage.nextCursor || tablePage.loading) return;
    const next = tablePage.nextCursor;
    setTablePage((current) => ({
      ...current,
      previousCursors: [...current.previousCursors, current.cursor],
    }));
    await loadTasks(next);
  }, [tablePage.nextCursor, tablePage.loading, loadTasks]);

  const handleTablePreviousPage = useCallback(async () => {
    if (!tablePage.previousCursors.length || tablePage.loading) return;
    const previous = tablePage.previousCursors.at(-1) ?? null;
    setTablePage((current) => ({
      ...current,
      previousCursors: current.previousCursors.slice(0, -1),
    }));
    await loadTasks(previous);
  }, [tablePage.previousCursors, tablePage.loading, loadTasks]);

  const handleApplyViewConfig = useCallback((input: TaskViewConfigV1) => {
    const config = normalizeTaskViewConfig(input);
    setLayoutConfig(config);
    setFilters(config.filters as Filters);
    setUserSelectedView(true);
    setQuery({
      view: config.view,
      project: config.projectId,
      assignee: config.filters.assigneeIds.length ? config.filters.assigneeIds.join(',') : null,
      priority: config.filters.priorities.length ? config.filters.priorities.join(',') : null,
      status: config.filters.status.length ? config.filters.status.join(',') : null,
      labels: config.filters.labels.length ? config.filters.labels.join(',') : null,
      dueDate: config.filters.dueDate,
      dateFrom: config.filters.dateFrom,
      dateTo: config.filters.dateTo,
      filterProject: config.filters.projectId,
    });
  }, [setQuery]);

  const handleTaskCreated = () => {
    loadTasks();
    setQuickCreateOpen(false);
  };

  const handleInlineCreate = async (title: string, defaults: Record<string, unknown>) => {
    if (!selectedProject) return false;
    const res = await api.post(`/api/projects/${selectedProject.id}/tasks`, { title, ...defaults });
    if (!res.ok) return false;
    await loadTasks();
    return true;
  };

  const handleDuplicate = async (taskId: string) => {
    const res = await api.post(`/api/tasks/${taskId}/duplicate`);
    if (res.ok) {
      await loadTasks(); // refresh
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Delete this task? This cannot be undone.')) return;
    const res = await api.delete(`/api/tasks/${taskId}`);
    if (res.ok) {
      setTasks(prev => prev.filter(t => t.id !== taskId));
      if (selectedTask?.id === taskId) setSelectedTask(null);
    }
  };

  const handleColumnAdd = (status: string) => {
    setQuickCreateStatus(status);
    setQuickCreateOpen(true);
  };

  const handleSelectProject = (project: Project) => {
    setSelectedProject(project);
    setProjectDropdownOpen(false);
    setSelectedTask(null);
    // Task 4.9 — re-enable auto-default-view for the new project's skill config.
    setUserSelectedView(false);
    router.push(`/tasks?project=${project.id}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--muted)' }}>
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  }

  if (projects.length === 0 && !isMyTasksView) {
    return (
      <>
        <EmptyState
          icon={<CheckSquare size={20} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />}
          title="Create a project to start tracking work"
          description="Projects organize your tasks into manageable workstreams."
          action={{ label: 'Create project', onClick: () => setCreateProjectOpen(true) }}
        />
        {createProjectOpen && (
          <CreateProjectModal
            onClose={() => setCreateProjectOpen(false)}
            onCreated={() => {
              setCreateProjectOpen(false);
              window.location.reload();
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header bar */}
        <div
          className="flex items-center justify-between px-3 md:px-6 min-h-[52px] flex-shrink-0 gap-2"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2 md:gap-4 flex-shrink-0">
            {isMyTasksView ? (
              /* My Tasks header */
              <div className="flex items-center gap-2 px-3 py-1.5">
                <User size={16} style={{ color: 'var(--accent)' }} />
                <span
                  style={{
                    color: 'var(--foreground)',
                    fontFamily: 'var(--font-heading)',
                    fontSize: '14px',
                    fontWeight: 600,
                  }}
                >
                  My Tasks
                </span>
              </div>
            ) : (
              /* Project selector */
              <div className="relative z-50">
                <button
                  onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
                  className="deft-pill min-h-[33px] min-w-0 max-w-[48vw] justify-start px-3 md:max-w-none"
                  style={{
                    color: 'var(--foreground)',
                    fontFamily: 'var(--font-heading)',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: projectDropdownOpen ? 'var(--accent-subtle)' : 'var(--surface-container-low)',
                    transition: 'background 150ms',
                  }}
                >
                  {selectedProject?.color && (
                    <div
                      className="w-3 h-3 rounded-sm flex-shrink-0"
                      style={{ background: selectedProject.color }}
                    />
                  )}
                  <span className="min-w-0 truncate">{selectedProject?.name || 'Select project'}</span>
                  <ChevronDown size={14} style={{ color: 'var(--muted)' }} />
                </button>
                {!isMobile && velocity && velocity.average > 0 && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full ml-2"
                    style={{ background: 'var(--surface-container-low)', color: 'var(--muted)' }}>
                    ~{velocity.average} {velocity.average === 1 ? 'task' : 'tasks'}/week
                  </span>
                )}
                {projectDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setProjectDropdownOpen(false)} />
                    <div
                      className="absolute top-full left-0 mt-1 w-56 rounded-lg py-1 z-50"
                      style={{
                        background: 'var(--card-bg)',
                        border: '1px solid var(--border)',
                        boxShadow: 'var(--shadow-lg)',
                      }}
                    >
                      {projects.map((project) => (
                        <button
                          key={project.id}
                          onClick={() => handleSelectProject(project)}
                          className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px]"
                          style={{
                            color: selectedProject?.id === project.id ? 'var(--accent)' : 'var(--foreground)',
                            fontFamily: 'var(--font-body)',
                            background: selectedProject?.id === project.id ? 'var(--accent-subtle)' : 'transparent',
                          }}
                          onMouseEnter={(e) => {
                            if (selectedProject?.id !== project.id) {
                              e.currentTarget.style.background = 'var(--hover-tint)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (selectedProject?.id !== project.id) {
                              e.currentTarget.style.background = 'transparent';
                            }
                          }}
                        >
                          {project.color && (
                            <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: project.color }} />
                          )}
                          <span className="truncate">{project.name}</span>
                          <span style={{ color: 'var(--muted)' }} className="ml-auto text-[11px]">
                            {project.prefix}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* View toggle */}
            <div className="md:hidden">
              <button
                ref={viewMenuButtonRef}
                onClick={() => setViewMenuOpen((open) => !open)}
                className="deft-pill min-h-[36px] px-3"
                style={{
                  color: 'var(--foreground-secondary)',
                  fontFamily: 'var(--font-heading)',
                }}
                aria-haspopup="menu"
                aria-expanded={viewMenuOpen}
              >
                {activeViewOption.icon}
                <span>{activeViewOption.label}</span>
                <ChevronDown size={12} style={{ color: 'var(--muted)' }} />
              </button>
              <AppMenu
                open={viewMenuOpen}
                onClose={() => setViewMenuOpen(false)}
                anchorRef={viewMenuButtonRef}
                ariaLabel="Task view"
                items={mobileViewOptions.map((option) => ({
                  label: option.label,
                  icon: option.icon,
                  onSelect: () => {
                    setQuery({ view: option.value });
                    setUserSelectedView(true);
                  },
                }))}
              />
            </div>
            <TabStrip
              className="hidden md:flex items-center"
              style={{}}
            >
              <button
                aria-label="Board view"
                onClick={() => { setQuery({ view: 'board' }); setUserSelectedView(true); }}
                className="deft-pill"
                data-active={view === 'board'}
                style={{
                  background: view === 'board' ? 'var(--accent)' : 'transparent',
                  color: view === 'board' ? 'white' : 'var(--muted)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                <LayoutGrid size={13} />
                <span className="hidden md:inline">Board</span>
              </button>
              <button
                aria-label="Table view"
                onClick={() => { setQuery({ view: 'table' }); setUserSelectedView(true); }}
                className="deft-pill"
                data-active={view === 'table'}
                style={{
                  background: view === 'table' ? 'var(--accent)' : 'transparent',
                  color: view === 'table' ? 'white' : 'var(--muted)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                <List size={13} />
                <span className="hidden md:inline">Table</span>
              </button>
              <button
                aria-label="Timeline view"
                onClick={() => { setQuery({ view: 'timeline' }); setUserSelectedView(true); }}
                className="deft-pill"
                data-active={view === 'timeline'}
                style={{
                  background: view === 'timeline' ? 'var(--accent)' : 'transparent',
                  color: view === 'timeline' ? 'white' : 'var(--muted)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                <GanttChartSquare size={13} />
                <span className="hidden md:inline">Timeline</span>
              </button>
              <button
                aria-label="Calendar view"
                onClick={() => { setQuery({ view: 'calendar' }); setUserSelectedView(true); }}
                className="deft-pill"
                data-active={view === 'calendar'}
                style={{
                  background: view === 'calendar' ? 'var(--accent)' : 'transparent',
                  color: view === 'calendar' ? 'white' : 'var(--muted)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                <CalendarDays size={13} />
                <span className="hidden md:inline">Calendar</span>
              </button>
              <button
                aria-label="Pipeline view"
                onClick={() => { setQuery({ view: 'pipeline' }); setUserSelectedView(true); }}
                className="deft-pill"
                data-active={view === 'pipeline'}
                style={{
                  background: view === 'pipeline' ? 'var(--accent)' : 'transparent',
                  color: view === 'pipeline' ? 'white' : 'var(--muted)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                <GitBranch size={13} />
                <span className="hidden md:inline">Pipeline</span>
              </button>
            </TabStrip>

            {/* Select toggle */}
            {!isMobile && (
              <button
                onClick={() => setSelectionMode(!selectionMode)}
                className="deft-pill"
                data-active={selectionMode}
                style={{
                  background: selectionMode ? 'var(--accent-subtle)' : 'transparent',
                  color: selectionMode ? 'var(--accent)' : 'var(--muted)',
                  border: `1px solid ${selectionMode ? 'var(--accent)' : 'var(--border)'}`,
                  fontFamily: 'var(--font-heading)',
                  transition: 'all 150ms',
                }}
              >
                <MousePointerSquareDashed size={13} />
                Select
              </button>
            )}
          </div>

          {!isMyTasksView && (
            <div className="hidden md:flex items-center gap-2">
              {selectedProject && (resolvedConfig?.task_templates?.length ?? 0) > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setTemplatesDropdownOpen((v) => !v)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium"
                    style={{
                      background: 'var(--surface)',
                      color: 'var(--foreground-secondary)',
                      border: '1px solid var(--border)',
                      fontFamily: 'var(--font-heading)',
                    }}
                  >
                    <FileText size={13} />
                    Templates
                    <ChevronDown size={12} />
                  </button>
                  {templatesDropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setTemplatesDropdownOpen(false)} />
                      <div
                        className="absolute right-0 top-full mt-1 w-64 rounded-lg py-1 z-20"
                        style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                      >
                        {resolvedConfig!.task_templates.map((tpl) => (
                          <button
                            key={tpl.id}
                            onClick={async () => {
                              setTemplatesDropdownOpen(false);
                              const res = await api.post(
                                `/api/projects/${selectedProject.id}/apply-template`,
                                { template_id: tpl.id },
                              );
                              if (res.ok) {
                                const data = await res.json();
                                await loadTasks();
                                setToast(`${data.count} task${data.count === 1 ? '' : 's'} created from "${tpl.name}"`);
                              } else {
                                setToast('Failed to apply template');
                              }
                            }}
                            className="w-full text-left px-3 py-2 text-[12px]"
                            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                          >
                            <div className="font-medium">{tpl.name}</div>
                            <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
                              {tpl.tasks.length} task{tpl.tasks.length === 1 ? '' : 's'}
                            </div>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              <button
                onClick={() => {
                  setQuickCreateStatus(undefined);
                  setQuickCreateOpen(true);
                }}
                className="deft-pill deft-pill-active min-h-[36px] px-4 text-[13px]"
                style={{
                  background: 'var(--accent)',
                  fontFamily: 'var(--font-heading)',
                  transition: 'opacity 150ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.9')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
              >
                <Plus size={14} />
                New task
              </button>
            </div>
          )}
        </div>

        {/* Filter bar */}
        <TaskFilters
          filters={filters}
          onChange={handleFiltersChange}
          projects={projects}
          statuses={resolvedConfig?.statuses}
          priorityVocab={resolvedConfig?.priority_vocab}
          viewConfig={currentViewConfig}
          onApplyViewConfig={handleApplyViewConfig}
        />

        {/* Board or List view */}
        <div className="flex-1 overflow-hidden">
          {isMyTasksView ? (
            /* My Tasks: grouped by project */
            <div className="h-full overflow-y-auto">
              {groupedByProject.length === 0 && (
                <div className="flex items-center justify-center py-16" style={{ color: 'var(--muted)' }}>
                  <p className="text-[14px]" style={{ fontFamily: 'var(--font-body)' }}>No tasks assigned to you</p>
                </div>
              )}
              {groupedByProject.map((group) => (
                <div key={group.prefix} className="mb-6">
                  {/* Project section header */}
                  <div className="flex items-center gap-2 px-6 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                    <div
                      className="w-3 h-3 rounded-sm flex-shrink-0"
                      style={{ background: group.color }}
                    />
                    <span
                      className="text-[13px] font-semibold"
                      style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
                    >
                      {group.name}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {group.tasks.length} {group.tasks.length === 1 ? 'task' : 'tasks'}
                    </span>
                  </div>
                  {view === 'board' ? (
                    <TaskBoard
                      tasks={group.tasks}
                      projectPrefix={group.prefix}
                      onTaskClick={handleTaskClick}
                      onStatusChange={handleStatusChange}
                      onReorder={handleReorder}
                      onColumnAdd={handleColumnAdd}
                      selectedTaskId={selectedTask?.id || null}
                      onDuplicate={handleDuplicate}
                      onDelete={handleDeleteTask}
                      selectionMode={selectionMode}
                      selectedTaskIds={selectedTaskIds}
                      onToggleSelect={handleToggleSelect}
                    />
                  ) : (
                    <TaskTable
                      tasks={group.tasks}
                      projectPrefix={group.prefix}
                      onTaskClick={handleTaskClick}
                      onTaskPatch={handleTaskPatch}
                      members={orgMembers}
                      availableLabels={orgLabels}
                      selectedTaskId={selectedTask?.id || null}
                      selectionMode={selectionMode}
                      selectedTaskIds={selectedTaskIds}
                      onToggleSelect={handleToggleSelect}
                      viewConfig={currentViewConfig}
                      onViewConfigChange={setLayoutConfig}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            /* Project view: single board/list/timeline */
            <div className="flex flex-col h-full">
              {/* Fix 2: scope label so users always know what they're seeing */}
              {!isMobile && (
                <div className="flex items-center gap-2 px-6 py-1.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span className="text-[11px]" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                    Showing{' '}
                    <span style={{ color: 'var(--foreground-secondary)', fontWeight: 500 }}>
                      {view === 'table' && tablePage.serverBacked ? tablePage.total : filteredTasks.length}{' '}
                      {(view === 'table' && tablePage.serverBacked ? tablePage.total : filteredTasks.length) === 1 ? 'task' : 'tasks'}
                    </span>
                    {selectedProject ? (
                      <> in <span style={{ color: 'var(--foreground-secondary)', fontWeight: 500 }}>{selectedProject.name}</span></>
                    ) : null}
                    {filters.priorities.length > 0 && <> · Priority filtered</>}
                    {filters.assigneeIds.length > 0 && <> · Assignee filtered</>}
                    {filters.status.length > 0 && <> · Status filtered</>}
                  </span>
                </div>
              )}
              <div className="flex-1 overflow-hidden">
            {view === 'board' ? (
              <TaskBoard
                tasks={filteredTasks}
                projectPrefix={selectedProject?.prefix || ''}
                onTaskClick={handleTaskClick}
                onStatusChange={handleStatusChange}
                onReorder={handleReorder}
                onColumnAdd={handleColumnAdd}
                selectedTaskId={selectedTask?.id || null}
                onDuplicate={handleDuplicate}
                onDelete={handleDeleteTask}
                selectionMode={selectionMode}
                selectedTaskIds={selectedTaskIds}
                onToggleSelect={handleToggleSelect}
                statuses={resolvedConfig?.statuses}
                hidePrefixIds={resolvedConfig?.hide_prefix_ids}
              />
            ) : view === 'table' ? (
              <TaskTable
                tasks={filteredTasks}
                projectPrefix={selectedProject?.prefix || ''}
                onTaskClick={handleTaskClick}
                onTaskPatch={handleTaskPatch}
                members={orgMembers}
                availableLabels={orgLabels}
                selectedTaskId={selectedTask?.id || null}
                selectionMode={selectionMode}
                selectedTaskIds={selectedTaskIds}
                onToggleSelect={handleToggleSelect}
                statuses={resolvedConfig?.statuses}
                hidePrefixIds={resolvedConfig?.hide_prefix_ids}
                priorityVocab={resolvedConfig?.priority_vocab}
                viewConfig={currentViewConfig}
                onViewConfigChange={setLayoutConfig}
                onInlineCreate={handleInlineCreate}
                pagination={tablePage.serverBacked ? {
                  page: tablePage.previousCursors.length + 1,
                  total: tablePage.total,
                  hasPrevious: tablePage.previousCursors.length > 0,
                  hasNext: Boolean(tablePage.nextCursor),
                  loading: tablePage.loading,
                  onPrevious: handleTablePreviousPage,
                  onNext: handleTableNextPage,
                } : undefined}
              />
            ) : view === 'calendar' ? (
              <TaskCalendarView
                tasks={filteredTasks}
                projectPrefix={selectedProject?.prefix || ''}
                hidePrefixIds={resolvedConfig?.hide_prefix_ids}
                onTaskClick={handleTaskClick}
                onAddOnDate={(iso) => {
                  setQuickCreateStatus(undefined);
                  setQuickCreateOpen(true);
                  // Best-effort: seed the quick-create modal with due_date via
                  // a global setter would be invasive; the user can set it
                  // manually after click. Follow-up can thread a
                  // `defaultDueDate` prop through TaskQuickCreate.
                  void iso;
                }}
              />
            ) : view === 'pipeline' ? (
              <TaskPipelineView
                tasks={filteredTasks}
                projectPrefix={selectedProject?.prefix || ''}
                statuses={resolvedConfig?.statuses}
                hidePrefixIds={resolvedConfig?.hide_prefix_ids}
                priorityVocab={resolvedConfig?.priority_vocab}
                onTaskClick={handleTaskClick}
              />
            ) : (
              view === 'timeline' && selectedProject && (
                <Suspense fallback={<div className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin" /></div>}>
                  <TaskTimeline
                    tasks={filteredTasks}
                    onTaskClick={(num) => router.push(`/tasks?task=${selectedProject.prefix}-${num}`)}
                    projectPrefix={selectedProject.prefix}
                  />
                </Suspense>
              )
            )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selectedTask && (
        <TaskDetail
          taskId={selectedTask.id}
          projectPrefix={isMyTasksView ? selectedTask.project_prefix : selectedProject?.prefix || ''}
          onClose={() => {
            setSelectedTask(null);
            const params = new URLSearchParams(searchParams.toString());
            params.delete('task');
            router.push('/tasks?' + params.toString(), { scroll: false });
          }}
          onUpdated={handleTaskUpdated}
          onDuplicate={handleDuplicate}
          onDelete={handleDeleteTask}
          onTaskNavigate={async (navTaskId: string) => {
            // Navigate to another task in the detail panel (subtask, parent, dependency)
            const res = await api.get(`/api/tasks/${navTaskId}`);
            if (res.ok) {
              const data = await res.json();
              // Build a minimal Task object for selectedTask
              const navTask: Task = {
                id: data.id,
                number: data.number,
                title: data.title,
                description: data.description,
                status: data.status,
                priority: data.priority,
                assignee_id: data.assignee?.id || null,
                assignee_name: data.assignee?.name || null,
                assignee_avatar: data.assignee?.avatar_url || null,
                created_by: data.created_by,
                creator_name: data.creator?.name || null,
                due_date: data.due_date,
                start_date: data.start_date || null,
                sort_order: data.sort_order,
                source_message_id: data.source_message_id,
                is_deleted: data.is_deleted,
                project_id: data.project_id,
                project_prefix: data.project_prefix,
                project_name: data.project_name,
                project_color: null,
                labels: data.labels || [],
                parent_task_id: data.parent_task_id || null,
                subtask_count: data.subtasks?.length || 0,
                subtask_done_count: data.subtasks?.filter((s: any) => s.status === 'done').length || 0,
                created_at: data.created_at,
                updated_at: data.updated_at,
              };
              setSelectedTask(navTask);
              const params = new URLSearchParams(searchParams.toString());
              params.set('task', data.project_prefix + '-' + data.number);
              router.push('/tasks?' + params.toString(), { scroll: false });
            }
          }}
        />
      )}

      {/* Quick create modal */}
      {quickCreateOpen && selectedProject && !isMyTasksView && (
        <TaskQuickCreate
          projectId={selectedProject.id}
          defaultStatus={quickCreateStatus}
          onClose={() => setQuickCreateOpen(false)}
          onCreated={handleTaskCreated}
        />
      )}

      {/* Mobile FAB */}
      {isMobile && !isMyTasksView && !selectedTask && (
        <button
          onClick={() => { setQuickCreateStatus(undefined); setQuickCreateOpen(true); }}
          aria-label="Create task"
          title="Create task"
          className="fixed z-30 w-12 h-12 rounded-full flex items-center justify-center text-white shadow-lg"
          style={{
            background: 'var(--accent)',
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 80px)',
            right: '16px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <Plus size={22} />
        </button>
      )}

      {/* Selection mode active indicator (shown when in select mode but nothing chosen yet) */}
      {selectionMode && selectedTaskIds.size === 0 && (
        <div
          className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-xl"
          style={{
            background: 'var(--card-bg)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <span
            className="text-[13px] font-medium"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            0 selected — click tasks to select
          </span>
          <button
            onClick={() => setSelectionMode(false)}
            className="text-[12px] px-2 py-1 rounded"
            style={{ color: 'var(--accent)', fontFamily: 'var(--font-heading)' }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Floating bulk action bar */}
      {selectedTaskIds.size > 0 && (
        <>
          {bulkActionDropdown && (
            <div className="fixed inset-0 z-40" onClick={() => setBulkActionDropdown(null)} />
          )}
          <div
            className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl max-w-[calc(100vw-2rem)] overflow-x-auto"
            style={{
              background: 'var(--card-bg)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <span
              className="text-[13px] font-medium mr-2"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', whiteSpace: 'nowrap' }}
            >
              {selectedTaskIds.size} selected
            </span>

            {/* Status dropdown */}
            <div className="relative">
              <button
                onClick={() => setBulkActionDropdown(bulkActionDropdown === 'status' ? null : 'status')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] font-medium"
                style={{
                  background: bulkActionDropdown === 'status' ? 'var(--hover-tint)' : 'var(--surface)',
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-heading)',
                  border: '1px solid var(--border)',
                }}
              >
                Move to...
                <ChevronDown size={12} />
              </button>
              {bulkActionDropdown === 'status' && (
                <div
                  className="absolute bottom-full left-0 mb-2 w-44 rounded-lg py-1 z-50"
                  style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleBulkStatusChange(opt.value)}
                      className="w-full text-left px-3 py-1.5 text-[12px]"
                      style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Assignee dropdown */}
            <div className="relative">
              <button
                onClick={() => setBulkActionDropdown(bulkActionDropdown === 'assignee' ? null : 'assignee')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] font-medium"
                style={{
                  background: bulkActionDropdown === 'assignee' ? 'var(--hover-tint)' : 'var(--surface)',
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-heading)',
                  border: '1px solid var(--border)',
                }}
              >
                Assign to...
                <ChevronDown size={12} />
              </button>
              {bulkActionDropdown === 'assignee' && (
                <div
                  className="absolute bottom-full left-0 mb-2 w-48 rounded-lg py-1 z-50 max-h-56 overflow-y-auto"
                  style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                >
                  <button
                    onClick={() => handleBulkAssigneeChange(null)}
                    className="w-full text-left px-3 py-1.5 text-[12px]"
                    style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    Unassign
                  </button>
                  {orgMembers.map((member) => (
                    <button
                      key={member.id}
                      onClick={() => handleBulkAssigneeChange(member.id)}
                      className="w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2"
                      style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <PersonAvatar name={member.name} avatarUrl={member.avatar_url} size={16} fontSize={9} />
                      <span className="truncate">{member.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Priority dropdown */}
            <div className="relative">
              <button
                onClick={() => setBulkActionDropdown(bulkActionDropdown === 'priority' ? null : 'priority')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] font-medium"
                style={{
                  background: bulkActionDropdown === 'priority' ? 'var(--hover-tint)' : 'var(--surface)',
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-heading)',
                  border: '1px solid var(--border)',
                }}
              >
                Set priority...
                <ChevronDown size={12} />
              </button>
              {bulkActionDropdown === 'priority' && (
                <div
                  className="absolute bottom-full left-0 mb-2 w-44 rounded-lg py-1 z-50"
                  style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleBulkPriorityChange(opt.value)}
                      className="w-full text-left px-3 py-1.5 text-[12px]"
                      style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Delete button */}
            <button
              onClick={handleBulkDelete}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] font-medium"
              style={{
                background: 'var(--surface)',
                color: 'var(--danger)',
                fontFamily: 'var(--font-heading)',
                border: '1px solid var(--border)',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(220, 38, 38, 0.08)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--surface)')}
            >
              <Trash2 size={12} />
              Delete
            </button>

            {/* Clear selection */}
            <button
              onClick={() => {
                setSelectedTaskIds(new Set());
                setSelectionMode(false);
              }}
              className="p-1.5 rounded-md ml-1"
              style={{ color: 'var(--muted)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
              title="Clear selection"
            >
              <X size={14} />
            </button>
          </div>
        </>
      )}

      {/* Toast notification */}
      {toast && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg text-[13px] font-medium"
          style={{
            background: 'var(--foreground)',
            color: 'var(--background)',
            fontFamily: 'var(--font-body)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
