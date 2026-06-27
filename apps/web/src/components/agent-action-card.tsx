'use client';

import { useState } from 'react';
import { ReceiptViewer } from './receipt-viewer';
import { humanizeToolName } from '@/lib/tool-display';
import { stripHtml } from '@/lib/strip-html';

export type AgentAction = {
  id: string;
  action: string;
  params: Record<string, any>;
  status?: string;
  approval_status?: string;
  error?: string | null;
  created_at?: string;
  executed_at?: string;
  has_receipt?: boolean;
};

type LocalStatus = 'approving' | 'rejecting' | 'approved' | 'rejected' | null;
export type AgentActionMutationResult = {
  status?: string;
  approval_status?: string;
  success?: boolean;
} | void;

const ACTION_LABELS: Record<string, string> = {
  create_task: 'Create task',
  task_create: 'Create task',
  task_update: 'Update task',
  memory_update: 'Update memory',
  update_task_status: 'Update status',
  assign_task: 'Assign task',
  post_message: 'Post message',
};

const CAPTURE_LABELS: Record<string, string> = {
  task_candidate: 'Defty captured this as possible work from chat',
  blocker_candidate: 'Defty captured this as a possible blocker from chat',
};

const INTENT_STATUS_LABELS: Record<string, string> = {
  proposed: 'Intent proposed',
  converted: 'Intent converted',
  dismissed: 'Intent dismissed',
  expired: 'Intent expired',
  failed: 'Intent failed',
};

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

function InlineSpinner() {
  return (
    <div className="relative flex items-center justify-center w-4 h-4 flex-shrink-0">
      <div
        className="absolute w-4 h-4 rounded-full border-2 border-t-transparent animate-spin"
        style={{ borderColor: 'var(--primary)', borderTopColor: 'transparent' }}
      />
    </div>
  );
}

export function AgentActionCard({
  action,
  onApprove,
  onReject,
  onUndo,
}: {
  action: AgentAction;
  onApprove: () => AgentActionMutationResult | Promise<AgentActionMutationResult>;
  onReject: () => AgentActionMutationResult | Promise<AgentActionMutationResult>;
  onUndo?: () => void;
}) {
  const [localStatus, setLocalStatus] = useState<LocalStatus>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  const humanized = humanizeToolName(action.action);
  const displayLabel = ACTION_LABELS[action.action] ?? humanized.full;
  const title = stripHtml(action.params.title);
  const content = stripHtml(action.params.content);
  const captureLabel = typeof action.params.capture_kind === 'string'
    ? CAPTURE_LABELS[action.params.capture_kind] ?? null
    : null;
  const isCapture = Boolean(captureLabel || action.params.proposed_by === 'defty' || action.params.source_message_id);
  const captureReason = stripHtml(action.params.capture_reason ?? action.params.policy_reason ?? '');
  const workIntentStatus = typeof action.params.work_intent_status === 'string'
    ? INTENT_STATUS_LABELS[action.params.work_intent_status] ?? null
    : null;
  const sourceMessageId = typeof action.params.source_message_id === 'string' ? action.params.source_message_id : null;
  const sourceSpaceId = typeof action.params.source_space_id === 'string'
    ? action.params.source_space_id
    : typeof action.params.space_id === 'string'
      ? action.params.space_id
      : null;
  const serverStatus = action.status ?? action.approval_status ?? 'pending';
  const resolvedStatus = localStatus ?? serverStatus;
  const isBusy = resolvedStatus === 'approving' || resolvedStatus === 'rejecting' || resolvedStatus === 'executing';
  const hasReceipt = Boolean(action.has_receipt || resolvedStatus === 'approved' || resolvedStatus === 'rejected');
  const createdAtMs = action.created_at ? new Date(action.created_at).getTime() : null;
  const isPossiblyStale = resolvedStatus === 'pending' && createdAtMs != null && Date.now() - createdAtMs > 60 * 60 * 1000;

  async function handleApprove() {
    if (isBusy) return;
    setLocalError(null);
    setLocalStatus('approving');
    try {
      const result = await onApprove();
      const status = normalizeReturnedStatus(result, 'approved');
      setLocalStatus(status);
    } catch (err) {
      setLocalStatus(null);
      setLocalError(err instanceof Error ? err.message : 'Approval failed.');
    }
  }

  async function handleReject() {
    if (isBusy) return;
    setLocalError(null);
    setLocalStatus('rejecting');
    try {
      const result = await onReject();
      const status = normalizeReturnedStatus(result, 'rejected');
      setLocalStatus(status);
    } catch (err) {
      setLocalStatus(null);
      setLocalError(err instanceof Error ? err.message : 'Rejection failed.');
    }
  }

  if (resolvedStatus === 'executing' || resolvedStatus === 'approving' || resolvedStatus === 'rejecting') {
    const verb = resolvedStatus === 'rejecting'
      ? 'Rejecting'
      : resolvedStatus === 'approving'
        ? 'Approving'
        : 'Executing';
    return (
      <div
        className="rounded-lg px-3 py-2 mt-2 text-[12px] flex items-center gap-2.5"
        style={{ background: 'rgba(124,107,79,0.08)', border: '1px solid rgba(124,107,79,0.15)', color: 'var(--on-surface-variant)' }}
      >
        <InlineSpinner />
        <span className="font-medium">{verb} {displayLabel.toLowerCase()}...</span>
      </div>
    );
  }

  if (resolvedStatus === 'approved') {
    const canUndo = action.executed_at && (Date.now() - new Date(action.executed_at).getTime() < 5 * 60 * 1000);
    return (
      <>
        <div
          className="rounded-lg px-3 py-2 mt-2 text-[12px] flex items-center gap-2 flex-wrap"
          style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: 'var(--success)' }}
        >
          <span>{displayLabel} done</span>
          {hasReceipt && (
            <button onClick={() => setShowReceipt(true)} className="text-[11px] underline ml-1" style={{ color: 'var(--muted)' }}>
              View receipt
            </button>
          )}
          {canUndo && onUndo && (
            <button onClick={onUndo} className="text-[11px] underline ml-1" style={{ color: 'var(--muted)' }}>
              Undo
            </button>
          )}
        </div>
        <ReceiptViewer actionId={action.id} isOpen={showReceipt} onClose={() => setShowReceipt(false)} />
      </>
    );
  }

  if (resolvedStatus === 'failed') {
    return (
      <div
        className="rounded-lg px-3 py-2 mt-2 text-[12px]"
        style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: 'var(--status-red)' }}
      >
        {displayLabel} failed{action.error ? `: ${stripHtml(action.error).slice(0, 120)}` : ''}
      </div>
    );
  }

  if (resolvedStatus === 'expired') {
    return (
      <div
        className="rounded-lg px-3 py-2 mt-2 text-[12px]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}
      >
        {displayLabel} expired before review.
      </div>
    );
  }

  if (resolvedStatus === 'undone') {
    return (
      <div
        className="rounded-lg px-3 py-2 mt-2 text-[12px]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}
      >
        {displayLabel} undone
      </div>
    );
  }

  if (resolvedStatus === 'rejected') {
    return (
      <>
        <div
          className="rounded-lg px-3 py-2 mt-2 text-[12px] flex items-center gap-2 flex-wrap"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}
        >
          <span>{displayLabel} rejected</span>
          {hasReceipt && (
            <button onClick={() => setShowReceipt(true)} className="text-[11px] underline ml-1" style={{ color: 'var(--muted)' }}>
              View receipt
            </button>
          )}
        </div>
        <ReceiptViewer actionId={action.id} isOpen={showReceipt} onClose={() => setShowReceipt(false)} />
      </>
    );
  }

  return (
    <div
      className="p-3 mt-2 max-w-[420px] w-full"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: '8px' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {isCapture ? 'Work capture' : displayLabel}
          </p>
          {isCapture && (
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
              Proposed action: {displayLabel.toLowerCase()}
            </p>
          )}
        </div>
        {isCapture && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap"
            style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}
          >
            {isPossiblyStale ? 'Review age' : 'Needs approval'}
          </span>
        )}
      </div>

      {captureLabel && (
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
          {captureLabel}
        </p>
      )}

      <div className="text-[12px] mt-1 space-y-0.5" style={{ color: 'var(--foreground-secondary)' }}>
        {action.action in ACTION_LABELS ? (
          <>
            {title && <p>"{title}"</p>}
            {action.params.project_name && <p>{action.params.project_name}</p>}
            {(action.params.priority || action.params.assignee_name) && (
              <p>{[action.params.priority?.toUpperCase(), action.params.assignee_name].filter(Boolean).join(' - ')}</p>
            )}
            {content && <p>"{content.slice(0, 80)}{content.length > 80 ? '...' : ''}"</p>}
            {action.params.space_name && <p>in #{action.params.space_name}</p>}
          </>
        ) : (
          <GenericParams params={action.params} />
        )}
        {captureReason && (
          <p style={{ color: 'var(--muted)' }}>
            Reason: {captureReason.slice(0, 120)}{captureReason.length > 120 ? '...' : ''}
          </p>
        )}
        {workIntentStatus && (
          <p style={{ color: 'var(--muted)' }}>
            Ledger: {workIntentStatus}
          </p>
        )}
        {sourceMessageId && sourceSpaceId && (
          <p>
            <a
              href={`/chat?space=${sourceSpaceId}&message=${sourceMessageId}`}
              className="underline underline-offset-2"
              style={{ color: 'var(--primary)' }}
            >
              View source message
            </a>
          </p>
        )}
        {isPossiblyStale && (
          <p style={{ color: 'var(--muted)' }}>
            This capture is older than an hour. Check the source before approving.
          </p>
        )}
        {localError && (
          <p style={{ color: 'var(--status-red)' }}>
            {localError}
          </p>
        )}
      </div>

      <div className="flex gap-2 mt-2.5 flex-wrap">
        <button
          onClick={handleApprove}
          disabled={isBusy}
          className="px-3 py-1 rounded-md text-[11px] font-medium text-white disabled:opacity-60"
          style={{ background: 'var(--status-green)' }}
        >
          Approve
        </button>
        <button
          onClick={handleReject}
          disabled={isBusy}
          className="px-3 py-1 rounded-md text-[11px] font-medium disabled:opacity-60"
          style={{ background: 'var(--bg-overlay)', color: 'var(--text-secondary)' }}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function normalizeReturnedStatus(
  result: AgentActionMutationResult,
  fallback: 'approved' | 'rejected',
): 'approved' | 'rejected' {
  if (result && typeof result === 'object') {
    const status = result.status ?? result.approval_status;
    if (status === 'approved' || status === 'rejected') return status;
  }
  return fallback;
}
