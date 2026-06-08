'use client';

import { humanizeToolName } from '@/lib/tool-display';
import { stripHtml } from '@/lib/strip-html';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentAction = {
  id: string;
  action: string;
  params: Record<string, any>;
  status?: string;
  executed_at?: string;
};

// ---------------------------------------------------------------------------
// GenericParams — fallback param renderer for unknown tool types
// ---------------------------------------------------------------------------

function GenericParams({ params }: { params: Record<string, any> }) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) {
    return <p style={{ opacity: 0.6 }}>(no parameters)</p>;
  }
  return (
    <div className="space-y-0.5">
      {entries.map(([k, v]) => {
        const isUrl = typeof v === 'string' && /^https?:\/\//.test(v);
        const display =
          typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : stripHtml(String(v)).slice(0, 120);
        return (
          <p key={k}>
            <span style={{ color: 'var(--muted)' }}>{k}:</span>{' '}
            {isUrl ? (
              <a href={v} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
                {display}
              </a>
            ) : (
              <span>{display}</span>
            )}
          </p>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentActionCard — per-action approve / reject card
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = {
  create_task: 'Create task',
  update_task_status: 'Update status',
  assign_task: 'Assign task',
  post_message: 'Post message',
};

export function AgentActionCard({ action, onApprove, onReject, onUndo }: {
  action: AgentAction;
  onApprove: () => void;
  onReject: () => void;
  onUndo?: () => void;
}) {
  const humanized = humanizeToolName(action.action);
  const displayLabel = ACTION_LABELS[action.action] ?? humanized.full;
  const title = stripHtml(action.params.title);
  const content = stripHtml(action.params.content);

  if (action.status === 'executing') {
    return (
      <div className="rounded-lg px-3 py-2 mt-2 text-[12px] flex items-center gap-2.5"
        style={{ background: 'rgba(124,107,79,0.08)', border: '1px solid rgba(124,107,79,0.15)', color: 'var(--on-surface-variant)' }}>
        <div className="relative flex items-center justify-center w-4 h-4 flex-shrink-0">
          <div className="absolute w-4 h-4 rounded-full border-2 border-t-transparent animate-spin"
            style={{ borderColor: 'var(--primary)', borderTopColor: 'transparent' }} />
        </div>
        <span className="font-medium">Executing {displayLabel.toLowerCase()}...</span>
      </div>
    );
  }
  if (action.status === 'approved') {
    const canUndo = action.executed_at && (Date.now() - new Date(action.executed_at).getTime() < 5 * 60 * 1000);
    return (
      <div className="rounded-lg px-3 py-2 mt-2 text-[12px] flex items-center gap-2"
        style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: 'var(--success)' }}>
        <span>{'✓'} {displayLabel} — done</span>
        {canUndo && onUndo && (
          <button onClick={onUndo} className="text-[11px] underline ml-2" style={{ color: 'var(--muted)' }}>
            Undo
          </button>
        )}
      </div>
    );
  }
  if (action.status === 'failed') {
    return (
      <div className="rounded-lg px-3 py-2 mt-2 text-[12px]"
        style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: 'var(--status-red)' }}>
        {'✗'} {displayLabel} - failed
      </div>
    );
  }
  if (action.status === 'undone') {
    return (
      <div className="rounded-lg px-3 py-2 mt-2 text-[12px]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
        {'↩'} {displayLabel} — undone
      </div>
    );
  }
  if (action.status === 'rejected') {
    return (
      <div className="rounded-lg px-3 py-2 mt-2 text-[12px]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
        ✗ {displayLabel} — rejected
      </div>
    );
  }

  return (
    <div className="p-3 mt-2 max-w-[380px] w-full"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: '8px' }}>
      <p className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
        {displayLabel}
      </p>
      <div className="text-[12px] mt-1 space-y-0.5" style={{ color: 'var(--foreground-secondary)' }}>
        {action.action in ACTION_LABELS ? (
          <>
            {title && <p>"{title}"</p>}
            {action.params.project_name && <p>{action.params.project_name}</p>}
            {(action.params.priority || action.params.assignee_name) && (
              <p>{[action.params.priority?.toUpperCase(), action.params.assignee_name].filter(Boolean).join(' · ')}</p>
            )}
            {content && <p>"{content.slice(0, 80)}{content.length > 80 ? '...' : ''}"</p>}
            {action.params.space_name && <p>in #{action.params.space_name}</p>}
          </>
        ) : (
          <GenericParams params={action.params} />
        )}
      </div>
      <div className="flex gap-2 mt-2.5">
        <button onClick={onApprove} className="px-3 py-1 rounded-md text-[11px] font-medium text-white"
          style={{ background: 'var(--status-green)' }}>Approve</button>
        <button onClick={onReject} className="px-3 py-1 rounded-md text-[11px] font-medium"
          style={{ background: 'var(--bg-overlay)', color: 'var(--text-secondary)' }}>Reject</button>
      </div>
    </div>
  );
}
