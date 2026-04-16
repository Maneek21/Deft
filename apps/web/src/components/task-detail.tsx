'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { TagPicker } from './tag-picker';
import {
  X,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ArrowLeft,
  Calendar,
  Tag,
  User,
  MessageSquare,
  Activity,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Plus,
  Check,
  Lock,
  Link2,
  Search,
  ListChecks,
  Hash,
  Paperclip,
  Upload,
  Trash2,
} from 'lucide-react';
import { statusLabel } from '@/lib/task-status-labels';

type Task = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  // Primary assignee — singular (see Phase 0.3: schema.ts tasks.assignee_id)
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  // Additional assignees — loaded from GET /api/tasks/:id/assignees
  additional_assignees?: { user_id: string; user_name: string | null; user_avatar: string | null }[];
  created_by: string;
  creator_name: string | null;
  due_date: string | null;
  start_date: string | null;
  estimation: string | null;
  sort_order: number;
  source_message_id: string | null;
  is_deleted: boolean;
  project_id: string;
  project_prefix: string;
  project_name: string;
  project_color: string | null;
  labels: { id: string; name: string; color: string }[];
  parent_task_id: string | null;
  created_at: string;
  updated_at: string;
};

type Subtask = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  sort_order: number;
  parent_task_id: string | null;
};

type ParentTask = {
  id: string;
  number: number;
  title: string;
  project_prefix: string;
};

type DependencyTask = {
  relationship_id: string;
  task_id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  assignee_name: string | null;
  project_prefix: string;
};

type Dependencies = {
  blocks: DependencyTask[];
  blocked_by: DependencyTask[];
  relates_to: DependencyTask[];
};

type SearchResult = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  project_prefix: string;
};

type Comment = {
  id: string;
  content: string;
  user_id: string;
  user_name: string;
  user_avatar: string | null;
  created_at: string;
};

type ActivityItem = {
  id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  user_name: string;
  created_at: string;
};

type Props = {
  taskId: string;
  projectPrefix: string;
  onClose: () => void;
  onUpdated: (task: Task) => void;
  onDuplicate?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  onTaskNavigate?: (taskId: string) => void;
};

const STATUS_OPTIONS = [
  { value: 'backlog', label: statusLabel('backlog') },
  { value: 'todo', label: statusLabel('todo') },
  { value: 'in_progress', label: statusLabel('in_progress') },
  { value: 'in_review', label: statusLabel('in_review') },
  { value: 'done', label: statusLabel('done') },
  { value: 'cancelled', label: statusLabel('cancelled') },
];

const PRIORITY_OPTIONS = [
  { value: 'p0', label: 'P0 — Urgent', color: '#DC2626' },
  { value: 'p1', label: 'P1 — High', color: '#F59E0B' },
  { value: 'p2', label: 'P2 — Medium', color: '#3B82F6' },
  { value: 'p3', label: 'P3 — Low', color: '#6B7280' },
];

const STATUS_COLORS: Record<string, string> = {
  backlog: 'var(--muted)',
  todo: 'var(--foreground-secondary)',
  in_progress: 'var(--accent)',
  in_review: '#8B5CF6',
  done: 'var(--success)',
  cancelled: 'var(--danger)',
};

function formatStatusLabel(status: string): string {
  return statusLabel(status);
}

function formatPriorityLabel(priority: string): string {
  const map: Record<string, string> = {
    p0: 'P0 (Critical)', p1: 'P1 (High)', p2: 'P2 (Medium)', p3: 'P3 (Low)',
  };
  return map[priority] || priority;
}

function formatFieldName(field: string): string {
  const map: Record<string, string> = {
    status: 'Status', priority: 'Priority', assignee_id: 'Assignee',
    title: 'Title', description: 'Description', due_date: 'Due Date',
  };
  return map[field] || field;
}

function formatActivityValue(field: string, value: string | null, members?: { id: string; name: string }[]): string {
  if (!value) return 'none';
  if (field === 'status') return formatStatusLabel(value);
  if (field === 'priority') return formatPriorityLabel(value);
  if (field === 'assignee_id' && members) {
    const member = members.find(m => m.id === value);
    return member ? member.name : value;
  }
  return value;
}

function DescriptionEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false }),
      Placeholder.configure({ placeholder: 'Add a description...' }),
    ],
    content: value || '',
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: { class: 'deft-editor' },
    },
  });

  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value || '');
    }
  }, [value, editor]);

  return (
    <div
      className="rounded-md min-h-[100px] text-[13px]"
      style={{
        border: '1px solid var(--border)',
        color: 'var(--foreground)',
        fontFamily: 'var(--font-body)',
        lineHeight: '1.6',
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}

export function TaskDetail({ taskId, projectPrefix, onClose, onUpdated, onDuplicate, onDelete, onTaskNavigate }: Props) {
  const { user } = useAuth();
  const router = useRouter();
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState('');
  const [descValue, setDescValue] = useState('');
  const [activeTab, setActiveTab] = useState<'comments' | 'activity'>('comments');
  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [newComment, setNewComment] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const commentEditor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: { HTMLAttributes: { class: 'deft-code-block' } },
        code: { HTMLAttributes: { class: 'deft-inline-code' } },
      }),
      Placeholder.configure({ placeholder: 'Add a comment...' }),
    ],
    editorProps: { attributes: { class: 'deft-editor' } },
  });
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [members, setMembers] = useState<{ id: string; name: string; avatar_url: string | null }[]>([]);
  const [agentEmployees, setAgentEmployees] = useState<any[]>([]);
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [metadataExpanded, setMetadataExpanded] = useState(false);
  useEffect(() => {
    setMetadataExpanded(false);
  }, [taskId]);
  const [taskTags, setTaskTags] = useState<{ id: string; name: string; color: string | null }[]>([]);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Subtask state
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [parentTask, setParentTask] = useState<ParentTask | null>(null);
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [creatingSubtask, setCreatingSubtask] = useState(false);

  // Dependency state
  const [dependencies, setDependencies] = useState<Dependencies>({ blocks: [], blocked_by: [], relates_to: [] });
  const [addingDependency, setAddingDependency] = useState(false);
  const [depSearchQuery, setDepSearchQuery] = useState('');
  const [depSearchResults, setDepSearchResults] = useState<SearchResult[]>([]);
  const [depType, setDepType] = useState<'blocks' | 'blocked_by' | 'relates_to'>('blocked_by');
  const [searchingDeps, setSearchingDeps] = useState(false);

  // Attachments state
  const [attachments, setAttachments] = useState<{ id: string; filename: string; mime_type: string; size_bytes: number; storage_key: string; created_at: string }[]>([]);
  const attachFileRef = useRef<HTMLInputElement>(null);

  // References state (backlinks)
  const [references, setReferences] = useState<{
    id: string; source_type: string; source_id: string; context: string | null;
    message_preview: string | null; message_space_id: string | null; space_name: string | null;
    author_name: string | null; author_avatar: string | null; created_at: string;
  }[]>([]);

  const titleRef = useRef<HTMLInputElement>(null);
  const dueDateInputRef = useRef<HTMLInputElement>(null);
  const startDateInputRef = useRef<HTMLInputElement>(null);
  const titleDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const depSearchDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Load task
  const loadTask = useCallback(async () => {
    setLoading(true);
    const res = await api.get(`/api/tasks/${taskId}`);
    if (res.ok) {
      const data = await res.json();
      setTask(data);
      setTitleValue(data.title);
      setDescValue(data.description || '');
      setSubtasks(data.subtasks || []);
      setParentTask(data.parent_task || null);
    }
    setLoading(false);
  }, [taskId]);

  useEffect(() => {
    loadTask();
  }, [loadTask]);

  // Load tags for this task
  const loadTaskTags = useCallback(async () => {
    const res = await api.get(`/api/tags/entity/task/${taskId}`);
    if (res.ok) {
      setTaskTags(await res.json());
    }
  }, [taskId]);

  useEffect(() => {
    loadTaskTags();
  }, [loadTaskTags]);

  // Load attachments
  useEffect(() => {
    api.get(`/api/tasks/${taskId}/attachments`).then(async (res) => {
      if (res.ok) setAttachments(await res.json());
    }).catch(() => {});
  }, [taskId]);

  // Load dependencies
  const loadDependencies = useCallback(async () => {
    const res = await api.get(`/api/tasks/${taskId}/dependencies`);
    if (res.ok) setDependencies(await res.json());
  }, [taskId]);

  useEffect(() => {
    loadDependencies();
  }, [loadDependencies]);

  // Load references (backlinks)
  const loadReferences = useCallback(async () => {
    const res = await api.get(`/api/tasks/${taskId}/references`);
    if (res.ok) {
      const data = await res.json();
      setReferences(data.references || []);
    }
  }, [taskId]);

  useEffect(() => {
    loadReferences();
  }, [loadReferences]);

  // Load comments
  const loadComments = useCallback(async () => {
    const res = await api.get(`/api/tasks/${taskId}/comments`);
    if (res.ok) setComments(await res.json());
  }, [taskId]);

  // Load activity
  const loadActivity = useCallback(async () => {
    const res = await api.get(`/api/tasks/${taskId}/activity`);
    if (res.ok) setActivity(await res.json());
  }, [taskId]);

  // Subtask handlers
  const handleAddSubtask = async () => {
    if (!newSubtaskTitle.trim() || creatingSubtask || !task) return;
    setCreatingSubtask(true);
    const res = await api.post(`/api/projects/${task.project_id}/tasks`, {
      title: newSubtaskTitle.trim(),
      parent_task_id: taskId,
      priority: task.priority,
      status: 'todo',
    });
    if (res.ok) {
      setNewSubtaskTitle('');
      setAddingSubtask(false);
      loadTask(); // Reload to get updated subtasks
    }
    setCreatingSubtask(false);
  };

  const handleToggleSubtaskStatus = async (subtask: Subtask) => {
    const newStatus = subtask.status === 'done' ? 'todo' : 'done';
    // Optimistic update
    setSubtasks((prev) =>
      prev.map((s) => (s.id === subtask.id ? { ...s, status: newStatus } : s))
    );
    await api.patch(`/api/tasks/${subtask.id}`, { status: newStatus });
  };

  // Dependency handlers
  const handleDepSearch = (query: string) => {
    setDepSearchQuery(query);
    clearTimeout(depSearchDebounce.current);
    if (query.trim().length < 2) {
      setDepSearchResults([]);
      return;
    }
    depSearchDebounce.current = setTimeout(async () => {
      setSearchingDeps(true);
      const res = await api.get(`/api/tasks/search?q=${encodeURIComponent(query.trim())}`);
      if (res.ok) {
        const results: SearchResult[] = await res.json();
        // Filter out current task and already-linked tasks
        const existingIds = new Set([
          ...dependencies.blocks.map((d) => d.task_id),
          ...dependencies.blocked_by.map((d) => d.task_id),
          ...dependencies.relates_to.map((d) => d.task_id),
          taskId,
        ]);
        setDepSearchResults(results.filter((r) => !existingIds.has(r.id)));
      }
      setSearchingDeps(false);
    }, 300);
  };

  const handleAddDependency = async (targetTaskId: string) => {
    const res = await api.post(`/api/tasks/${taskId}/dependencies`, {
      target_task_id: targetTaskId,
      type: depType,
    });
    if (res.ok) {
      setAddingDependency(false);
      setDepSearchQuery('');
      setDepSearchResults([]);
      loadDependencies();
    }
  };

  const handleRemoveDependency = async (relationshipId: string) => {
    const res = await api.delete(`/api/tasks/${taskId}/dependencies/${relationshipId}`);
    if (res.ok) {
      loadDependencies();
    }
  };

  // Load members
  useEffect(() => {
    async function load() {
      const res = await api.get('/api/members');
      if (res.ok) setMembers(await res.json());
    }
    load();
  }, []);

  // Load agent employees
  useEffect(() => {
    api.get('/api/agent-employees').then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setAgentEmployees(data.filter((e: any) => e.is_active));
      }
    });
  }, []);

  useEffect(() => {
    if (activeTab === 'comments') loadComments();
    else loadActivity();
  }, [activeTab, loadComments, loadActivity]);

  // Title edit with debounce
  const handleTitleChange = (value: string) => {
    setTitleValue(value);
    clearTimeout(titleDebounce.current);
    titleDebounce.current = setTimeout(async () => {
      if (value.trim() && task) {
        const res = await api.patch(`/api/tasks/${taskId}`, { title: value.trim() });
        if (res.ok) {
          const apiResult = await res.json();
          const merged = { ...task, ...apiResult };
          setTask(merged);
          onUpdated(merged);
        }
      }
    }, 500);
  };

  const handleFieldUpdate = async (field: string, value: string | null) => {
    setOpenDropdown(null);
    if (!task) return;
    const res = await api.patch(`/api/tasks/${taskId}`, { [field]: value });
    if (res.ok) {
      const apiResult = await res.json();
      // Merge API result into existing task to preserve joined fields (project_prefix, assignee_name, labels, etc.)
      const merged = { ...task, ...apiResult };
      // If assignee changed, update the name from members list or agent employees
      if (field === 'assignee_id') {
        const member = members.find(m => m.id === value);
        const agent = agentEmployees.find(e => e.user_id === value);
        merged.assignee_name = member?.name || (agent ? `${agent.name} (AI)` : null);
        merged.assignee_avatar = member?.avatar_url || null;
      }
      setTask(merged);
      onUpdated(merged);
    }
  };

  const handleAddComment = async () => {
    const html = commentEditor?.getHTML() ?? '';
    const text = commentEditor?.getText() ?? '';
    if (!text.trim() || submittingComment) return;
    setSubmittingComment(true);
    const res = await api.post(`/api/tasks/${taskId}/comments`, { content: html });
    if (res.ok) {
      commentEditor?.commands.clearContent();
      loadComments();
    }
    setSubmittingComment(false);
  };

  if (loading || !task) {
    return (
      <div
        className={isMobile
          ? "fixed inset-0 z-50 flex items-center justify-center"
          : "w-[450px] flex-shrink-0 flex items-center justify-center"
        }
        style={{ borderLeft: isMobile ? 'none' : '1px solid var(--border)', background: 'var(--card-bg)' }}
      >
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--muted)' }} />
      </div>
    );
  }

  const priorityInfo = PRIORITY_OPTIONS.find((p) => p.value === task.priority);

  return (
    <>
      {/* Click-away for dropdowns */}
      {openDropdown && (
        <div className="fixed inset-0 z-10" onClick={() => setOpenDropdown(null)} />
      )}

      <div
        className={isMobile
          ? "fixed inset-0 z-50 flex flex-col overflow-hidden"
          : "w-[450px] flex-shrink-0 flex flex-col h-full overflow-hidden"
        }
        style={{
          borderLeft: isMobile ? 'none' : '1px solid var(--border)',
          background: 'var(--card-bg)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 h-[52px] flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            {isMobile && (
              <button
                onClick={onClose}
                className="p-1 rounded-md mr-1"
                style={{ color: 'var(--muted)' }}
              >
                <ArrowLeft size={18} strokeWidth={1.5} />
              </button>
            )}
            <span
              className="text-[12px] font-semibold"
              style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
            >
              {projectPrefix || task.project_prefix}-{task.number}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {task.source_message_id && (
              <button
                className="p-1.5 rounded-md"
                style={{ color: 'var(--muted)' }}
                title="View source message"
              >
                <ExternalLink size={14} />
              </button>
            )}
            <div className="relative">
              <button
                onClick={() => setDetailMenuOpen(!detailMenuOpen)}
                className="p-1.5 rounded-md"
                style={{ color: 'var(--muted)', transition: 'color 150ms' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
              >
                <MoreHorizontal size={16} />
              </button>
              {detailMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setDetailMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 w-36 rounded-lg py-1 z-20"
                    style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}>
                    <button className="w-full text-left px-3 py-1.5 text-[12px]"
                      style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => { setDetailMenuOpen(false); onDuplicate?.(taskId); }}>Duplicate</button>
                    <button className="w-full text-left px-3 py-1.5 text-[12px]"
                      style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => {
                        setDetailMenuOpen(false);
                        const url = `${window.location.origin}/tasks?task=${projectPrefix || task.project_prefix}-${task.number}`;
                        navigator.clipboard.writeText(url);
                      }}>Copy link</button>
                    <button className="w-full text-left px-3 py-1.5 text-[12px]"
                      style={{ color: 'var(--danger)', fontFamily: 'var(--font-body)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => { setDetailMenuOpen(false); onDelete?.(taskId); }}>Delete</button>
                  </div>
                </>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md"
              style={{ color: 'var(--muted)', transition: 'color 150ms' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Title */}
          <div className="px-5 pt-5 pb-3">
            {editingTitle ? (
              <input
                ref={titleRef}
                value={titleValue}
                onChange={(e) => handleTitleChange(e.target.value)}
                onBlur={() => setEditingTitle(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation(); // Prevent panel close
                    setEditingTitle(false);
                    setTitleValue(task?.title || '');
                  }
                  if (e.key === 'Enter') setEditingTitle(false);
                }}
                className="w-full text-[18px] font-semibold bg-transparent outline-none"
                style={{
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-heading)',
                  letterSpacing: '-0.01em',
                }}
                autoFocus
              />
            ) : (
              <h2
                onClick={() => {
                  setEditingTitle(true);
                  setTimeout(() => titleRef.current?.focus(), 0);
                }}
                className="text-[18px] font-semibold cursor-text"
                style={{
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-heading)',
                  letterSpacing: '-0.01em',
                }}
              >
                {task.title}
              </h2>
            )}
          </div>

          {/* Fields grid */}
          <div className="px-5 pb-4 grid grid-cols-[100px_1fr] gap-y-2.5 items-center">
            {/* Status */}
            <span className="text-[12px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
              Status
            </span>
            <div className="relative">
              <button
                onClick={() => setOpenDropdown(openDropdown === 'status' ? null : 'status')}
                className="flex items-center gap-2 px-2 py-1 rounded-md text-[13px]"
                style={{
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-body)',
                  transition: 'background 150ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div className="w-2 h-2 rounded-full" style={{ background: STATUS_COLORS[task.status] }} />
                {STATUS_OPTIONS.find((s) => s.value === task.status)?.label}
                <ChevronDown size={12} style={{ color: 'var(--muted)' }} />
              </button>
              {openDropdown === 'status' && (
                <div
                  className="absolute top-full left-0 mt-1 w-44 rounded-lg py-1 z-20"
                  style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleFieldUpdate('status', opt.value)}
                      className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[13px]"
                      style={{
                        color: task.status === opt.value ? 'var(--accent)' : 'var(--foreground)',
                        fontFamily: 'var(--font-body)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div className="w-2 h-2 rounded-full" style={{ background: STATUS_COLORS[opt.value] }} />
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Priority */}
            <span className="text-[12px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
              Priority
            </span>
            <div className="relative">
              <button
                onClick={() => setOpenDropdown(openDropdown === 'priority' ? null : 'priority')}
                className="flex items-center gap-2 px-2 py-1 rounded-md text-[13px]"
                style={{
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-body)',
                  transition: 'background 150ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div className="w-2 h-2 rounded-full" style={{ background: priorityInfo?.color }} />
                {priorityInfo?.label}
                <ChevronDown size={12} style={{ color: 'var(--muted)' }} />
              </button>
              {openDropdown === 'priority' && (
                <div
                  className="absolute top-full left-0 mt-1 w-48 rounded-lg py-1 z-20"
                  style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleFieldUpdate('priority', opt.value)}
                      className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[13px]"
                      style={{
                        color: task.priority === opt.value ? 'var(--accent)' : 'var(--foreground)',
                        fontFamily: 'var(--font-body)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div className="w-2 h-2 rounded-full" style={{ background: opt.color }} />
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Assignee (primary) */}
            <span className="text-[12px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
              <User size={12} className="inline mr-1" />
              Assignee
            </span>
            <div className="relative">
              <button
                onClick={() => setOpenDropdown(openDropdown === 'assignee' ? null : 'assignee')}
                className="flex items-center gap-2 px-2 py-1 rounded-md text-[13px]"
                style={{
                  color: task.assignee_name ? 'var(--foreground)' : 'var(--muted)',
                  fontFamily: 'var(--font-body)',
                  transition: 'background 150ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {task.assignee_name ? (
                  <>
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
                      style={{ background: 'var(--accent)' }}
                    >
                      {task.assignee_name.charAt(0).toUpperCase()}
                    </div>
                    {task.assignee_name}
                  </>
                ) : (
                  'Unassigned'
                )}
                <ChevronDown size={12} style={{ color: 'var(--muted)' }} />
              </button>
              {/* Phase 0.3 — summarize primary + additional assignees */}
              {(task.additional_assignees?.length ?? 0) > 0 && (
                <div
                  className="text-[11px] mt-1 px-2"
                  style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
                >
                  Primary: {task.assignee_name || 'Unassigned'}
                  {' • '}
                  Additional:{' '}
                  {task.additional_assignees!
                    .map((a) => a.user_name || 'Unknown')
                    .join(', ')}
                </div>
              )}
              {openDropdown === 'assignee' && (
                <div
                  className="absolute top-full left-0 mt-1 w-52 rounded-lg py-1 z-20"
                  style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                >
                  <button
                    onClick={() => handleFieldUpdate('assignee_id', null)}
                    className="w-full text-left px-3 py-1.5 text-[13px]"
                    style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    Unassigned
                  </button>
                  {members
                    .filter((m) => !agentEmployees.some((e) => e.user_id === m.id))
                    .map((m) => (
                    <button
                      key={m.id}
                      onClick={() => handleFieldUpdate('assignee_id', m.id)}
                      className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[13px]"
                      style={{
                        color: task.assignee_id === m.id ? 'var(--accent)' : 'var(--foreground)',
                        fontFamily: 'var(--font-body)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
                        style={{ background: 'var(--accent)' }}
                      >
                        {m.name.charAt(0).toUpperCase()}
                      </div>
                      {m.name}
                    </button>
                  ))}
                  {agentEmployees.length > 0 && (
                    <>
                      <div className="my-1" style={{ borderTop: '1px solid var(--border)' }} />
                      <div className="px-3 py-1 text-[11px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
                        AI Agents
                      </div>
                      {agentEmployees.map((emp) => (
                        <button
                          key={emp.user_id}
                          onClick={() => handleFieldUpdate('assignee_id', emp.user_id)}
                          className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[13px]"
                          style={{
                            color: task.assignee_id === emp.user_id ? 'var(--accent)' : 'var(--foreground)',
                            fontFamily: 'var(--font-body)',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          <div
                            className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
                            style={{ background: '#8B5CF6' }}
                          >
                            {emp.name.charAt(0).toUpperCase()}
                          </div>
                          {emp.name}
                          <span className="text-[10px] px-1 py-0.5 rounded" style={{ background: 'var(--hover-tint)', color: 'var(--muted)' }}>AI</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Due Date */}
            <span className="text-[12px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
              <Calendar size={12} className="inline mr-1" />
              Due date
            </span>
            <div className="flex items-center gap-1 relative">
              <span
                className="text-[13px] px-2 py-1 cursor-pointer rounded-md"
                style={{
                  color: task.due_date ? 'var(--foreground)' : 'var(--muted)',
                  fontFamily: 'var(--font-body)',
                }}
                onClick={() => {
                  dueDateInputRef.current?.showPicker?.();
                  dueDateInputRef.current?.click();
                }}
              >
                {task.due_date
                  ? new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  : 'Set due date'}
              </span>
              <input
                ref={dueDateInputRef}
                type="date"
                value={task.due_date ? new Date(task.due_date).toISOString().split('T')[0] : ''}
                onChange={(e) => handleFieldUpdate('due_date', e.target.value || null)}
                className="w-0 h-0 opacity-0 absolute"
                tabIndex={-1}
              />
            </div>

            {/* Secondary fields — hidden on mobile until expanded */}
            {(!isMobile || metadataExpanded) && (
              <>
                {/* Estimation */}
                <span className="text-[12px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
                  Size
                </span>
                <div className="flex gap-1 flex-wrap">
                  {['XS', 'S', 'M', 'L', 'XL'].map(size => (
                    <button key={size} onClick={() => handleFieldUpdate('estimation', size.toLowerCase())}
                      className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors"
                      style={{
                        background: task.estimation === size.toLowerCase() ? 'var(--accent)' : 'var(--surface-container-low)',
                        color: task.estimation === size.toLowerCase() ? 'white' : 'var(--muted)',
                        fontFamily: 'var(--font-heading)',
                      }}>
                      {size}
                    </button>
                  ))}
                  {task.estimation && (
                    <button onClick={() => handleFieldUpdate('estimation', null)}
                      className="px-1 py-0.5 rounded text-[10px]"
                      style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                      ×
                    </button>
                  )}
                </div>

                {/* Start Date */}
                <span className="text-[12px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
                  <Calendar size={12} className="inline mr-1" />
                  Start date
                </span>
                <div className="flex items-center gap-1 relative">
                  <span
                    className="text-[13px] px-2 py-1 cursor-pointer rounded-md"
                    style={{
                      color: task.start_date ? 'var(--foreground)' : 'var(--muted)',
                      fontFamily: 'var(--font-body)',
                    }}
                    onClick={() => {
                      startDateInputRef.current?.showPicker?.();
                      startDateInputRef.current?.click();
                    }}
                  >
                    {task.start_date
                      ? new Date(task.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                      : 'Set start date'}
                  </span>
                  <input
                    ref={startDateInputRef}
                    type="date"
                    value={task.start_date ? new Date(task.start_date).toISOString().split('T')[0] : ''}
                    onChange={(e) => handleFieldUpdate('start_date', e.target.value || null)}
                    className="w-0 h-0 opacity-0 absolute"
                    tabIndex={-1}
                  />
                </div>

                {/* Created date */}
                <span className="text-[12px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
                  <Calendar size={12} className="inline mr-1" />
                  Created
                </span>
                <span className="text-[13px]" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}>
                  {new Date(task.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>

                {/* Labels */}
                <span className="text-[12px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
                  <Tag size={12} className="inline mr-1" />
                  Labels
                </span>
                <div className="flex flex-wrap gap-1">
                  {task.labels.length > 0 ? (
                    task.labels.map((label) => (
                      <span
                        key={label.id}
                        className="text-[11px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                        style={{
                          background: `${label.color}20`,
                          color: label.color,
                        }}
                      >
                        {label.name}
                        <button
                          onClick={async () => {
                            await api.delete(`/api/tasks/${taskId}/labels/${label.id}`);
                            loadTask();
                          }}
                          className="hover:opacity-70"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))
                  ) : (
                    <span className="text-[13px]" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                      None
                    </span>
                  )}
                </div>

                {/* Tags */}
                <span className="text-[12px] font-medium" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
                  <Hash size={12} className="inline mr-1" />
                  Tags
                </span>
                <TagPicker
                  entityType="task"
                  entityId={taskId}
                  appliedTags={taskTags}
                  onTagsChange={setTaskTags}
                />
              </>
            )}
          </div>

          {/* Mobile expand/collapse toggle */}
          {isMobile && (
            <button
              onClick={() => setMetadataExpanded(!metadataExpanded)}
              className="w-full text-center py-1.5 text-[11px] font-medium"
              style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
            >
              {metadataExpanded
                ? <><ChevronUp size={11} className="inline" /> Less details</>
                : <><ChevronDown size={11} className="inline" /> More details</>
              }
            </button>
          )}

          {/* Description */}
          <div className="px-5 pb-4" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
            <h3
              className="text-[12px] font-semibold mb-2 uppercase tracking-wide"
              style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
            >
              Description
            </h3>
            <DescriptionEditor
              value={descValue}
              onChange={(html) => {
                setDescValue(html);
                // Auto-save after editing
                clearTimeout(titleDebounce.current);
                titleDebounce.current = setTimeout(async () => {
                  if (task) {
                    const res = await api.patch(`/api/tasks/${taskId}`, { description: html || null });
                    if (res.ok) {
                      const apiResult = await res.json();
                      const merged = { ...task, ...apiResult };
                      setTask(merged);
                      onUpdated(merged);
                    }
                  }
                }, 800);
              }}
            />
          </div>

          {/* Attachments */}
          <div className="px-5 pb-4" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide flex items-center gap-1.5"
                style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
                <Paperclip size={13} />
                Attachments
                {attachments.length > 0 && (
                  <span className="text-[11px] font-normal ml-1" style={{ color: 'var(--muted)' }}>
                    {attachments.length}
                  </span>
                )}
              </h3>
              <button onClick={() => attachFileRef.current?.click()}
                className="text-[11px] font-medium flex items-center gap-1 px-1.5 py-0.5 rounded"
                style={{ color: 'var(--accent)', fontFamily: 'var(--font-heading)' }}>
                <Upload size={11} /> Add file
              </button>
              <input ref={attachFileRef} type="file" className="hidden" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file || !task) return;
                try {
                  const res = await api.upload(`/api/upload?task_id=${task.id}`, file);
                  if (res.ok) {
                    const data = await res.json();
                    setAttachments(prev => [...prev, {
                      id: data.id,
                      filename: data.name || file.name,
                      mime_type: data.type || file.type,
                      size_bytes: data.size || file.size,
                      storage_key: data.url || data.id,
                      created_at: new Date().toISOString(),
                    }]);
                  } else {
                    console.error('Upload failed:', await res.text());
                  }
                } catch (err) {
                  console.error('Upload error:', err);
                }
                e.target.value = '';
              }} />
            </div>
            {attachments.length > 0 ? (
              <div className="space-y-1.5">
                {attachments.map((file) => (
                  <div key={file.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md"
                    style={{ background: 'var(--surface-container-highest)' }}>
                    <Paperclip size={12} style={{ color: 'var(--muted)' }} />
                    <a href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/files/${file.id}`} target="_blank" rel="noopener noreferrer"
                      className="text-[12px] flex-1 truncate hover:underline"
                      style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}>
                      {file.filename}
                    </a>
                    <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--muted)' }}>
                      {file.size_bytes < 1024 ? `${file.size_bytes} B` : file.size_bytes < 1048576 ? `${(file.size_bytes / 1024).toFixed(1)} KB` : `${(file.size_bytes / 1048576).toFixed(1)} MB`}
                    </span>
                    <button onClick={async () => {
                      await api.delete(`/api/files/${file.id}`);
                      setAttachments(prev => prev.filter(f => f.id !== file.id));
                    }} className="p-0.5 rounded hover:opacity-70" style={{ color: 'var(--muted)' }}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px]" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                No attachments yet
              </p>
            )}
          </div>

          {/* Subtasks section (only for non-subtasks) */}
          {!task.parent_task_id && (
            <div className="px-5 pb-4" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
              <div className="flex items-center justify-between mb-2">
                <h3
                  className="text-[12px] font-semibold uppercase tracking-wide flex items-center gap-1.5"
                  style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
                >
                  <ListChecks size={13} />
                  Subtasks
                  {subtasks.length > 0 && (
                    <span className="text-[11px] font-normal ml-1" style={{ color: 'var(--muted)' }}>
                      {subtasks.filter((s) => s.status === 'done').length}/{subtasks.length}
                    </span>
                  )}
                </h3>
                <button
                  onClick={() => setAddingSubtask(true)}
                  className="text-[11px] font-medium flex items-center gap-1 px-1.5 py-0.5 rounded"
                  style={{
                    color: 'var(--accent)',
                    fontFamily: 'var(--font-heading)',
                    transition: 'background 150ms',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <Plus size={12} />
                  Add
                </button>
              </div>

              {/* Subtask progress bar */}
              {subtasks.length > 0 && (
                <div className="mb-2">
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(subtasks.filter((s) => s.status === 'done').length / subtasks.length) * 100}%`,
                        background: subtasks.every((s) => s.status === 'done') ? 'var(--success)' : 'var(--accent)',
                        transition: 'width 200ms',
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Subtask list */}
              <div className="flex flex-col gap-0.5">
                {subtasks.map((subtask) => (
                  <div
                    key={subtask.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md group/subtask"
                    style={{ transition: 'background 100ms' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {/* Checkbox */}
                    <button
                      onClick={() => handleToggleSubtaskStatus(subtask)}
                      className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                      style={{
                        border: subtask.status === 'done' ? 'none' : '1.5px solid var(--border)',
                        background: subtask.status === 'done' ? 'var(--success)' : 'transparent',
                        transition: 'all 150ms',
                      }}
                    >
                      {subtask.status === 'done' && <Check size={10} strokeWidth={3} style={{ color: 'white' }} />}
                    </button>

                    {/* Title - clickable to navigate */}
                    <button
                      onClick={() => onTaskNavigate?.(subtask.id)}
                      className="flex-1 text-left text-[13px] truncate"
                      style={{
                        color: subtask.status === 'done' ? 'var(--muted)' : 'var(--foreground)',
                        fontFamily: 'var(--font-body)',
                        textDecoration: subtask.status === 'done' ? 'line-through' : 'none',
                      }}
                    >
                      {subtask.title}
                    </button>

                    {/* Priority dot */}
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{
                        background:
                          subtask.priority === 'p0' ? '#DC2626' :
                          subtask.priority === 'p1' ? '#F59E0B' :
                          subtask.priority === 'p2' ? '#3B82F6' : '#6B7280',
                      }}
                    />

                    {/* Assignee avatar */}
                    {subtask.assignee_name && (
                      <div
                        className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-medium text-white flex-shrink-0"
                        style={{ background: 'var(--accent)' }}
                        title={subtask.assignee_name}
                      >
                        {subtask.assignee_name.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Inline add subtask */}
              {addingSubtask && (
                <div className="flex items-center gap-2 mt-1 px-2">
                  <div className="w-4 h-4 rounded flex-shrink-0" style={{ border: '1.5px solid var(--border)' }} />
                  <input
                    autoFocus
                    value={newSubtaskTitle}
                    onChange={(e) => setNewSubtaskTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddSubtask();
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setAddingSubtask(false);
                        setNewSubtaskTitle('');
                      }
                    }}
                    onBlur={() => {
                      if (!newSubtaskTitle.trim()) {
                        setAddingSubtask(false);
                        setNewSubtaskTitle('');
                      }
                    }}
                    placeholder="Subtask title..."
                    className="flex-1 text-[13px] bg-transparent outline-none"
                    style={{
                      color: 'var(--foreground)',
                      fontFamily: 'var(--font-body)',
                    }}
                    disabled={creatingSubtask}
                  />
                  {creatingSubtask ? (
                    <Loader2 size={12} className="animate-spin" style={{ color: 'var(--muted)' }} />
                  ) : newSubtaskTitle.trim() ? (
                    <button
                      onClick={(e) => { e.preventDefault(); handleAddSubtask(); }}
                      className="flex-shrink-0 p-1 rounded"
                      style={{ color: 'var(--accent)' }}
                      title="Add subtask"
                    >
                      <Plus size={14} />
                    </button>
                  ) : null}
                </div>
              )}

              {subtasks.length === 0 && !addingSubtask && (
                <p className="text-[12px] px-2" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                  No subtasks yet
                </p>
              )}
            </div>
          )}

          {/* Parent task breadcrumb (if this is a subtask) */}
          {parentTask && (
            <div className="px-5 pb-3" style={{ borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
              <button
                onClick={() => onTaskNavigate?.(parentTask.id)}
                className="flex items-center gap-1.5 text-[12px] font-medium px-2 py-1 rounded-md"
                style={{
                  color: 'var(--accent)',
                  fontFamily: 'var(--font-heading)',
                  transition: 'background 150ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <ChevronLeft size={14} />
                Back to {parentTask.project_prefix}-{parentTask.number}: {parentTask.title}
              </button>
            </div>
          )}

          {/* Dependencies section */}
          <div className="px-5 pb-4" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
            <div className="flex items-center justify-between mb-2">
              <h3
                className="text-[12px] font-semibold uppercase tracking-wide flex items-center gap-1.5"
                style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
              >
                <Link2 size={13} />
                Dependencies
              </h3>
              <button
                onClick={() => setAddingDependency(true)}
                className="text-[11px] font-medium flex items-center gap-1 px-1.5 py-0.5 rounded"
                style={{
                  color: 'var(--accent)',
                  fontFamily: 'var(--font-heading)',
                  transition: 'background 150ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <Plus size={12} />
                Add
              </button>
            </div>

            {/* Blocked by list */}
            {dependencies.blocked_by.length > 0 && (
              <div className="mb-2">
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider mb-1 block"
                  style={{ color: 'var(--danger)', fontFamily: 'var(--font-heading)' }}
                >
                  Blocked by
                </span>
                <div className="flex flex-col gap-0.5">
                  {dependencies.blocked_by.map((dep) => (
                    <div
                      key={dep.relationship_id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md group/dep"
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Lock size={11} style={{ color: 'var(--danger)' }} className="flex-shrink-0" />
                      <span
                        className="text-[11px] font-medium px-1.5 py-0.5 rounded"
                        style={{
                          background: 'var(--surface)',
                          color: 'var(--muted)',
                          fontFamily: 'var(--font-heading)',
                        }}
                      >
                        {dep.project_prefix}-{dep.number}
                      </span>
                      <button
                        onClick={() => onTaskNavigate?.(dep.task_id)}
                        className="flex-1 text-left text-[12px] truncate"
                        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                      >
                        {dep.title}
                      </button>
                      <div
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: STATUS_COLORS[dep.status] || 'var(--muted)' }}
                      />
                      <button
                        onClick={() => handleRemoveDependency(dep.relationship_id)}
                        className="opacity-0 group-hover/dep:opacity-100 p-0.5 rounded"
                        style={{ color: 'var(--muted)', transition: 'opacity 150ms' }}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Blocks list */}
            {dependencies.blocks.length > 0 && (
              <div className="mb-2">
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider mb-1 block"
                  style={{ color: 'var(--accent)', fontFamily: 'var(--font-heading)' }}
                >
                  Blocks
                </span>
                <div className="flex flex-col gap-0.5">
                  {dependencies.blocks.map((dep) => (
                    <div
                      key={dep.relationship_id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md group/dep"
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span
                        className="text-[11px] font-medium px-1.5 py-0.5 rounded"
                        style={{
                          background: 'var(--surface)',
                          color: 'var(--muted)',
                          fontFamily: 'var(--font-heading)',
                        }}
                      >
                        {dep.project_prefix}-{dep.number}
                      </span>
                      <button
                        onClick={() => onTaskNavigate?.(dep.task_id)}
                        className="flex-1 text-left text-[12px] truncate"
                        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                      >
                        {dep.title}
                      </button>
                      <div
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: STATUS_COLORS[dep.status] || 'var(--muted)' }}
                      />
                      <button
                        onClick={() => handleRemoveDependency(dep.relationship_id)}
                        className="opacity-0 group-hover/dep:opacity-100 p-0.5 rounded"
                        style={{ color: 'var(--muted)', transition: 'opacity 150ms' }}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Relates to list */}
            {dependencies.relates_to.length > 0 && (
              <div className="mb-2">
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider mb-1 block"
                  style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-heading)' }}
                >
                  Related
                </span>
                <div className="flex flex-col gap-0.5">
                  {dependencies.relates_to.map((dep) => (
                    <div
                      key={dep.relationship_id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md group/dep"
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span
                        className="text-[11px] font-medium px-1.5 py-0.5 rounded"
                        style={{
                          background: 'var(--surface)',
                          color: 'var(--muted)',
                          fontFamily: 'var(--font-heading)',
                        }}
                      >
                        {dep.project_prefix}-{dep.number}
                      </span>
                      <button
                        onClick={() => onTaskNavigate?.(dep.task_id)}
                        className="flex-1 text-left text-[12px] truncate"
                        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                      >
                        {dep.title}
                      </button>
                      <div
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: STATUS_COLORS[dep.status] || 'var(--muted)' }}
                      />
                      <button
                        onClick={() => handleRemoveDependency(dep.relationship_id)}
                        className="opacity-0 group-hover/dep:opacity-100 p-0.5 rounded"
                        style={{ color: 'var(--muted)', transition: 'opacity 150ms' }}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {dependencies.blocks.length === 0 && dependencies.blocked_by.length === 0 && dependencies.relates_to.length === 0 && !addingDependency && (
              <p className="text-[12px] px-2" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                No dependencies
              </p>
            )}

            {/* Add dependency inline */}
            {addingDependency && (
              <div className="mt-2 rounded-lg p-3" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
                {/* Type selector */}
                <div className="flex items-center gap-1 mb-2">
                  {(['blocked_by', 'blocks', 'relates_to'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setDepType(t)}
                      className="text-[11px] font-medium px-2 py-1 rounded"
                      style={{
                        background: depType === t ? 'var(--accent-subtle)' : 'transparent',
                        color: depType === t ? 'var(--accent)' : 'var(--muted)',
                        fontFamily: 'var(--font-heading)',
                        transition: 'all 150ms',
                      }}
                    >
                      {t === 'blocked_by' ? 'Blocked by' : t === 'blocks' ? 'Blocks' : 'Relates to'}
                    </button>
                  ))}
                </div>

                {/* Search input */}
                <div className="relative">
                  <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
                  <input
                    autoFocus
                    value={depSearchQuery}
                    onChange={(e) => handleDepSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setAddingDependency(false);
                        setDepSearchQuery('');
                        setDepSearchResults([]);
                      }
                    }}
                    placeholder="Search tasks by title or ID..."
                    className="w-full text-[12px] bg-transparent outline-none pl-7 pr-2 py-1.5 rounded"
                    style={{
                      color: 'var(--foreground)',
                      fontFamily: 'var(--font-body)',
                      border: '1px solid var(--border)',
                    }}
                  />
                </div>

                {/* Search results */}
                {depSearchResults.length > 0 && (
                  <div className="mt-1 flex flex-col gap-0.5 max-h-32 overflow-y-auto">
                    {depSearchResults.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => handleAddDependency(r.id)}
                        className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-[12px]"
                        style={{
                          color: 'var(--foreground)',
                          fontFamily: 'var(--font-body)',
                          transition: 'background 100ms',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <span
                          className="text-[10px] font-medium px-1 py-0.5 rounded"
                          style={{ background: 'var(--surface)', color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
                        >
                          {r.project_prefix}-{r.number}
                        </span>
                        <span className="truncate">{r.title}</span>
                        <div
                          className="w-2 h-2 rounded-full flex-shrink-0 ml-auto"
                          style={{ background: STATUS_COLORS[r.status] || 'var(--muted)' }}
                        />
                      </button>
                    ))}
                  </div>
                )}

                {searchingDeps && (
                  <div className="flex items-center justify-center py-2">
                    <Loader2 size={12} className="animate-spin" style={{ color: 'var(--muted)' }} />
                  </div>
                )}

                {depSearchQuery.length >= 2 && depSearchResults.length === 0 && !searchingDeps && (
                  <p className="text-[11px] py-2 text-center" style={{ color: 'var(--muted)' }}>
                    No matching tasks found
                  </p>
                )}

                <div className="flex justify-end mt-2">
                  <button
                    onClick={() => { setAddingDependency(false); setDepSearchQuery(''); setDepSearchResults([]); }}
                    className="text-[11px] font-medium px-2 py-1 rounded"
                    style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* References (backlinks) */}
          {references.length > 0 && (
            <div className="px-5 pb-4" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
              <h3 className="text-[12px] font-semibold mb-2 uppercase tracking-wide flex items-center gap-1.5"
                style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>
                <Link2 size={12} />
                Referenced in {references.length} message{references.length !== 1 ? 's' : ''}
              </h3>
              <div className="space-y-1.5">
                {references.map(ref => (
                  <div key={ref.id}
                    onClick={() => {
                      if (ref.message_space_id) {
                        router.push(`/chat?space=${ref.message_space_id}&message=${ref.source_id}`);
                      }
                    }}
                    className="flex items-start gap-2.5 px-3 py-2 rounded-lg cursor-pointer hover:bg-white/[0.03] transition-colors"
                    style={{ background: 'var(--surface-container)' }}>
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-medium text-white flex-shrink-0 mt-0.5"
                      style={{ background: 'var(--primary-container)' }}>
                      {ref.author_name?.charAt(0).toUpperCase() || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
                          {ref.author_name || 'Unknown'}
                        </span>
                        {ref.space_name && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded"
                            style={{ background: 'var(--surface-container-high)', color: 'var(--muted)' }}>
                            #{ref.space_name}
                          </span>
                        )}
                      </div>
                      {ref.message_preview && (
                        <p className="text-[11px] truncate" style={{ color: 'var(--muted)', lineHeight: '1.4' }}>
                          {ref.message_preview}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tabs: Comments | Activity */}
          <div style={{ borderTop: '1px solid var(--border)' }}>
            <div className="flex px-5" style={{ borderBottom: '1px solid var(--border)' }}>
              <button
                onClick={() => setActiveTab('comments')}
                className="flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium"
                style={{
                  color: activeTab === 'comments' ? 'var(--accent)' : 'var(--muted)',
                  borderBottom: activeTab === 'comments' ? '2px solid var(--accent)' : '2px solid transparent',
                  fontFamily: 'var(--font-heading)',
                  transition: 'color 150ms',
                }}
              >
                <MessageSquare size={13} />
                Comments
              </button>
              <button
                onClick={() => setActiveTab('activity')}
                className="flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium"
                style={{
                  color: activeTab === 'activity' ? 'var(--accent)' : 'var(--muted)',
                  borderBottom: activeTab === 'activity' ? '2px solid var(--accent)' : '2px solid transparent',
                  fontFamily: 'var(--font-heading)',
                  transition: 'color 150ms',
                }}
              >
                <Activity size={13} />
                Activity
              </button>
            </div>

            <div className="px-5 py-3">
              {activeTab === 'comments' ? (
                <div className="flex flex-col gap-3">
                  {comments.length === 0 && (
                    <p className="text-[13px] py-4 text-center" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                      No comments yet
                    </p>
                  )}
                  {comments.map((c) => (
                    <div key={c.id} className="flex gap-2.5">
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white flex-shrink-0 mt-0.5"
                        style={{ background: 'var(--accent)' }}
                      >
                        {c.user_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className="text-[12px] font-semibold"
                            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
                          >
                            {c.user_name}
                          </span>
                          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                            {new Date(c.created_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <div
                          className="deft-editor text-[13px] mt-0.5"
                          dangerouslySetInnerHTML={{ __html: c.content }}
                        />
                      </div>
                    </div>
                  ))}

                  {/* Add comment */}
                  <div className="flex gap-2 mt-2">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white flex-shrink-0 mt-1"
                      style={{ background: 'var(--accent)' }}
                    >
                      {user?.name?.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1">
                      <div
                        className="rounded-lg overflow-hidden"
                        style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border)' }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            handleAddComment();
                          }
                        }}
                      >
                        <div className="px-3 py-2 min-h-[80px] max-h-[200px] overflow-y-auto">
                          <EditorContent editor={commentEditor} />
                        </div>
                      </div>
                      <div className="flex justify-end mt-1.5">
                        <button
                          onClick={handleAddComment}
                          disabled={!(commentEditor?.getText() ?? '').trim() || submittingComment}
                          className="text-[12px] font-medium px-3 py-1 rounded-md text-white disabled:opacity-50"
                          style={{
                            background: 'var(--accent)',
                            fontFamily: 'var(--font-heading)',
                            transition: 'opacity 150ms',
                          }}
                        >
                          {submittingComment ? 'Sending...' : 'Comment'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {activity.length === 0 && (
                    <p className="text-[13px] py-4 text-center" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                      No activity yet
                    </p>
                  )}
                  {activity.map((a) => {
                    const dotColor = a.field === 'status' ? '#3B82F6'
                      : a.field === 'assignee_id' ? '#8B5CF6'
                      : a.field === 'priority' ? '#F97316'
                      : a.field === 'comment' ? '#22C55E'
                      : 'var(--muted)';
                    return (
                    <div key={a.id} className="flex items-start gap-2.5 text-[12px]">
                      <div
                        className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                        style={{ background: dotColor }}
                      />
                      <div>
                        <span style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', fontWeight: 600 }}>
                          {a.user_name}
                        </span>{' '}
                        <span style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}>
                          changed {formatFieldName(a.field)} from{' '}
                          <span style={{ color: 'var(--muted)' }}>{formatActivityValue(a.field, a.old_value, members)}</span> to{' '}
                          <span style={{ color: 'var(--foreground)' }}>{formatActivityValue(a.field, a.new_value, members)}</span>
                        </span>
                        <div className="mt-0.5" style={{ color: 'var(--muted)' }}>
                          {new Date(a.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </div>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
