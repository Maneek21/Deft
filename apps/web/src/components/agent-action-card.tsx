'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Clock3,
  ExternalLink,
  FolderKanban,
  Info,
  MessageSquare,
  ReceiptText,
  RotateCcw,
  ScrollText,
  ShieldAlert,
  Sparkles,
  StickyNote,
  Tag,
  UserRound,
  XCircle,
} from 'lucide-react';
import { ReceiptViewer } from './receipt-viewer';
import { humanizeToolName } from '@/lib/tool-display';
import { stripHtml } from '@/lib/strip-html';
import {
  getAgentActionPresentation,
  getSafeGenericParams,
  type ApprovalChipIconName,
  type ApprovalIconName,
} from '@/lib/agent-action-presentation';

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
type AgentActionCardVariant = 'review' | 'compact';
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
  const entries = getSafeGenericParams(params);
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

function getDueLabel(params: Record<string, any>) {
  const value = getStringParam(params, ['due_date', 'dueDate', 'deadline', 'due_at', 'scheduled_for']);
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return truncate(value, 30);
}

function getCompactEyebrow(actionName: string, captureKind: unknown) {
  if (actionName === 'wiki_create') {
    if (captureKind === 'decision_candidate') return 'Decision draft';
    if (captureKind === 'resource_candidate') return 'Resource draft';
    return 'Knowledge draft';
  }
  if (actionName === 'task_create' || actionName === 'create_task') return 'Task draft';
  if (actionName === 'task_update') return 'Task update draft';
  if (actionName === 'post_message') return 'Message draft';
  return 'Action draft';
}

function getCompactTitle(actionName: string, params: Record<string, any>, fallbackLabel: string) {
  const title = getStringParam(params, ['title', 'name', 'summary']);
  const space = getStringParam(params, ['space_name']);
  if (actionName === 'post_message') {
    return space ? `Post in #${space}` : 'Post a message';
  }
  if (title) return truncate(title, 96);
  if (actionName === 'wiki_create') return 'Save a knowledge entry';
  if (actionName === 'task_create' || actionName === 'create_task') return 'Create a task';
  return fallbackLabel;
}

function getCompactSummary(actionName: string, params: Record<string, any>) {
  const content = getStringParam(params, ['description', 'content', 'summary']);
  if (!content) return '';
  const max = actionName === 'post_message' ? 120 : 140;
  return truncate(content, max);
}

function getCompactChips(actionName: string, params: Record<string, any>) {
  const chips: Array<{ label: string; icon?: 'user' | 'calendar' | 'project' | 'book' | 'task' }> = [];
  const assignee = getStringParam(params, ['assignee_name', 'assignee']);
  const due = getDueLabel(params);
  const project = getStringParam(params, ['project_name']);
  const priority = getStringParam(params, ['priority']);
  const scope = getScopeLabel(params);
  const type = getStringParam(params, ['type']);
  const subtaskText = getSubtaskDraftText(params);
  const subtaskCount = subtaskText ? subtaskText.split('\n').filter((line) => /^\d+\./.test(line)).length : 0;

  if (actionName === 'task_create' || actionName === 'create_task' || actionName === 'task_update') {
    if (assignee) chips.push({ label: assignee, icon: 'user' });
    if (due) chips.push({ label: due, icon: 'calendar' });
    if (project) chips.push({ label: project, icon: 'project' });
    if (subtaskCount > 0) chips.push({ label: `${subtaskCount} subtasks`, icon: 'task' });
    if (priority) chips.push({ label: priority.toUpperCase(), icon: 'task' });
  } else if (actionName === 'wiki_create') {
    if (type) chips.push({ label: type.replaceAll('_', ' '), icon: 'book' });
    if (scope) chips.push({ label: scope, icon: 'book' });
  } else if (actionName === 'post_message') {
    const space = getStringParam(params, ['space_name']);
    if (space) chips.push({ label: `#${space}`, icon: 'project' });
  }

  return chips.slice(0, 4);
}

function CompactChipIcon({ icon }: { icon?: ApprovalChipIconName }) {
  if (icon === 'user') return <UserRound size={12} strokeWidth={1.8} />;
  if (icon === 'calendar') return <CalendarClock size={12} strokeWidth={1.8} />;
  if (icon === 'project') return <FolderKanban size={12} strokeWidth={1.8} />;
  if (icon === 'book') return <BookOpen size={12} strokeWidth={1.8} />;
  if (icon === 'task') return <CheckSquare size={12} strokeWidth={1.8} />;
  if (icon === 'message') return <MessageSquare size={12} strokeWidth={1.8} />;
  if (icon === 'shield') return <ShieldAlert size={12} strokeWidth={1.8} />;
  if (icon === 'clock') return <Clock3 size={12} strokeWidth={1.8} />;
  if (icon === 'tag') return <Tag size={12} strokeWidth={1.8} />;
  return null;
}

function CompactActionIcon({ icon }: { icon: ApprovalIconName }) {
  if (icon === 'knowledge') return <BookOpen size={14} strokeWidth={1.9} />;
  if (icon === 'message') return <MessageSquare size={14} strokeWidth={1.9} />;
  if (icon === 'note') return <StickyNote size={14} strokeWidth={1.9} />;
  if (icon === 'calendar') return <CalendarClock size={14} strokeWidth={1.9} />;
  if (icon === 'canvas') return <ScrollText size={14} strokeWidth={1.9} />;
  if (icon === 'plan') return <Sparkles size={14} strokeWidth={1.9} />;
  if (icon === 'admin') return <ShieldAlert size={14} strokeWidth={1.9} />;
  if (icon === 'generic') return <Info size={14} strokeWidth={1.9} />;
  return <CheckSquare size={14} strokeWidth={1.9} />;
}

function getSourceQuote(params: Record<string, any>) {
  return getStringParam(params, [
    'source_message_content',
    'source_message_preview',
    'source_content',
    'origin_message_content',
  ]);
}

function getDisplaySourceQuote(params: Record<string, any>) {
  const quote = getSourceQuote(params)
    .replace(/\*\*/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!quote) return '';
  const lower = quote.toLowerCase();
  if (
    lower.includes('queued for your approval') ||
    lower.includes('review the approval card') ||
    lower.includes('where you can approve') ||
    lower.includes('you can approve it')
  ) {
    return '';
  }

  return quote;
}

function getSubtaskDraftText(params: Record<string, any>) {
  const subtasks = params.subtasks;
  if (!Array.isArray(subtasks)) return '';
  const lines = subtasks
    .map((subtask, index) => {
      if (!subtask || typeof subtask !== 'object') return '';
      const record = subtask as Record<string, any>;
      const title = getStringParam(record, ['title']);
      if (!title) return '';
      const assignee = getStringParam(record, ['assignee_name', 'assignee']);
      const due = getStringParam(record, ['due_date', 'dueDate']);
      const priority = getStringParam(record, ['priority']);
      const meta = [assignee ? `assignee: ${assignee}` : '', due ? `due: ${due}` : '', priority ? priority.toUpperCase() : '']
        .filter(Boolean)
        .join(', ');
      return `${index + 1}. ${title}${meta ? ` (${meta})` : ''}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return '';
  return `Subtasks:\n${lines.join('\n')}`;
}

function getDraftDetailText(actionName: string, params: Record<string, any>) {
  const messageActions = new Set(['post_message', 'message_post', 'send_message', 'post_thread_reply']);
  if (messageActions.has(actionName)) {
    return getStringParam(params, ['content', 'message', 'body', 'text']);
  }
  if (actionName === 'create_task' || actionName === 'task_create' || actionName === 'task_update') {
    const description = getStringParam(params, ['description', 'content', 'summary', 'comment']);
    const subtasks = getSubtaskDraftText(params);
    return [description, subtasks].filter(Boolean).join('\n\n');
  }
  const taskMutationActions = new Set([
    'update_task', 'update_task_status', 'assign_task', 'comment_on_task', 'set_due_date',
    'set_priority', 'add_label', 'close_task', 'reopen_task', 'add_dependency',
    'remove_dependency', 'task_transition',
  ]);
  if (taskMutationActions.has(actionName)) {
    const task = getStringParam(params, ['task_identifier', 'task_id', 'id']);
    const status = getStringParam(params, ['new_status', 'status']) ||
      (actionName === 'close_task' ? 'done' : actionName === 'reopen_task' ? 'reopened' : '');
    const assignee = getStringParam(params, ['assignee_name', 'assignee']);
    const due = getStringParam(params, ['due_date', 'dueDate']);
    const priority = getStringParam(params, ['priority']);
    return [
      task ? `Task: ${task}` : '',
      status ? `Status: ${status.replaceAll('_', ' ')}` : '',
      assignee ? `Assignee: ${assignee}` : '',
      due ? `Due: ${due}` : '',
      priority ? `Priority: ${priority.toUpperCase()}` : '',
    ].filter(Boolean).join('\n');
  }
  if (actionName.includes('wiki') || actionName.includes('memory') || actionName === 'create_note') {
    return getStringParam(params, ['content', 'description', 'summary']);
  }
  return '';
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
  variant = 'review',
}: {
  action: AgentAction;
  onApprove: () => AgentActionMutationResult | Promise<AgentActionMutationResult>;
  onReject: () => AgentActionMutationResult | Promise<AgentActionMutationResult>;
  onUndo?: () => void;
  variant?: AgentActionCardVariant;
}) {
  const [localStatus, setLocalStatus] = useState<LocalStatus>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localResult, setLocalResult] = useState<unknown>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const humanized = humanizeToolName(action.action);
  const presentation = getAgentActionPresentation(action);
  const displayLabel = ACTION_LABELS[action.action] ?? humanized.full;
  const captureLabel = typeof action.params.capture_kind === 'string'
    ? CAPTURE_LABELS[action.params.capture_kind] ?? null
    : null;
  const isCapture = Boolean(captureLabel || action.params.proposed_by === 'defty' || action.params.source_message_id || action.source === 'defty_capture');
  const captureHeadline = isCapture
    ? getCaptureHeadline(action.action, action.params.capture_kind, displayLabel)
    : presentation.headline || displayLabel;
  const approveLabel = presentation.approveLabel || getApproveLabel(action.action, action.params.capture_kind, displayLabel);
  const doneLabel = presentation.doneLabel || getStateLabel(action.action, action.params.capture_kind, displayLabel);
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
  const sourceQuote = getDisplaySourceQuote(action.params);
  const draftDetailText = getDraftDetailText(action.action, action.params);
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
  const isCompact = variant === 'compact';

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

  if (isCompact) {
    const compactTitle = presentation.title || getCompactTitle(action.action, action.params, displayLabel);
    const compactSummary = presentation.summary || getCompactSummary(action.action, action.params);
    const compactEyebrow = presentation.eyebrow || getCompactEyebrow(action.action, action.params.capture_kind);
    const compactChips = presentation.chips.length > 0 ? presentation.chips : getCompactChips(action.action, action.params);
    const compactBadge = presentation.badge ?? getStringParam(action.params, ['priority']);
    const compactApproveLabel = presentation.approveLabel || approveLabel;
    const compactBadgeStyle = presentation.badgeTone === 'danger'
      ? {
        color: 'var(--status-red)',
        background: 'rgba(239,68,68,0.12)',
        border: '1px solid rgba(239,68,68,0.18)',
      }
      : presentation.badgeTone === 'caution'
        ? {
          color: 'var(--status-amber)',
          background: 'rgba(245,158,11,0.12)',
          border: '1px solid rgba(245,158,11,0.18)',
        }
        : {
          color: 'var(--muted)',
          background: 'var(--surface-container-highest)',
          border: '1px solid var(--border)',
        };

    return (
      <div
        className="mt-2.5 w-full max-w-[500px]"
        style={{
          color: 'var(--foreground)',
        }}
      >
        <div
          className="rounded-[18px] px-3.5 py-3"
          style={{
            background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 96%, var(--primary) 4%), var(--bg-elevated))',
            border: '1px solid color-mix(in srgb, var(--border) 72%, var(--primary) 28%)',
            boxShadow: '0 12px 30px rgba(0,0,0,0.14)',
          }}
        >
          <div className="flex items-start gap-2.5">
            <div
              className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl"
              style={{
                background: 'color-mix(in srgb, var(--primary) 16%, transparent)',
                color: 'var(--primary)',
              }}
              aria-hidden="true"
            >
              <CompactActionIcon icon={presentation.icon} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <p className="min-w-0 text-[11px] font-semibold uppercase tracking-[0.035em]" style={{ color: 'var(--primary)' }}>
                  {compactEyebrow}
                </p>
                {compactBadge && (
                  <span
                    className="inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
                    style={compactBadgeStyle}
                  >
                    {compactBadge}
                  </span>
                )}
              </div>
              <p
                className="mt-1 text-[14px] font-semibold leading-snug break-words [overflow-wrap:anywhere]"
                style={{ color: 'var(--text-primary)' }}
              >
                {compactTitle}
              </p>
              {compactSummary && (
                <p
                  className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed break-words [overflow-wrap:anywhere]"
                  style={{ color: 'var(--foreground-secondary)' }}
                >
                  {compactSummary}
                </p>
              )}
            </div>
          </div>

          {compactChips.length > 0 && (
            <div
              className="mt-3 flex flex-wrap gap-1.5 border-t pt-2.5"
              style={{ borderColor: 'color-mix(in srgb, var(--border) 72%, transparent)' }}
            >
              {compactChips
                .filter((chip) => chip.label.toLowerCase() !== String(compactBadge ?? '').toLowerCase())
                .map((chip) => (
                  <span
                    key={`${chip.icon}-${chip.label}`}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
                    style={{
                      color: 'var(--foreground-secondary)',
                      background: 'color-mix(in srgb, var(--surface-container-highest) 82%, transparent)',
                      border: '1px solid color-mix(in srgb, var(--border) 85%, transparent)',
                    }}
                  >
                    <CompactChipIcon icon={chip.icon} />
                    <span className="truncate">{chip.label}</span>
                  </span>
                ))}
            </div>
          )}

          <div
            className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
            style={{ color: 'var(--muted)' }}
          >
            <span>{presentation.sourceLabel}</span>
          </div>

          {showDetails && (
            <div
              className="mt-3 rounded-xl px-3 py-2.5 text-[12px]"
              style={{
                background: 'color-mix(in srgb, var(--surface) 86%, transparent)',
                border: '1px solid var(--border)',
              }}
            >
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
                <Info size={12} strokeWidth={1.8} />
                {presentation.detailsLabel}
              </div>
              {draftDetailText ? (
                <p
                  className="mt-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                  style={{ color: 'var(--foreground-secondary)' }}
                >
                  {draftDetailText}
                </p>
              ) : sourceQuote ? (
                <p className="mt-1.5 max-h-20 overflow-y-auto break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground-secondary)' }}>
                  "{truncate(sourceQuote, 180)}"
                </p>
              ) : (
                <p className="mt-1.5" style={{ color: 'var(--foreground-secondary)' }}>
                  {presentation.emptyDetails}
                </p>
              )}
              {isPossiblyStale && (
                <p className="mt-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  This draft is older than an hour. Re-read the thread if the work has moved on.
                </p>
              )}
              {sourceMessageId && sourceSpaceId && (
                <a
                  href={`/chat?space=${sourceSpaceId}&message=${sourceMessageId}`}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium underline underline-offset-2"
                  style={{ color: 'var(--primary)' }}
                >
                  Open source message
                  <ExternalLink size={12} strokeWidth={1.7} />
                </a>
              )}
            </div>
          )}

          {localError && (
            <div
              className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-[12px]"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.18)', color: 'var(--status-red)' }}
            >
              <AlertTriangle size={13} strokeWidth={1.8} className="mt-0.5 flex-shrink-0" />
              <p className="min-w-0 break-words [overflow-wrap:anywhere]">
                {truncate(localError, 180)}
              </p>
            </div>
          )}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleApprove}
            disabled={isBusy}
            className="inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-xl px-4 py-1.5 text-[12px] font-semibold text-white shadow-sm disabled:opacity-60"
            style={{ background: 'var(--primary-container)' }}
          >
            <CheckCircle2 size={13} strokeWidth={1.9} />
            {compactApproveLabel}
          </button>
          <button
            type="button"
            onClick={handleReject}
            disabled={isBusy}
            className="inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-xl px-4 py-1.5 text-[12px] font-medium disabled:opacity-60"
            style={{ background: 'var(--surface-container-highest)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => setShowDetails((value) => !value)}
            className="inline-flex min-h-[34px] items-center justify-center gap-1 rounded-xl px-2.5 py-1.5 text-[12px] font-medium"
            style={{ color: 'var(--muted)' }}
          >
            {showDetails ? <ChevronUp size={14} strokeWidth={1.8} /> : <ChevronDown size={14} strokeWidth={1.8} />}
            Details
          </button>
        </div>
      </div>
    );
  }

  const reviewTitle = presentation.title || captureHeadline;
  const reviewSummary = presentation.summary || outcome.detail;
  const reviewEyebrow = presentation.eyebrow || proposerLabel;
  const reviewChips = presentation.chips.length > 0
    ? presentation.chips
    : getCompactChips(action.action, action.params);
  const reviewBadge = presentation.badge ?? null;

  return (
    <div
      className="p-3 sm:p-3.5 mt-2 max-w-[460px] w-full min-w-0"
      style={{
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 97%, var(--primary) 3%), var(--bg-elevated))',
        border: '1px solid color-mix(in srgb, var(--border-strong) 78%, var(--primary) 22%)',
        borderRadius: '18px',
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <div
            className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl"
            style={{
              background: 'color-mix(in srgb, var(--primary) 16%, transparent)',
              color: 'var(--primary)',
            }}
            aria-hidden="true"
          >
            <CompactActionIcon icon={presentation.icon} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.045em]" style={{ color: 'var(--primary)' }}>
              {reviewEyebrow}
            </p>
            <p className="mt-0.5 text-[14px] font-semibold leading-snug break-words [overflow-wrap:anywhere]" style={{ color: 'var(--text-primary)' }}>
              {reviewTitle}
            </p>
            {reviewSummary && (
              <p className="mt-1 text-[12px] leading-relaxed line-clamp-2 break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground-secondary)' }}>
                {reviewSummary}
              </p>
            )}
            {isCapture && (
              <p className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>
                Nothing changes until you approve.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 sm:justify-end">
          {reviewBadge && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap font-semibold uppercase"
              style={{
                color: presentation.badgeTone === 'danger'
                  ? 'var(--status-red)'
                  : presentation.badgeTone === 'caution'
                    ? 'var(--status-amber)'
                    : 'var(--muted)',
                background: presentation.badgeTone === 'danger'
                  ? 'rgba(239,68,68,0.12)'
                  : presentation.badgeTone === 'caution'
                    ? 'rgba(245,158,11,0.12)'
                    : 'var(--surface-container-highest)',
                border: '1px solid var(--border)',
              }}
            >
              {reviewBadge}
            </span>
          )}
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

      {reviewChips.length > 0 && (
        <div
          className="mt-3 flex flex-wrap gap-1.5 border-t pt-2.5"
          style={{ borderColor: 'color-mix(in srgb, var(--border) 72%, transparent)' }}
        >
          {reviewChips
            .filter((chip) => chip.label.toLowerCase() !== String(reviewBadge ?? '').toLowerCase())
            .map((chip) => (
              <span
                key={`${chip.icon}-${chip.label}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
                style={{
                  color: 'var(--foreground-secondary)',
                  background: 'color-mix(in srgb, var(--surface-container-highest) 82%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--border) 85%, transparent)',
                }}
              >
                <CompactChipIcon icon={chip.icon} />
                <span className="truncate">{chip.label}</span>
              </span>
            ))}
        </div>
      )}

      <div
        className="mt-3 rounded-md px-3 py-2 min-w-0"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
          {presentation.detailsLabel}
        </p>
        <p className="text-[12px] font-medium mt-0.5 break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground)' }}>
          {outcome.label}
        </p>
        {draftDetailText ? (
          <p
            className="text-[11px] mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            {draftDetailText}
          </p>
        ) : outcome.detail && (
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
