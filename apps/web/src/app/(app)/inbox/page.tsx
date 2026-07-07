// apps/web/src/app/(app)/inbox/page.tsx
'use client';

import { useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  CheckSquare,
  Clock3,
  ExternalLink,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { useInbox, type InboxItemKind } from '@/hooks/use-inbox';
import { InboxRow } from '@/components/inbox-row';
import { AgentActionCard, type AgentAction } from '@/components/agent-action-card';
import { api } from '@/lib/api';
import { stripHtml } from '@/lib/strip-html';

type Tab = 'all' | 'mentions' | 'dms' | 'tasks' | 'captures' | 'approvals';

const TAB_TO_KIND: Record<Tab, InboxItemKind | undefined> = {
  all: undefined,
  mentions: 'mention',
  dms: 'dm_unread',
  tasks: 'task_assigned',
  captures: 'work_capture',
  approvals: 'pending_approval',
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'dms', label: 'DMs' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'captures', label: 'Captures' },
  { id: 'approvals', label: 'Approvals' },
];

type WorkIntent = {
  id: string;
  kind: 'task_candidate' | 'blocker_candidate' | 'decision_candidate' | 'resource_candidate' | 'note_candidate' | 'question_candidate';
  status: 'proposed' | 'converted' | 'dismissed' | 'expired' | 'failed';
  title: string;
  summary: string | null;
  proposed_action: string;
  proposed_params?: Record<string, unknown> | null;
  source_message_id: string | null;
  source_message_content: string | null;
  space_id: string | null;
  space_name: string | null;
  source_user_name: string | null;
  agent_employee_name: string | null;
  confidence?: number | null;
  converted_task_id: string | null;
  converted_at: string | null;
  dismissed_at: string | null;
  failure_reason: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type WorkIntentResponse = { intents: WorkIntent[] };

type MessageObservation = {
  id: string;
  message_id: string;
  status: 'queued' | 'processing' | 'ignored' | 'no_capture' | 'captured' | 'retrying' | 'failed';
  ignored_reason: string | null;
  classifier_result?: Record<string, unknown> | null;
  downstream_jobs?: Array<Record<string, unknown>> | null;
  capture_count: number;
  last_error: string | null;
  source_message_content: string | null;
  source_user_name: string | null;
  space_name: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type MessageObservationResponse = { observations: MessageObservation[] };

const INTENT_KIND_LABEL: Record<WorkIntent['kind'], string> = {
  task_candidate: 'Task candidate',
  blocker_candidate: 'Blocker candidate',
  decision_candidate: 'Decision candidate',
  resource_candidate: 'Resource candidate',
  note_candidate: 'Note candidate',
  question_candidate: 'Question candidate',
};

const INTENT_STATUS_LABEL: Record<WorkIntent['status'], string> = {
  proposed: 'Proposed',
  converted: 'Converted',
  dismissed: 'Dismissed',
  expired: 'Expired',
  failed: 'Failed',
};

function compactText(value: string, max = 180) {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

function formatIntentAge(value?: string | null) {
  if (!value) return null;
  const ageMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatIntentConfidence(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = value > 1 ? value / 100 : value;
  return `${Math.round(Math.max(0, Math.min(1, normalized)) * 100)}% confidence`;
}

function getIntentScope(intent: WorkIntent) {
  const proposedParams = intent.proposed_params ?? null;
  const metadataScope = typeof intent.metadata?.scope === 'string' ? intent.metadata.scope : null;
  const proposedScope = proposedParams && typeof proposedParams.scope === 'string' ? proposedParams.scope : null;
  const scope = proposedScope ?? metadataScope;
  if (scope === 'org') return 'Team-wide memory';
  if (scope === 'space') return intent.space_name ? `Only #${intent.space_name}` : 'Space-scoped';
  if (scope === 'user') return 'Personal';
  if (intent.space_name) return `#${intent.space_name}`;
  return null;
}

function getProposedParam(intent: WorkIntent, keys: string[]) {
  const params = intent.proposed_params ?? {};
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return stripHtml(value);
  }
  return '';
}

function formatActionName(action: string) {
  return action.replaceAll('_', ' ');
}

function getIntentOutcome(intent: WorkIntent) {
  const title = getProposedParam(intent, ['title', 'name']) || intent.title;
  const description = getProposedParam(intent, ['description', 'content', 'summary']) || intent.summary || '';
  const priority = getProposedParam(intent, ['priority']);
  const assignee = getProposedParam(intent, ['assignee_name', 'assignee']);
  const type = getProposedParam(intent, ['type']);
  const project = getProposedParam(intent, ['project_name']);
  const action = intent.proposed_action;

  if (action === 'wiki_create' || ['decision_candidate', 'resource_candidate', 'note_candidate'].includes(intent.kind)) {
    const noun = intent.kind === 'decision_candidate'
      ? 'decision'
      : intent.kind === 'resource_candidate'
        ? 'resource'
        : 'knowledge entry';
    return {
      label: title ? `Save "${compactText(title, 92)}"` : `Save ${noun}`,
      detail: [type || noun, getIntentScope(intent), description ? compactText(description, 160) : null]
        .filter(Boolean)
        .join(' - '),
    };
  }

  if (action === 'task_create' || action === 'create_task' || intent.kind === 'task_candidate' || intent.kind === 'blocker_candidate') {
    return {
      label: title ? `Create "${compactText(title, 92)}"` : 'Create a task',
      detail: [
        priority ? priority.toUpperCase() : null,
        assignee ? `assigned to ${assignee}` : null,
        project ? `in ${project}` : null,
        description ? compactText(description, 160) : null,
      ].filter(Boolean).join(' - '),
    };
  }

  return {
    label: formatActionName(action),
    detail: description ? compactText(description, 160) : '',
  };
}

async function fetchWorkIntents(url: string): Promise<WorkIntentResponse> {
  const res = await api.get(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load captures (${res.status})`);
  }
  return (await res.json()) as WorkIntentResponse;
}

async function fetchMessageObservations(url: string): Promise<MessageObservationResponse> {
  const res = await api.get(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load observations (${res.status})`);
  }
  return (await res.json()) as MessageObservationResponse;
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
  if (body?.error) return body.code ? `${body.error} (${body.code})` : body.error;
  return `${fallback} (${res.status})`;
}

function WorkIntentRow({
  intent,
  onRetry,
  retrying,
  retryError,
  convertedRetryId,
}: {
  intent: WorkIntent;
  onRetry: (intentId: string) => void;
  retrying: boolean;
  retryError: string | null;
  convertedRetryId?: string | null;
}) {
  const statusColor =
    intent.status === 'converted' ? 'var(--status-green)'
    : intent.status === 'failed' ? 'var(--status-red)'
    : intent.status === 'dismissed' ? 'var(--muted)'
    : intent.status === 'expired' ? 'var(--status-amber)'
    : 'var(--primary)';
  const statusBackground =
    intent.status === 'failed' ? 'rgba(239,68,68,0.1)'
    : intent.status === 'expired' ? 'rgba(245,158,11,0.1)'
    : 'var(--bg-active)';
  const messagePreview = stripHtml(intent.source_message_content ?? intent.summary ?? '');
  const metadata = intent.metadata ?? {};
  const convertedWikiSlug = typeof metadata.converted_wiki_slug === 'string'
    ? metadata.converted_wiki_slug
    : null;
  const timestamp = intent.converted_at
    ?? intent.dismissed_at
    ?? (intent.status === 'failed' || intent.status === 'expired' ? intent.updated_at : null)
    ?? intent.created_at;
  const reasonLabel =
    intent.status === 'dismissed' ? 'Dismissed reason'
    : intent.status === 'expired' ? 'Expired reason'
    : 'Failure reason';
  const age = formatIntentAge(timestamp);
  const confidence = formatIntentConfidence(intent.confidence);
  const scope = getIntentScope(intent);
  const metaChips = [scope, confidence, age].filter(Boolean) as string[];
  const outcome = getIntentOutcome(intent);
  const isConvertedToTask = Boolean(intent.converted_task_id);
  const isConvertedToKnowledge = Boolean(convertedWikiSlug);
  const StatusIcon =
    intent.status === 'converted' ? CheckCircle2
    : intent.status === 'failed' ? AlertTriangle
    : intent.status === 'dismissed' ? XCircle
    : intent.status === 'expired' ? Clock3
    : Clock3;
  const outcomeIcon = isConvertedToTask || intent.kind === 'task_candidate' || intent.kind === 'blocker_candidate'
    ? CheckSquare
    : BookOpen;
  const OutcomeIcon = outcomeIcon;
  const statusLabel = intent.status === 'converted'
    ? isConvertedToTask
      ? intent.proposed_action === 'task_update' ? 'Task updated' : 'Task created'
      : isConvertedToKnowledge
        ? intent.proposed_action === 'wiki_update' ? 'Knowledge updated' : 'Knowledge saved'
        : 'Converted'
    : INTENT_STATUS_LABEL[intent.status];

  return (
    <div
      className="px-3 py-3 rounded-lg border min-w-0"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
            {INTENT_KIND_LABEL[intent.kind]}
          </p>
          <p className="text-[13px] font-semibold break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground)' }}>
            {intent.title}
          </p>
          <p className="text-[11px] mt-0.5 break-words [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>
            From {intent.source_user_name ?? 'chat'}{intent.space_name ? ` in #${intent.space_name}` : ''}
          </p>
        </div>
        <span
          className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap self-start"
          style={{ color: statusColor, background: statusBackground }}
        >
          <StatusIcon size={11} strokeWidth={1.8} />
          {statusLabel}
        </span>
      </div>
      {messagePreview && (
        <div
          className="mt-2 rounded-md px-3 py-2"
          style={{ background: 'rgba(124,107,79,0.06)', border: '1px solid rgba(124,107,79,0.14)' }}
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
            Source
          </p>
          <p className="text-[12px] mt-0.5 line-clamp-3 break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground-secondary)' }}>
            "{compactText(messagePreview, 220)}"
          </p>
        </div>
      )}
      <div
        className="mt-2 rounded-md px-3 py-2"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
          Proposed outcome
        </p>
        <p className="text-[12px] mt-0.5 flex items-start gap-1.5 break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground-secondary)' }}>
          <OutcomeIcon size={13} strokeWidth={1.7} className="mt-0.5 flex-shrink-0" />
          <span className="min-w-0">
            <span className="font-medium" style={{ color: 'var(--foreground)' }}>{outcome.label}</span>
            {outcome.detail && <span> - {outcome.detail}</span>}
          </span>
        </p>
      </div>
      {metaChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {metaChips.map((chip) => (
            <span
              key={chip}
              className="text-[10px] px-2 py-0.5 rounded-full"
              style={{ color: 'var(--muted)', background: 'var(--surface-container-highest)', border: '1px solid var(--border)' }}
            >
              {chip}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
        {intent.agent_employee_name && <span>by {intent.agent_employee_name}</span>}
        {intent.converted_task_id && (
          <a
            href={`/tasks?task=${intent.converted_task_id}`}
            className="inline-flex items-center gap-1 underline underline-offset-2"
            style={{ color: 'var(--primary)' }}
          >
            <ExternalLink size={11} strokeWidth={1.7} />
            Task
          </a>
        )}
        {convertedWikiSlug && (
          <a
            href={`/knowledge?slug=${convertedWikiSlug}`}
            className="inline-flex items-center gap-1 underline underline-offset-2"
            style={{ color: 'var(--primary)' }}
          >
            <ExternalLink size={11} strokeWidth={1.7} />
            Knowledge
          </a>
        )}
        {intent.source_message_id && intent.space_id && (
          <a
            href={`/chat?space=${intent.space_id}&message=${intent.source_message_id}`}
            className="inline-flex items-center gap-1 underline underline-offset-2"
            style={{ color: 'var(--primary)' }}
          >
            <ExternalLink size={11} strokeWidth={1.7} />
            Source
          </a>
        )}
      </div>
      {intent.failure_reason && (
        <p className="text-[11px] mt-1" style={{ color: 'var(--status-red)' }}>
          <span style={{ color: intent.status === 'failed' ? 'var(--status-red)' : 'var(--muted)' }}>
            {reasonLabel}: {stripHtml(intent.failure_reason).slice(0, 180)}
          </span>
        </p>
      )}
      {intent.status === 'expired' && !intent.failure_reason && (
        <p className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>
          This proposal expired before review. Retry from a failed capture or create a new task from the source message.
        </p>
      )}
      {intent.status === 'failed' && convertedRetryId && (
        <p className="text-[11px] mt-2" style={{ color: 'var(--muted)' }}>
          This failed capture was already retried and converted.
        </p>
      )}
      {intent.status === 'failed' && !convertedRetryId && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => onRetry(intent.id)}
            disabled={retrying}
            className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md disabled:opacity-60"
            style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}
          >
            <RotateCcw size={12} strokeWidth={1.7} className={retrying ? 'animate-spin' : ''} />
            {retrying ? 'Retrying...' : 'Retry as proposal'}
          </button>
          {retryError && (
            <p className="text-[11px] mt-1" style={{ color: 'var(--status-red)' }}>
              {retryError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const OBSERVATION_STATUS_LABEL: Record<MessageObservation['status'], string> = {
  queued: 'Queued',
  processing: 'Processing',
  ignored: 'Ignored',
  no_capture: 'No capture',
  captured: 'Captured',
  retrying: 'Retrying',
  failed: 'Failed',
};

function formatObservationReason(observation: MessageObservation) {
  if (observation.status === 'ignored' && observation.ignored_reason) {
    return observation.ignored_reason.replaceAll('_', ' ');
  }
  if (observation.status === 'no_capture') return 'No work intent found';
  if (observation.status === 'captured') {
    const jobs = observation.downstream_jobs
      ?.map((job) => typeof job.name === 'string' ? job.name.replaceAll('-', ' ') : null)
      .filter(Boolean)
      .join(', ');
    return jobs ? `Sent to ${jobs}` : `${observation.capture_count} capture job${observation.capture_count === 1 ? '' : 's'}`;
  }
  if (observation.status === 'failed' || observation.status === 'retrying') {
    return observation.last_error || 'Observation failed';
  }
  return 'Waiting for Defty';
}

function MessageObservationRow({ observation }: { observation: MessageObservation }) {
  const messagePreview = stripHtml(observation.source_message_content ?? '');
  const age = formatIntentAge(observation.completed_at ?? observation.updated_at ?? observation.created_at);
  const statusColor =
    observation.status === 'failed' ? 'var(--status-red)'
    : observation.status === 'retrying' ? 'var(--status-amber)'
    : observation.status === 'ignored' || observation.status === 'no_capture' ? 'var(--muted)'
    : observation.status === 'captured' ? 'var(--status-green)'
    : 'var(--primary)';

  return (
    <div
      className="rounded-lg border px-3 py-3"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium" style={{ color: statusColor }}>
              {OBSERVATION_STATUS_LABEL[observation.status]}
            </span>
            {observation.space_name && (
              <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
                #{observation.space_name}
              </span>
            )}
            {age && (
              <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
                {age}
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--foreground)' }}>
            {formatObservationReason(observation)}
          </p>
          {messagePreview && (
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
              {observation.source_user_name ? `${observation.source_user_name}: ` : ''}
              {compactText(messagePreview, 180)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function InboxPage() {
  const params = useSearchParams();
  const initialTab = (params.get('tab') as Tab) ?? 'all';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [retryingIntentId, setRetryingIntentId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<{ intentId: string; message: string } | null>(null);

  // For 'tasks' we want both task_assigned and task_updated. Fetch all and filter
  // client-side for that tab; for the others we pass kind to the API.
  const apiKind = tab === 'tasks' ? undefined : TAB_TO_KIND[tab];
  const { items, unreadCount, isLoading, error: inboxError, markRead, markAllRead, refresh } = useInbox(apiKind);
  const shouldLoadWorkIntents = tab === 'captures';
  const { data: workIntentData, error: workIntentsError, isLoading: workIntentsLoading, mutate: refreshWorkIntents } = useSWR(
    shouldLoadWorkIntents ? '/api/work-intents?limit=50' : null,
    fetchWorkIntents,
    { refreshInterval: 15_000, revalidateOnFocus: true },
  );
  const { data: observationData, error: observationsError, isLoading: observationsLoading, mutate: refreshObservations } = useSWR(
    shouldLoadWorkIntents ? '/api/work-intents/observations?limit=50' : null,
    fetchMessageObservations,
    { refreshInterval: 15_000, revalidateOnFocus: true },
  );

  const filtered = useMemo(() => {
    if (tab === 'tasks') {
      return items.filter((it) => it.kind === 'task_assigned' || it.kind === 'task_updated');
    }
    return items;
  }, [items, tab]);
  const historicWorkIntents = useMemo(
    () => (workIntentData?.intents ?? []).filter((intent) => intent.status !== 'proposed'),
    [workIntentData?.intents],
  );
  const observationTrail = useMemo(
    () => (observationData?.observations ?? []).slice(0, 20),
    [observationData?.observations],
  );
  const convertedRetryByOriginal = useMemo(() => {
    const map = new Map<string, string>();
    for (const intent of workIntentData?.intents ?? []) {
      if (intent.status !== 'converted') continue;
      const retryOf = intent.metadata?.retry_of_work_intent_id;
      if (typeof retryOf === 'string') map.set(retryOf, intent.id);
    }
    return map;
  }, [workIntentData?.intents]);
  const loadError = shouldLoadWorkIntents
    ? (inboxError ?? workIntentsError ?? observationsError)
    : inboxError;
  const refreshCaptureSurfaces = useCallback(async () => {
    await Promise.allSettled([refresh(), refreshWorkIntents(), refreshObservations()]);
  }, [refresh, refreshWorkIntents, refreshObservations]);

  const handleApprove = useCallback(
    async (id: string) => {
      try {
        const res = await api.post(`/api/agent/actions/${id}/approve`, {});
        if (!res.ok) throw new Error(await readApiError(res, 'Approve failed'));
        return await res.json().catch(() => ({ status: 'approved' }));
      } finally {
        await refreshCaptureSurfaces();
      }
    },
    [refreshCaptureSurfaces],
  );

  const handleReject = useCallback(
    async (id: string) => {
      try {
        const res = await api.post(`/api/agent/actions/${id}/reject`, {});
        if (!res.ok) throw new Error(await readApiError(res, 'Reject failed'));
        return await res.json().catch(() => ({ status: 'rejected' }));
      } finally {
        await refreshCaptureSurfaces();
      }
    },
    [refreshCaptureSurfaces],
  );

  const handleRetryIntent = useCallback(
    async (id: string) => {
      setRetryingIntentId(id);
      setRetryError(null);
      try {
        const res = await api.post(`/api/work-intents/${id}/retry`, {});
        if (!res.ok) throw new Error(await readApiError(res, 'Retry failed'));
        await refreshCaptureSurfaces();
      } catch (err) {
        setRetryError({
          intentId: id,
          message: err instanceof Error ? err.message : 'Retry failed.',
        });
      } finally {
        setRetryingIntentId(null);
      }
    },
    [refreshCaptureSurfaces],
  );

  const handleRowClick = useCallback(
    (id: string) => () => {
      void markRead([id]);
    },
    [markRead],
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
      <div className="max-w-[760px] mx-auto px-4 py-6 md:px-6 md:py-8">
        <header className="mb-6 flex items-end justify-between">
          <div>
            <h1
              className="text-[20px] font-semibold"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
            >
              Inbox
            </h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
              {unreadCount > 0
                ? `${unreadCount} unread item${unreadCount === 1 ? '' : 's'}`
                : "You're caught up."}
            </p>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={() => void markAllRead()}
              className="deft-pill min-h-[32px]"
            >
              Mark all read
            </button>
          )}
        </header>

        {/* Tab strip */}
        <nav
          className="mb-5 flex gap-1.5 overflow-x-auto whitespace-nowrap"
          role="tablist"
          aria-label="Inbox sections"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="deft-pill"
              data-active={tab === t.id}
              role="tab"
              aria-selected={tab === t.id}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Body */}
        {isLoading || (shouldLoadWorkIntents && (workIntentsLoading || observationsLoading)) ? (
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>Loading...</p>
        ) : loadError ? (
          <div
            className="text-[13px] py-8 px-4 text-center rounded-lg"
            style={{ color: 'var(--status-red)', border: '1px dashed var(--border)' }}
          >
            <p>{loadError instanceof Error ? loadError.message : 'Could not load inbox.'}</p>
            <button
              type="button"
              onClick={() => { void refreshCaptureSurfaces(); }}
              className="deft-pill mt-3"
            >
              Retry
            </button>
          </div>
        ) : filtered.length === 0 && (!shouldLoadWorkIntents || (historicWorkIntents.length === 0 && observationTrail.length === 0)) ? (
          <div
            className="text-[13px] py-12 text-center rounded-lg"
            style={{ color: 'var(--muted)', border: '1px dashed var(--border)' }}
          >
            Nothing here.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((item) => {
              if ((item.kind === 'pending_approval' || item.kind === 'work_capture') && item.approval) {
                const action: AgentAction = {
                  id: item.approval.action_id,
                  action: item.approval.action,
                  params: item.approval.params as Record<string, any>,
                  created_at: item.created_at,
                  approval_tier: item.approval.approval_tier,
                  employee_name: item.approval.employee_name,
                  proposer: item.approval.proposer,
                };
                return (
                  <AgentActionCard
                    key={item.id}
                    action={action}
                    onApprove={() => handleApprove(item.approval!.action_id)}
                    onReject={() => handleReject(item.approval!.action_id)}
                  />
                );
              }
              return (
                <InboxRow
                  key={item.id}
                  item={item}
                  onClick={handleRowClick(item.id)}
                  onDismiss={() => void markRead([item.id])}
                />
              );
            })}
            {shouldLoadWorkIntents && historicWorkIntents
              .map((intent) => (
                <WorkIntentRow
                  key={intent.id}
                  intent={intent}
                  onRetry={handleRetryIntent}
                  retrying={retryingIntentId === intent.id}
                  retryError={retryError?.intentId === intent.id ? retryError.message : null}
                  convertedRetryId={convertedRetryByOriginal.get(intent.id) ?? null}
                />
              ))}
            {shouldLoadWorkIntents && observationTrail.length > 0 && (
              <div className="mt-4 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>
                    Observation trail
                  </h2>
                  <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
                    Last {observationTrail.length}
                  </span>
                </div>
                {observationTrail.map((observation) => (
                  <MessageObservationRow key={observation.id} observation={observation} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
