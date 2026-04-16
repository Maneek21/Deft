'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { X, ChevronDown } from 'lucide-react';
import { statusLabel } from '@/lib/task-status-labels';

type Props = {
  projectId: string;
  defaultStatus?: string;
  initialTitle?: string;
  initialDescription?: string;
  sourceMessageId?: string;
  onClose: () => void;
  onCreated: () => void;
};

const STATUS_OPTIONS = [
  { value: 'backlog', label: statusLabel('backlog') },
  { value: 'todo', label: statusLabel('todo') },
  { value: 'in_progress', label: statusLabel('in_progress') },
  { value: 'in_review', label: statusLabel('in_review') },
];

const PRIORITY_OPTIONS = [
  { value: 'p0', label: 'P0', color: '#DC2626' },
  { value: 'p1', label: 'P1', color: '#F59E0B' },
  { value: 'p2', label: 'P2', color: '#3B82F6' },
  { value: 'p3', label: 'P3', color: '#6B7280' },
];

export function TaskQuickCreate({ projectId, defaultStatus, initialTitle, initialDescription, sourceMessageId, onClose, onCreated }: Props) {
  const [title, setTitle] = useState(initialTitle || '');
  const [status, setStatus] = useState(defaultStatus || 'backlog');
  const [priority, setPriority] = useState('p2');
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [description, setDescription] = useState(initialDescription || '');
  const [dueDate, setDueDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  useEffect(() => {
    async function load() {
      const res = await api.get('/api/members');
      if (res.ok) setMembers(await res.json());
    }
    load();
  }, []);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!title.trim() || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, any> = { title: title.trim() };
      if (description.trim()) body.description = description.trim();
      if (status && status !== 'backlog') body.status = status;
      if (priority && priority !== 'p2') body.priority = priority;
      if (assigneeId) body.assignee_id = assigneeId;
      if (dueDate) body.due_date = dueDate;
      if (sourceMessageId) body.source_message_id = sourceMessageId;
      // Strip any null/undefined values to avoid Zod validation issues
      for (const key of Object.keys(body)) {
        if (body[key] === null || body[key] === undefined) {
          delete body[key];
        }
      }
      const res = await api.post(`/api/projects/${projectId}/tasks`, body);

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to create task' }));
        throw new Error(data.error || 'Failed to create task');
      }

      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setSubmitting(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-start justify-center pt-[20vh]"
        onClick={onClose}
      >
        {/* Click-away for dropdowns */}
        {openDropdown && <div className="fixed inset-0 z-[51]" onClick={(e) => { e.stopPropagation(); setOpenDropdown(null); }} />}

        {/* Modal */}
        <div
          className="w-full max-w-[480px] rounded-xl p-0 z-[52]"
          style={{
            background: 'var(--card-bg)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-3"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <h3
              className="text-[14px] font-semibold"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
            >
              New task
            </h3>
            <button
              onClick={onClose}
              className="p-1 rounded-md"
              style={{ color: 'var(--muted)', transition: 'color 150ms' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
            >
              <X size={16} />
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            {/* Title */}
            <div className="px-5 pt-4 pb-3">
              <input
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
                className="w-full text-[15px] bg-transparent outline-none"
                style={{
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-body)',
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
              />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add a description..."
                rows={2}
                className="w-full mt-2 text-[13px] bg-transparent outline-none resize-none"
                style={{
                  color: 'var(--foreground-secondary)',
                  fontFamily: 'var(--font-body)',
                }}
              />
            </div>

            {/* Fields row */}
            <div className="px-5 pb-4 flex flex-wrap gap-2">
              {/* Status */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setOpenDropdown(openDropdown === 'status' ? null : 'status')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium"
                  style={{
                    border: '1px solid var(--border)',
                    color: 'var(--foreground-secondary)',
                    fontFamily: 'var(--font-heading)',
                    transition: 'all 150ms',
                  }}
                >
                  {STATUS_OPTIONS.find((s) => s.value === status)?.label}
                  <ChevronDown size={11} />
                </button>
                {openDropdown === 'status' && (
                  <div
                    className="absolute top-full left-0 mt-1 w-40 rounded-lg py-1 z-[60]"
                    style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                  >
                    {STATUS_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => { setStatus(opt.value); setOpenDropdown(null); }}
                        className="w-full text-left px-3 py-1.5 text-[12px]"
                        style={{
                          color: status === opt.value ? 'var(--accent)' : 'var(--foreground)',
                          fontFamily: 'var(--font-body)',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Priority */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setOpenDropdown(openDropdown === 'priority' ? null : 'priority')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium"
                  style={{
                    border: '1px solid var(--border)',
                    color: 'var(--foreground-secondary)',
                    fontFamily: 'var(--font-heading)',
                    transition: 'all 150ms',
                  }}
                >
                  <div className="w-2 h-2 rounded-full" style={{ background: PRIORITY_OPTIONS.find((p) => p.value === priority)?.color }} />
                  {PRIORITY_OPTIONS.find((p) => p.value === priority)?.label}
                  <ChevronDown size={11} />
                </button>
                {openDropdown === 'priority' && (
                  <div
                    className="absolute top-full left-0 mt-1 w-40 rounded-lg py-1 z-[60]"
                    style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                  >
                    {PRIORITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => { setPriority(opt.value); setOpenDropdown(null); }}
                        className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px]"
                        style={{
                          color: priority === opt.value ? 'var(--accent)' : 'var(--foreground)',
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

              {/* Assignee */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setOpenDropdown(openDropdown === 'assignee' ? null : 'assignee')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium"
                  style={{
                    border: '1px solid var(--border)',
                    color: 'var(--foreground-secondary)',
                    fontFamily: 'var(--font-heading)',
                    transition: 'all 150ms',
                  }}
                >
                  {assigneeId ? members.find((m) => m.id === assigneeId)?.name || 'Assignee' : 'Assignee'}
                  <ChevronDown size={11} />
                </button>
                {openDropdown === 'assignee' && (
                  <div
                    className="absolute top-full left-0 mt-1 w-48 rounded-lg py-1 z-[60]"
                    style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                  >
                    <button
                      type="button"
                      onClick={() => { setAssigneeId(null); setOpenDropdown(null); }}
                      className="w-full text-left px-3 py-1.5 text-[12px]"
                      style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      Unassigned
                    </button>
                    {members.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => { setAssigneeId(m.id); setOpenDropdown(null); }}
                        className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px]"
                        style={{
                          color: assigneeId === m.id ? 'var(--accent)' : 'var(--foreground)',
                          fontFamily: 'var(--font-body)',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <div
                          className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-medium text-white"
                          style={{ background: 'var(--accent)' }}
                        >
                          {m.name.charAt(0).toUpperCase()}
                        </div>
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Due date */}
              <div className="relative">
                {!dueDate && (
                  <span
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] font-medium pointer-events-none"
                    style={{
                      color: 'var(--muted)',
                      fontFamily: 'var(--font-heading)',
                    }}
                  >
                    Set due date
                  </span>
                )}
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="px-2.5 py-1 rounded-md text-[12px] bg-transparent outline-none"
                  style={{
                    border: '1px solid var(--border)',
                    color: dueDate ? 'var(--foreground-secondary)' : 'transparent',
                    fontFamily: 'var(--font-heading)',
                    minWidth: '110px',
                  }}
                />
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="px-5 pb-3">
                <p className="text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>
              </div>
            )}

            {/* Footer */}
            <div
              className="flex items-center justify-between px-5 py-3"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <span className="text-[11px]" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                Press Enter to create
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium"
                  style={{
                    color: 'var(--foreground-secondary)',
                    border: '1px solid var(--border)',
                    fontFamily: 'var(--font-heading)',
                    transition: 'background 150ms',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!title.trim() || submitting}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium text-white disabled:opacity-50"
                  style={{
                    background: 'var(--accent)',
                    fontFamily: 'var(--font-heading)',
                    transition: 'opacity 150ms',
                  }}
                >
                  {submitting ? 'Creating...' : 'Create task'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
