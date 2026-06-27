// apps/web/src/app/(app)/inbox/page.tsx
'use client';

import { useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
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
  source_message_id: string | null;
  source_message_content: string | null;
  space_id: string | null;
  space_name: string | null;
  source_user_name: string | null;
  agent_employee_name: string | null;
  converted_task_id: string | null;
  converted_at: string | null;
  dismissed_at: string | null;
  failure_reason: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type WorkIntentResponse = { intents: WorkIntent[] };

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

async function fetchWorkIntents(url: string): Promise<WorkIntentResponse> {
  const res = await api.get(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load captures (${res.status})`);
  }
  return (await res.json()) as WorkIntentResponse;
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
  const timestamp = intent.converted_at
    ?? intent.dismissed_at
    ?? (intent.status === 'failed' || intent.status === 'expired' ? intent.updated_at : null)
    ?? intent.created_at;
  const reasonLabel =
    intent.status === 'dismissed' ? 'Dismissed reason'
    : intent.status === 'expired' ? 'Expired reason'
    : 'Failure reason';

  return (
    <div
      className="px-3 py-2.5 rounded-lg border min-w-0"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-medium break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground)' }}>
            {intent.title}
          </p>
          <p className="text-[11px] mt-0.5 break-words [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>
            {INTENT_KIND_LABEL[intent.kind]} from {intent.source_user_name ?? 'chat'}{intent.space_name ? ` in #${intent.space_name}` : ''}
          </p>
        </div>
        <span
          className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap self-start"
          style={{ color: statusColor, background: statusBackground }}
        >
          {INTENT_STATUS_LABEL[intent.status]}
        </span>
      </div>
      {messagePreview && (
        <p className="text-[12px] mt-2 line-clamp-2 break-words [overflow-wrap:anywhere]" style={{ color: 'var(--foreground-secondary)' }}>
          "{messagePreview.slice(0, 180)}{messagePreview.length > 180 ? '...' : ''}"
        </p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
        <span>{intent.proposed_action.replaceAll('_', ' ')}</span>
        {intent.agent_employee_name && <span>by {intent.agent_employee_name}</span>}
        {timestamp && <span>{new Date(timestamp).toLocaleString()}</span>}
        {intent.converted_task_id && (
          <a
            href={`/tasks?task=${intent.converted_task_id}`}
            className="underline underline-offset-2"
            style={{ color: 'var(--primary)' }}
          >
            Task
          </a>
        )}
        {intent.source_message_id && intent.space_id && (
          <a
            href={`/chat?space=${intent.space_id}&message=${intent.source_message_id}`}
            className="underline underline-offset-2"
            style={{ color: 'var(--primary)' }}
          >
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
            className="text-[11px] px-2.5 py-1 rounded-md disabled:opacity-60"
            style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}
          >
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
    ? (inboxError ?? workIntentsError)
    : inboxError;
  const refreshCaptureSurfaces = useCallback(async () => {
    await Promise.allSettled([refresh(), refreshWorkIntents()]);
  }, [refresh, refreshWorkIntents]);

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
              className="text-[12px] px-3 py-1.5 rounded-md"
              style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}
            >
              Mark all read
            </button>
          )}
        </header>

        {/* Tab strip */}
        <nav
          className="flex gap-1 mb-5 border-b overflow-x-auto whitespace-nowrap"
          style={{ borderColor: 'var(--border)' }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="text-[13px] px-3 py-2 -mb-px"
              style={{
                color: tab === t.id ? 'var(--primary)' : 'var(--muted)',
                borderBottom: tab === t.id ? '2px solid var(--primary)' : '2px solid transparent',
                fontWeight: tab === t.id ? 600 : 400,
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Body */}
        {isLoading || (shouldLoadWorkIntents && workIntentsLoading) ? (
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
              className="mt-3 text-[12px] px-3 py-1.5 rounded-md"
              style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}
            >
              Retry
            </button>
          </div>
        ) : filtered.length === 0 && (!shouldLoadWorkIntents || historicWorkIntents.length === 0) ? (
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
          </div>
        )}
      </div>
    </div>
  );
}
