'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { CheckCircle2, History, Inbox as InboxIcon } from 'lucide-react';
import { AgentActionCard, type AgentAction } from '@/components/agent-action-card';
import { AttentionRow } from '@/components/attention-row';
import { useAttention, type AttentionLane } from '@/hooks/use-attention';
import { api } from '@/lib/api';
import { stripHtml } from '@/lib/strip-html';
import { formatRelative } from '@/lib/time';

type InboxTab = AttentionLane | 'activity';

type WorkIntent = {
  id: string;
  kind: string;
  status: string;
  title: string;
  summary: string | null;
  source_user_name: string | null;
  space_name: string | null;
  failure_reason: string | null;
  converted_task_id: string | null;
  updated_at: string;
};

function normalizeTab(value: string | null): InboxTab {
  if (value === 'updates' || value === 'activity') return value;
  return 'needs_you';
}

async function fetchWorkIntents(url: string): Promise<{ intents: WorkIntent[] }> {
  const response = await api.get(url);
  if (!response.ok) throw new Error('Could not load activity history');
  return response.json() as Promise<{ intents: WorkIntent[] }>;
}

async function readApiError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? `${fallback} (${response.status})`;
}

export default function InboxPage() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const tab = normalizeTab(params.get('lane') ?? params.get('tab'));
  const lane = tab === 'activity' ? undefined : tab;
  const state = tab === 'activity' ? 'resolved,expired,superseded' : 'open';
  const {
    items,
    counts,
    error,
    isLoading,
    refresh,
    markSeen,
    acknowledge,
    resolve,
    snooze,
    markAllSeen,
    feedback,
    hasMore,
    loadMore,
    isLoadingMore,
  } = useAttention({ lane, state });
  const seenLaneRef = useRef<string | null>(null);
  const { data: activityData, error: activityError, isLoading: activityLoading } = useSWR(
    tab === 'activity' ? '/api/work-intents?limit=40' : null,
    fetchWorkIntents,
    { refreshInterval: 30_000, revalidateOnFocus: true },
  );

  useEffect(() => {
    if (!lane || isLoading || seenLaneRef.current === lane) return;
    if (!items.some((item) => item.state === 'open_unseen')) return;
    seenLaneRef.current = lane;
    void markAllSeen(lane);
  }, [isLoading, items, lane, markAllSeen]);

  const setTab = useCallback((next: InboxTab) => {
    const nextParams = new URLSearchParams(params.toString());
    nextParams.delete('tab');
    if (next === 'needs_you') nextParams.delete('lane');
    else nextParams.set('lane', next);
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  const handleApprove = useCallback(async (actionId: string) => {
    const response = await api.post(`/api/agent/actions/${actionId}/approve`, {});
    if (!response.ok) throw new Error(await readApiError(response, 'Approve failed'));
    const result = await response.json().catch(() => ({ status: 'approved' }));
    await refresh();
    return result;
  }, [refresh]);

  const handleReject = useCallback(async (actionId: string) => {
    const response = await api.post(`/api/agent/actions/${actionId}/reject`, {});
    if (!response.ok) throw new Error(await readApiError(response, 'Dismiss failed'));
    const result = await response.json().catch(() => ({ status: 'rejected' }));
    await refresh();
    return result;
  }, [refresh]);

  const historicIntents = useMemo(
    () => (activityData?.intents ?? []).filter((intent) => intent.status !== 'proposed').slice(0, 30),
    [activityData?.intents],
  );
  const totalOpen = counts.needs_you.count + counts.updates.count;
  const loading = isLoading || (tab === 'activity' && activityLoading);
  const loadError = error ?? (tab === 'activity' ? activityError : null);

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-[760px] px-4 py-6 md:px-6 md:py-8">
        <header className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
              Inbox
            </h1>
            <p className="mt-1 text-[13px]" style={{ color: 'var(--muted)' }}>
              {loading
                ? 'Loading attention...'
                : tab === 'needs_you'
                  ? `${counts.needs_you.count} item${counts.needs_you.count === 1 ? '' : 's'} waiting on you`
                  : tab === 'updates'
                    ? `${counts.updates.count} useful update${counts.updates.count === 1 ? '' : 's'}`
                    : 'Resolved work and processing receipts'}
            </p>
          </div>
          {lane && counts[lane].unseen > 0 && (
            <button type="button" onClick={() => void markAllSeen(lane)} className="deft-pill min-h-[32px]">
              Mark seen
            </button>
          )}
        </header>

        <nav className="mb-5 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap" role="tablist" aria-label="Inbox lanes">
          <button type="button" onClick={() => setTab('needs_you')} className="deft-pill" data-active={tab === 'needs_you'} role="tab" aria-selected={tab === 'needs_you'}>
            Needs you
            {counts.needs_you.count > 0 && <span className="ml-1 opacity-70">{counts.needs_you.count}</span>}
          </button>
          <button type="button" onClick={() => setTab('updates')} className="deft-pill" data-active={tab === 'updates'} role="tab" aria-selected={tab === 'updates'}>
            Updates
            {counts.updates.count > 0 && <span className="ml-1 opacity-70">{counts.updates.count}</span>}
          </button>
          <span className="mx-0.5 h-5 w-px shrink-0" style={{ background: 'var(--border)' }} />
          <button type="button" onClick={() => setTab('activity')} className="deft-pill inline-flex items-center gap-1.5" data-active={tab === 'activity'} role="tab" aria-selected={tab === 'activity'}>
            <History size={13} strokeWidth={1.7} /> Activity
          </button>
        </nav>

        {loading ? (
          <p className="py-10 text-center text-[13px]" style={{ color: 'var(--muted)' }}>Loading...</p>
        ) : loadError ? (
          <div className="rounded-lg border border-dashed px-4 py-8 text-center text-[13px]" style={{ borderColor: 'var(--border)', color: 'var(--status-red)' }}>
            {loadError instanceof Error ? loadError.message : 'Could not load Inbox.'}
          </div>
        ) : items.length === 0 && (tab !== 'activity' || historicIntents.length === 0) ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
            {tab === 'needs_you' ? <CheckCircle2 size={22} strokeWidth={1.5} /> : <InboxIcon size={22} strokeWidth={1.5} />}
            <p className="text-[13px]">{tab === 'needs_you' ? "Nothing is waiting on you." : tab === 'updates' ? "You're caught up." : 'No activity receipts yet.'}</p>
          </div>
        ) : (
          <div className="min-w-0">
            {items.map((item) => {
              if (item.kind === 'approval' && item.approval) {
                const action: AgentAction = {
                  id: item.approval.id,
                  action: item.approval.action,
                  params: item.approval.params,
                  result: item.approval.result,
                  error: item.approval.error,
                  approval_status: item.approval.approval_status,
                  approval_tier: item.approval.approval_tier,
                  created_at: item.created_at,
                  employee_name: item.approval.employee_name,
                };
                return (
                  <div key={item.id} className="mb-3">
                    <AgentActionCard
                      action={action}
                      onApprove={() => handleApprove(action.id)}
                      onReject={() => handleReject(action.id)}
                    />
                  </div>
                );
              }
              return (
                <AttentionRow
                  key={item.id}
                  item={item}
                  onSeen={() => { void markSeen(item.id); }}
                  onAcknowledge={() => { void acknowledge(item.id); }}
                  onResolve={() => { void resolve(item.id); }}
                  onSnooze={() => { void snooze(item.id, new Date(Date.now() + 60 * 60 * 1000)); }}
                  onFeedback={(value) => { void feedback(item.id, value); }}
                />
              );
            })}

            {tab === 'activity' && historicIntents.length > 0 && (
              <section className="mt-7">
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
                  Work capture history
                </h2>
                <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                  {historicIntents.map((intent) => (
                    <div key={intent.id} className="flex items-start gap-3 py-3" style={{ borderColor: 'var(--border)' }}>
                      <CheckCircle2 size={15} className="mt-0.5 shrink-0" style={{ color: intent.status === 'failed' ? 'var(--status-red)' : 'var(--muted)' }} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>{intent.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-[12px]" style={{ color: 'var(--muted)' }}>
                          {stripHtml(intent.failure_reason ?? intent.summary ?? `${intent.kind.replaceAll('_', ' ')} ${intent.status}`)}
                        </p>
                        <p className="mt-1 text-[11px]" style={{ color: 'var(--outline)' }}>
                          {[intent.space_name ? `#${intent.space_name}` : null, formatRelative(intent.updated_at)].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {tab !== 'activity' && hasMore && (
              <div className="mt-5 flex justify-center">
                <button type="button" className="deft-pill" disabled={isLoadingMore} onClick={() => { void loadMore(); }}>
                  {isLoadingMore ? 'Loading...' : 'Load more'}
                </button>
              </div>
            )}
          </div>
        )}

        {tab !== 'activity' && totalOpen === 0 && !loading && items.length > 0 && (
          <p className="mt-5 text-center text-[11px]" style={{ color: 'var(--outline)' }}>All current attention is cleared.</p>
        )}
      </div>
    </div>
  );
}
