'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';

type Props = {
  messageId: string;
  taskTitle: string;
  taskDescription?: string | null;
  projectId: string;
  projectName?: string | null;
  priority?: string | null;
  agentName?: string | null;
  onCreate: () => Promise<void> | void;
  onEdit: () => void;
  onDismiss: () => void;
};

export function TaskSuggestionCard({
  taskTitle,
  taskDescription,
  projectName,
  priority,
  agentName,
  onCreate,
  onEdit,
  onDismiss,
}: Props) {
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await onCreate();
    } finally {
      setCreating(false);
    }
  };

  const suggesterLabel = agentName ? `${agentName} suggests` : 'Deft suggests';

  return (
    <div
      className="mt-2 rounded-lg px-3 py-2 flex items-start gap-3"
      style={{
        background: 'var(--surface-container)',
        border: '1px dashed var(--primary)',
      }}
      data-testid="task-suggestion-card"
    >
      <div
        className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5"
        style={{ background: 'var(--primary-container, var(--accent-muted))' }}
      >
        <Sparkles size={12} style={{ color: 'var(--primary)' }} />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-[11px] font-semibold mb-0.5"
          style={{ color: 'var(--primary)', fontFamily: 'var(--font-heading)' }}
        >
          {suggesterLabel}
        </div>
        <div
          className="text-[12px] truncate"
          style={{ color: 'var(--on-surface, var(--foreground))' }}
        >
          Create task &ldquo;{taskTitle}&rdquo;
        </div>
        {(projectName || priority) && (
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>
            {projectName ? `in ${projectName}` : ''}
            {projectName && priority ? ' · ' : ''}
            {priority || ''}
          </div>
        )}
        {taskDescription && (
          <div
            className="text-[11px] mt-1 line-clamp-2"
            style={{ color: 'var(--foreground-secondary, var(--muted))' }}
          >
            {taskDescription}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          className="px-2.5 py-1 rounded-md text-[11px] font-medium disabled:opacity-50"
          style={{ background: 'var(--primary)', color: '#fff' }}
          disabled={creating}
          onClick={handleCreate}
        >
          {creating ? 'Creating…' : 'Create'}
        </button>
        <button
          className="px-2.5 py-1 rounded-md text-[11px] font-medium"
          style={{
            border: '1px solid var(--border, var(--outline-variant))',
            color: 'var(--foreground-secondary, var(--foreground))',
            background: 'transparent',
          }}
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          className="px-2.5 py-1 rounded-md text-[11px] font-medium"
          style={{ color: 'var(--muted)', background: 'transparent' }}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
