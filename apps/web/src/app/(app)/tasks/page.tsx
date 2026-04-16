'use client';

import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useSearchParams, useRouter } from 'next/navigation';
import { TaskBoard } from '@/components/task-board';
import { TaskList } from '@/components/task-list';
import { TaskDetail } from '@/components/task-detail';
import { TaskFilters, type Filters } from '@/components/task-filters';
import { TaskQuickCreate } from '@/components/task-quick-create';
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
  CalendarRange,
} from 'lucide-react';

const TaskTimeline = lazy(() => import('./timeline'));
import { EmptyState } from '@/components/empty-state';
import { CreateProjectModal } from '@/components/create-project-modal';

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
  const [view, setView] = useState<'board' | 'list' | 'timeline' | 'calendar' | 'pipeline'>('board');
  // Task 4.9 — once the user toggles the view manually, we stop auto-selecting
  // the resolved-config default so their preference wins.
  const [userSelectedView, setUserSelectedView] = useState(false);
  const [filters, setFilters] = useState<Filters>({
    assigneeIds: [],
    priorities: [],
    status: [],
    labels: [],
    dueDate: null,
    dateFrom: null,
    dateTo: null,
    projectId: null,
  });
  const [loading, setLoading] = useState(true);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [quickCreateStatus, setQuickCreateStatus] = useState<string | undefined>(undefined);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [bulkActionDropdown, setBulkActionDropdown] = useState<string | null>(null);
  const [orgMembers, setOrgMembers] = useState<{ id: string; name: string; avatar_url: string | null }[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [velocity, setVelocity] = useState<{ average: number } | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const currentView = searchParams.get('view');
  const currentProjectId = searchParams.get('project');
  const isMyTasksView = currentView === 'my';

  // Task 4.9 — resolved skill config drives status/vocab/view/prefix
  const { config: resolvedConfig } = useProjectResolvedConfig(selectedProject?.id ?? null);

  // Auto-select the project's default view once when the config loads, unless
  // the user has already picked a view. "timeline" is kept engineering-only
  // (not a valid skill default today but guarded anyway).
  useEffect(() => {
    if (!resolvedConfig || userSelectedView || isMyTasksView) return;
    const dv = resolvedConfig.default_view;
    if (dv && dv !== view && (dv === 'board' || dv === 'list' || dv === 'timeline' || dv === 'calendar' || dv === 'pipeline')) {
      setView(dv);
    }
  }, [resolvedConfig, userSelectedView, isMyTasksView]);

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
  const loadTasks = useCallback(async () => {
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
  }, [selectedProject, isMyTasksView]);

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
      setTasks((prev) => (prev.some((t) => t.id === payload.id) ? prev : [...prev, payload]));
    };

    const onUpdated = (payload: Partial<Task> & { id: string }) => {
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
      setTasks((prev) => prev.filter((t) => t.id !== payload.id));
      setSelectedTask((prev) => (prev && prev.id === payload.id ? null : prev));
    };

    socket.on('task:created', onCreated);
    socket.on('task:updated', onUpdated);
    socket.on('task:deleted', onDeleted);

    return () => {
      socket.off('task:created', onCreated);
      socket.off('task:updated', onUpdated);
      socket.off('task:deleted', onDeleted);
    };
  }, [selectedProject, isMyTasksView, user?.id, loadTasks]);

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

  // On mount: if URL has ?task=DEFT-5, find and open that task
  // If the task belongs to a different project, switch to that project first
  useEffect(() => {
    const taskParam = searchParams.get('task');
    if (taskParam && projects.length > 0) {
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

  const handleStatusChange = async (taskId: string, newStatus: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: newStatus as Task['status'] } : t))
    );
    if (selectedTask?.id === taskId) {
      setSelectedTask((prev) => prev ? { ...prev, status: newStatus as Task['status'] } : null);
    }
    await api.patch(`/api/tasks/${taskId}`, { status: newStatus });
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

  const handleTaskCreated = () => {
    loadTasks();
    setQuickCreateOpen(false);
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
              <div className="relative">
                <button
                  onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md"
                  style={{
                    color: 'var(--foreground)',
                    fontFamily: 'var(--font-heading)',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: projectDropdownOpen ? 'var(--hover-tint)' : 'transparent',
                    transition: 'background 150ms',
                  }}
                >
                  {selectedProject?.color && (
                    <div
                      className="w-3 h-3 rounded-sm flex-shrink-0"
                      style={{ background: selectedProject.color }}
                    />
                  )}
                  {selectedProject?.name || 'Select project'}
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
                    <div className="fixed inset-0 z-10" onClick={() => setProjectDropdownOpen(false)} />
                    <div
                      className="absolute top-full left-0 mt-1 w-56 rounded-lg py-1 z-20"
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
            <div
              className="flex items-center rounded-md p-0.5"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <button
                onClick={() => { setView('board'); setUserSelectedView(true); }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-medium transition-colors"
                style={{
                  background: view === 'board' ? 'var(--accent)' : 'transparent',
                  color: view === 'board' ? 'white' : 'var(--muted)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                <LayoutGrid size={13} />
                Board
              </button>
              <button
                onClick={() => { setView('list'); setUserSelectedView(true); }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-medium transition-colors"
                style={{
                  background: view === 'list' ? 'var(--accent)' : 'transparent',
                  color: view === 'list' ? 'white' : 'var(--muted)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                <List size={13} />
                List
              </button>
              <button
                onClick={() => { setView('timeline'); setUserSelectedView(true); }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-medium transition-colors"
                style={{
                  background: view === 'timeline' ? 'var(--accent)' : 'transparent',
                  color: view === 'timeline' ? 'white' : 'var(--muted)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                <CalendarRange size={13} />
                Timeline
              </button>
            </div>

            {/* Select toggle */}
            {!isMobile && (
              <button
                onClick={() => setSelectionMode(!selectionMode)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium"
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
            <button
              onClick={() => {
                setQuickCreateStatus(undefined);
                setQuickCreateOpen(true);
              }}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium text-white"
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
          )}
        </div>

        {/* Filter bar */}
        <TaskFilters
          filters={filters}
          onChange={setFilters}
          projects={projects}
          statuses={resolvedConfig?.statuses}
          priorityVocab={resolvedConfig?.priority_vocab}
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
                    <TaskList
                      tasks={group.tasks}
                      projectPrefix={group.prefix}
                      onTaskClick={handleTaskClick}
                      onStatusChange={handleStatusChange}
                      selectedTaskId={selectedTask?.id || null}
                      selectionMode={selectionMode}
                      selectedTaskIds={selectedTaskIds}
                      onToggleSelect={handleToggleSelect}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            /* Project view: single board/list/timeline */
            view === 'board' ? (
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
            ) : view === 'list' ? (
              <TaskList
                tasks={filteredTasks}
                projectPrefix={selectedProject?.prefix || ''}
                onTaskClick={handleTaskClick}
                onStatusChange={handleStatusChange}
                selectedTaskId={selectedTask?.id || null}
                selectionMode={selectionMode}
                selectedTaskIds={selectedTaskIds}
                onToggleSelect={handleToggleSelect}
                statuses={resolvedConfig?.statuses}
                hidePrefixIds={resolvedConfig?.hide_prefix_ids}
                priorityVocab={resolvedConfig?.priority_vocab}
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
            )
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
          className="fixed z-30 w-12 h-12 rounded-full flex items-center justify-center text-white shadow-lg"
          style={{
            background: 'var(--accent)',
            bottom: '80px',
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
                      <div
                        className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-medium text-white flex-shrink-0"
                        style={{ background: 'var(--accent)' }}
                      >
                        {member.name.charAt(0).toUpperCase()}
                      </div>
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
