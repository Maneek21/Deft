'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Info,
  ReceiptText,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { ReceiptViewer } from './receipt-viewer';
import { humanizeToolName } from '@/lib/tool-display';
import { stripHtml } from '@/lib/strip-html';

export type AgentAction = {
  id: string;
  action: string;
  params: Record<string, any>;
  result?: unknown;
  status?: string;
  approval_status?: string;
  error?: string | null;
  created_at?: string;
  executed_at?: string;
  has_receipt?: boolean;
  approval_tier?: 'auto' | 'quick' | 'full' | string | null;
  source?: string | null;
  employee_name?: string | null;
  proposer?: 'employee' | 'defty' | string | null;
};

type LocalStatus = 'approving' | 'rejecting' | 'approved' | 'rejected' | null;
export type AgentActionMutationResult = {
  status?: string;
  approval_status?: string;
  success?: boolean;
  result?: unknown;
} | void;

const ACTION_LABELS: Record<string, string> = {
  create_task: 'Create task',
  task_create: 'Create task',
  task_update: 'Update task',
  memory_update: 'Update memory',
  wiki_create: 'Save knowledge',
  update_task_status: 'Update status',
  assign_task: 'Assign task',
  post_message: 'Post message',
};

const CAPTURE_LABELS: Record<string, string> = {
  task_candidate: 'Source: chat message that sounds like follow-up work.',
  blocker_candidate: 'Source: chat message that sounds like a blocker.',
  decision_candidate: 'Source: chat message that sounds like a decision.',
  resource_candidate: 'Source: chat message that includes a useful resource.',
  note_candidate: 'Source: chat message that sounds like useful team memory.',
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

function getRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function getApprovedResult(value: unknown): Record<string, any> | null {
  const record = getRecord(value);
  if (!record) return null;
  const nested = getRecord(record.result);
  return nested ?? record;
}

function getCaptureHeadline(actionName: string, captureKind: unknown, fallbackLabel: string) {
  if (actionName === 'wiki_create') {
    if (captureKind === 'decision_candidate') return 'Defty wants to save this decision';
    if (captureKind === 'resource_candidate') return 'Defty wants to save this resource';
    if (captureKind === 'note_candidate') return 'Defty wants to save this as team memory';
    return 'Defty wants to save this knowledge';
  }
  if (actionName === 'task_create' || actionName === 'create_task') {
    if (captureKind === 'blocker_candidate') return 'Defty wants to create a blocker task';
    return 'Defty wants to create a task';
  }
  return `Defty wants to ${fallbackLabel.toLowerCase()}`;
}

function getApproveLabel(actionName: string, captureKind: unknown, fallbackLabel: string) {
  if (actionName === 'wiki_create') {
    if (captureKind === 'decision_candidate') return 'Save decision';
    if (captureKind === 'resource_candidate') return 'Save resource';
    return 'Save knowledge';
  }
  if (actionName === 'task_create' || actionName === 'create_task') return 'Create task';
  return fallbackLabel;
}

function getStateLabel(actionName: string, captureKind: unknown, fallbackLabel: string) {
  if (actionName === 'wiki_create') {
    if (captureKind === 'decision_candidate') return 'Decision saved';
    if (captureKind === 'resource_candidate') return 'Resource saved';
    return 'Knowledge saved';
  }
  if (actionName === 'task_create' || actionName === 'create_task') return 'Task created';
  if (actionName === 'task_update') return 'Task updated';
  if (actionName === 'memory_update') return 'Memory updated';
  return `${fallbackLabel} done`;
}

function truncate(value: string, max = 140) {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

function getStringParam(params: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return stripHtml(value);
  }
  return '';
}

function getNumberParam(params: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function formatConfidence(value: number | null) {
  if (value === null) return null;
  const normalized = value > 1 ? value / 100 : value;
  const clamped = Math.max(0, Math.min(1, normalized));
  if (clamped >= 0.8) return `${Math.round(clamped * 100)}% confidence`;
  if (clamped >= 0.55) return `${Math.round(clamped * 100)}% confidence - review source`;
  return `${Math.round(clamped * 100)}% confidence - verify carefully`;
}

function formatAge(createdAt?: string) {
  if (!createdAt) return null;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  const days = Math.floor(hours / 24);
  return `${days}d old`;
}

function getScopeLabel(params: Record<string, any>) {
  const scope = getStringParam(params, ['scope']);
  if (scope === 'org') return 'Team-wide memory';
  if (scope === 'space') return params.space_name ? `Only #${stripHtml(String(params.space_name))}` : 'Space memory';
  if (scope === 'user') return 'Personal memory';
  if (scope) return `${scope.replaceAll('_', ' ')} scope`;
  if (params.source_space_id || params.space_id) return 'Space source';
  return null;
}

function getExtractionLabel(params: Record<string, any>) {
  const extraction = getStringParam(params, ['extraction']);
  if (!extraction) return null;
  if (extraction === 'llm') return 'LLM classified';
  if (extraction === 'deterministic') return 'Rule matched';
  if (extraction === 'classifier') return 'Classifier';
  return extraction.replaceAll('_', ' ');
}

function getProposedOutcome(actionName: string, params: Record<string, any>, fallbackLabel: string) {
  const title = getStringParam(params, ['title', 'name']);
  const content = getStringParam(params, ['description', 'content', 'summary']);
  const priority = getStringParam(params, ['priority']);
  const assignee = getStringParam(params, ['assignee_name', 'assignee']);
  const project = getStringParam(params, ['project_name']);
  const space = getStringParam(params, ['space_name']);
  const type = getStringParam(params, ['type']);

  if (actionName === 'wiki_create') {
    return {
      label: title ? `Save "${truncate(title, 90)}"` : 'Save a knowledge entry',
      detail: [
        type ? type.replaceAll('_', ' ') : null,
        getScopeLabel(params),
        content ? truncate(content, 120) : null,
      ].filter(Boolean).join(' - '),
    };
  }

  if (actionName === 'task_create' || actionName === 'create_task') {
    return {
      label: title ? `Create "${truncate(title, 90)}"` : 'Create a task',
      detail: [
        priority ? priority.toUpperCase() : null,
        assignee ? `assigned to ${assignee}` : null,
        project ? `in ${project}` : null,
        content ? truncate(content, 120) : null,
      ].filter(Boolean).join(' - '),
    };
  }

  if (actionName === 'post_message') {
    return {
      label: space ? `Post in #${space}` : 'Post a message',
      detail: content ? truncate(content, 140) : '',
    };
  }

  return {
    label: fallbackLabel,
    detail: content ? truncate(content, 140) : '',
  };
}

function getSourceQuote(params: Record<string, any>) {
  return getStringParam(params, [
    'source_message_content',
    'source_message_preview',
    'source_content',
    'origin_message_content',
  ]);
}

function getTierLabel(tier?: string | null) {
  if (tier === 'quick') return 'Quick approval';
  if (tier === 'full') return 'Full review';
  if (tier === 'auto') return 'Auto tier';
  return null;
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
  const [localResult, setLocalResult] = useState<unknown>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  const humanized = humanizeToolName(action.action);
  const displayLabel = ACTION_LABELS[action.action] ?? humanized.full;
  const captureLabel = typeof action.params.capture_kind === 'string'
    ? CAPTURE_LABELS[action.params.capture_kind] ?? null
    : null;
  const isCapture = Boolean(captureLabel || action.params.proposed_by === 'defty' || action.params.source_message_id || action.source === 'defty_capture');
  const captureHeadline = isCapture
    ? getCaptureHeadline(action.action, action.params.capture_kind, displayLabel)
    : displayLabel;
  const approveLabel = getApproveLabel(action.action, action.params.capture_kind, displayLabel);
  const doneLabel = getStateLabel(action.action, action.params.capture_kind, displayLabel);
  const captureReason = getStringParam(action.params, ['capture_reason', 'policy_reason']);
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
  const sourceQuote = getSourceQuote(action.params);
  const outcome = getProposedOutcome(action.action, action.params, displayLabel);
  const confidence = formatConfidence(getNumberParam(action.params, ['confidence', 'capture_confidence', 'classification_confidence']));
  const age = formatAge(action.created_at);
  const extraction = getExtractionLabel(action.params);
  const tierLabel = getTierLabel(action.approval_tier ?? (typeof action.params.approval_tier === 'string' ? action.params.approval_tier : null));
  const scopeLabel = getScopeLabel(action.params);
  const proposerLabel = action.proposer === 'employee' && action.employee_name
    ? `${action.employee_name} proposal`
    : isCapture
      ? 'Defty capture'
      : 'Agent proposal';
  const metaChips = [scopeLabel, confidence, age, extraction, tierLabel].filter(Boolean) as string[];
  const approvedResult = getApprovedResult(localResult ?? action.result);
  const approvedTaskId = typeof approvedResult?.task_id === 'string'
    ? approvedResult.task_id
    : typeof approvedResult?.id === 'string' && action.action.includes('task')
      ? approvedResult.id
      : null;
  const approvedWikiSlug = typeof approvedResult?.slug === 'string' ? approvedResult.slug : null;
  const approvedWikiId = typeof approvedResult?.wiki_id === 'string'
    ? approvedResult.wiki_id
    : typeof approvedResult?.knowledge_id === 'string'
      ? approvedResult.knowledge_id
      : null;
  const createdAtMs = action.created_at ? new Date(action.created_at).getTime() : null;
  const isPossiblyStale = resolvedStatus === 'pending' && createdAtMs != null && Date.now() - createdAtMs > 60 * 60 * 1000;

  async function handleApprove() {
    if (isBusy) return;
    setLocalError(null);
    setLocalStatus('approving');
    try {
      const result = await onApprove();
      const status = normalizeReturnedStatus(result, 'approved');
      if (result && typeof result === 'object' && 'result' in result) {
        setLocalResult(result.result);
      }
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
        <span className="font-medium break-words [overflow-wrap:anywhere]">
          {verb} {isCapture ? captureHeadline.replace(/^Defty wants to /, '').toLowerCase() : displayLabel.toLowerCase()}...
        </span>
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
          <CheckCircle2 size={14} strokeWidth={1.8} />
          <span className="font-medium">{doneLabel}</span>
          {hasReceipt && (
            <button onClick={() => setShowReceipt(true)} className="inline-flex items-center gap-1 text-[11px] underline ml-1" style={{ color: 'var(--muted)' }}>
              <ReceiptText size={12} strokeWidth={1.7} />
              View receipt
            </button>
          )}
          {approvedTaskId && (
            <a href={`/tasks?task=${approvedTaskId}`} className="inline-flex items-center gap-1 text-[11px] underline ml-1" style={{ color: 'var(--muted)' }}>
              <ExternalLink size={12} strokeWidth={1.7} />
              Open task
            </a>
          )}
          {approvedWikiSlug && (
            <a href={`/knowledge?slug=${approvedWikiSlug}`} className="inline-flex items-center gap-1 text-[11px] underline ml-1" style={{ color: 'var(--muted)' }}>
              <ExternalLink size={12} strokeWidth={1.7} />
              Open knowledge
            </a>
          )}
          {!approvedWikiSlug && approvedWikiId && (
            <a href={`/knowledge?id=${approvedWikiId}`} className="inline-flex items-center gap-1 text-[11px] underline ml-1" style={{ color: 'var(--muted)' }}>
              <ExternalLink size={12} strokeWidth={1.7} />
              Open knowledge
            </a>
          )}
          {canUndo && onUndo && (
            <button onClick={onUndo} className="inline-flex items-center gap-1 text-[11px] underline ml-1" style={{ color: 'var(--muted)' }}>
              <RotateCcw size={12} strokeWidth={1.7} />
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
        className="rounded-lg px-3 py-2.5 mt-2 text-[12px] max-w-[460px]"
        style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.22)', color: 'var(--status-red)' }}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} strokeWidth={1.8} className="mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <p className="font-medium break-words">{captureHeadline} could not run.</p>
            <p className="mt-0.5 break-words" style={{ color: 'var(--muted)' }}>
              {action.error ? truncate(stripHtml(action.error), 160) : 'The proposal is preserved for review.'}
            </p>
            <a href="/inbox?tab=captures" className="inline-flex items-center gap-1 mt-1.5 underline underline-offset-2" style={{ color: 'var(--primary)' }}>
              Open Captures for retry
              <ExternalLink size={12} strokeWidth={1.7} />
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (resolvedStatus === 'expired') {
    return (
      <div
        className="rounded-lg px-3 py-2 mt-2 text-[12px] flex items-start gap-2 max-w-[460px]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}
      >
        <Clock3 size={14} strokeWidth={1.7} className="mt-0.5 flex-shrink-0" />
        <span>{captureHeadline} expired before review. Check the source before recreating it.</span>
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
          <XCircle size={14} strokeWidth={1.8} />
          <span>{isCapture ? 'Capture dismissed' : `${displayLabel} rejected`}</span>
          {hasReceipt && (
            <button onClick={() => setShowReceipt(true)} className="inline-flex items-center gap-1 text-[11px] underline ml-1" style={{ color: 'var(--muted)' }}>
              <ReceiptText size={12} strokeWidth={1.7} />
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
      className="p-3 sm:p-3.5 mt-2 max-w-[460px] w-full min-w-0"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: '8px' }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
            {proposerLabel}
          </p>
          <p className="text-[13px] font-semibold break-words [overflow-wrap:anywhere]" style={{ color: 'var(--text-primary)' }}>
            {captureHeadline}
          </p>
          {isCapture && (
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
              Nothing changes until you approve.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5 sm:justify-end">
          {isPossiblyStale && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap"
              style={{ color: 'var(--status-amber)', background: 'rgba(245,158,11,0.1)' }}
            >
              Check source
            </span>
          )}
          <span
            className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap"
            style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}
          >
            Needs approval
          </span>
        </div>
      </div>

      <div
        className="mt-3 rounded-md px-3 py-2 min-w-0"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
          Proposed outcome
        </p>
        <p className="text-[12px] font-medium mt-0.5 break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground)' }}>
          {outcome.label}
        </p>
        {outcome.detail && (
          <p className="text-[11px] mt-0.5 break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground-secondary)' }}>
            {outcome.detail}
          </p>
        )}
      </div>

      <div
        className="mt-2 rounded-md px-3 py-2 min-w-0"
        style={{ background: 'rgba(124,107,79,0.06)', border: '1px solid rgba(124,107,79,0.14)' }}
      >
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
          <Info size={12} strokeWidth={1.8} />
          Source
        </div>
        {sourceQuote ? (
          <p className="text-[12px] mt-1 break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground-secondary)' }}>
            "{truncate(sourceQuote, 180)}"
          </p>
        ) : (
          <p className="text-[12px] mt-1" style={{ color: 'var(--foreground-secondary)' }}>
            Source message attached. Open it before approving if the wording feels ambiguous.
          </p>
        )}
        {sourceMessageId && sourceSpaceId && (
          <a
            href={`/chat?space=${sourceSpaceId}&message=${sourceMessageId}`}
            className="inline-flex items-center gap-1 mt-1.5 text-[11px] underline underline-offset-2"
            style={{ color: 'var(--primary)' }}
          >
            View source message
            <ExternalLink size={12} strokeWidth={1.7} />
          </a>
        )}
      </div>

      {metaChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {metaChips.map((chip) => (
            <span
              key={chip}
              className="text-[10px] px-2 py-0.5 rounded-full break-words"
              style={{ color: 'var(--muted)', background: 'var(--surface-container-highest)', border: '1px solid var(--border)' }}
            >
              {chip}
            </span>
          ))}
        </div>
      )}

      <div className="text-[12px] mt-2 space-y-1" style={{ color: 'var(--foreground-secondary)' }}>
        {!(action.action in ACTION_LABELS) && <GenericParams params={action.params} />}
        {captureLabel && (
          <p style={{ color: 'var(--muted)' }}>
            {captureLabel}
          </p>
        )}
        {captureReason && (
          <p className="break-words [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>
            Why: {truncate(captureReason, 160)}
          </p>
        )}
        {workIntentStatus && action.params.work_intent_status !== 'proposed' && (
          <p style={{ color: 'var(--muted)' }}>
            Status: {workIntentStatus}
          </p>
        )}
        {isPossiblyStale && (
          <p style={{ color: 'var(--muted)' }}>
            This capture is older than an hour. Check the source before approving.
          </p>
        )}
        {localError && (
          <div
            className="mt-2 flex items-start gap-2 rounded-md px-2.5 py-2"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.18)', color: 'var(--status-red)' }}
          >
            <AlertTriangle size={13} strokeWidth={1.8} className="mt-0.5 flex-shrink-0" />
            <p className="min-w-0 break-words [overflow-wrap:anywhere]">
              {truncate(localError, 180)}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mt-3">
        <button
          onClick={handleApprove}
          disabled={isBusy}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium text-white disabled:opacity-60 min-h-[32px]"
          style={{ background: 'var(--status-green)' }}
        >
          <CheckCircle2 size={13} strokeWidth={1.8} />
          {approveLabel}
        </button>
        <button
          onClick={handleReject}
          disabled={isBusy}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium disabled:opacity-60 min-h-[32px]"
          style={{ background: 'var(--bg-overlay)', color: 'var(--text-secondary)' }}
        >
          <XCircle size={13} strokeWidth={1.8} />
          Dismiss
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
