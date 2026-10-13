'use client';

import { useCallback, useEffect } from 'react';
import useSWRInfinite from 'swr/infinite';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAuth } from '@/lib/auth-context';
import { sessionSWRKey, sessionSWRPath, sessionSWRScope, isActiveSessionCacheKey, getActiveSessionCacheScope } from '@/lib/session-cache';

export type AttentionLane = 'needs_you' | 'updates';
export type AttentionState =
  | 'open_unseen'
  | 'open_seen'
  | 'acknowledged'
  | 'snoozed'
  | 'resolved'
  | 'expired'
  | 'superseded';

export type AttentionApproval = {
  id: string;
  action: string;
  params: Record<string, unknown>;
  approval_tier: 'auto' | 'quick' | 'full';
  approval_status: string;
  result: unknown;
  error: string | null;
  agent_employee_id: string | null;
  employee_name: string | null;
  employee_slug: string | null;
  employee_avatar: string | null;
};

export type AttentionItem = {
  id: string;
  org_id: string;
  user_id: string;
  kind: string;
  lane: AttentionLane;
  priority: 'critical' | 'high' | 'normal' | 'low';
  state: AttentionState;
  source_type: string;
  source_id: string;
  title: string;
  body: string | null;
  link: string | null;
  metadata: Record<string, unknown>;
  last_event_at: string;
  event_count: number;
  snoozed_until: string | null;
  created_at: string;
  approval: AttentionApproval | null;
};

type AttentionResponse = {
  session_scope: string;
  items: AttentionItem[];
  counts: Record<AttentionLane, { count: number; unseen: number }>;
  next_cursor: string | null;
};

async function fetchAttention(key: string): Promise<AttentionResponse> {
  if (!isActiveSessionCacheKey(key)) throw new Error('Attention access changed.');
  const response = await api.get(sessionSWRPath(key));
  if (!isActiveSessionCacheKey(key)) { await response.body?.cancel(); throw new Error('Attention access changed.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load attention (${response.status})`);
  }
  const value = await response.json();
  if (!isActiveSessionCacheKey(key)) throw new Error('Attention access changed.');
  return { ...value, session_scope: sessionSWRScope(key)! } as AttentionResponse;
}

export function useAttention(options: {
  lane?: AttentionLane;
  state?: 'open' | 'all' | string;
  limit?: number;
} = {}) {
  const { sessionCacheScope } = useAuth();
  const query = new URLSearchParams();
  if (options.lane) query.set('lane', options.lane);
  if (options.state) query.set('state', options.state);
  query.set('limit', String(options.limit ?? 60));
  const baseQuery = query.toString();
  const getKey = (pageIndex: number, previousPage: AttentionResponse | null) => {
    if (pageIndex > 0 && previousPage?.session_scope !== sessionCacheScope) return null;
    if (pageIndex > 0 && !previousPage?.next_cursor) return null;
    const pageQuery = new URLSearchParams(baseQuery);
    if (pageIndex > 0 && previousPage?.next_cursor) pageQuery.set('cursor', previousPage.next_cursor);
    return sessionSWRKey(sessionCacheScope, `/api/attention?${pageQuery.toString()}`);
  };
  const { data, error, isLoading, isValidating, mutate, size, setSize } = useSWRInfinite<AttentionResponse>(getKey, fetchAttention, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
  const pages = data?.filter((page) => page.session_scope === sessionCacheScope) ?? [];
  const firstPage = pages[0];
  const lastPage = pages[pages.length - 1];
  const items = pages.flatMap((page) => page.items);

  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (!token || !sessionCacheScope) return;
    const socket = getSocket(token);
    const refresh = () => { if (getActiveSessionCacheScope() === sessionCacheScope) void mutate(); };
    socket.on('attention:new', refresh);
    socket.on('attention:updated', refresh);
    return () => {
      socket.off('attention:new', refresh);
      socket.off('attention:updated', refresh);
    };
  }, [mutate, sessionCacheScope]);

  const transition = useCallback(async (
    id: string,
    action: 'seen' | 'acknowledge' | 'resolve' | 'snooze',
    body: Record<string, unknown> = {},
  ) => {
    if (!sessionCacheScope || getActiveSessionCacheScope() !== sessionCacheScope) throw new Error('Attention access changed.');
    const response = await api.post(`/api/attention/${id}/${action}`, body);
    if (getActiveSessionCacheScope() !== sessionCacheScope) throw new Error('Attention access changed.');
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Could not ${action} item`);
    }
    const value = await response.json();
    if (getActiveSessionCacheScope() !== sessionCacheScope) throw new Error('Attention access changed.');
    await mutate();
    if (getActiveSessionCacheScope() !== sessionCacheScope) throw new Error('Attention access changed.');
    return value;
  }, [mutate, sessionCacheScope]);

  const markAllSeen = useCallback(async (lane?: AttentionLane) => {
    if (!sessionCacheScope || getActiveSessionCacheScope() !== sessionCacheScope) throw new Error('Attention access changed.');
    const response = await api.post('/api/attention/mark-all-seen', { lane });
    if (getActiveSessionCacheScope() !== sessionCacheScope) throw new Error('Attention access changed.');
    if (!response.ok) throw new Error('Could not mark attention items seen');
    await mutate();
    if (getActiveSessionCacheScope() !== sessionCacheScope) throw new Error('Attention access changed.');
  }, [mutate, sessionCacheScope]);

  const feedback = useCallback(async (id: string, value: 'not_for_me' | 'not_urgent') => {
    if (!sessionCacheScope || getActiveSessionCacheScope() !== sessionCacheScope) throw new Error('Attention access changed.');
    const response = await api.post(`/api/attention/${id}/feedback`, { feedback: value });
    if (getActiveSessionCacheScope() !== sessionCacheScope) throw new Error('Attention access changed.');
    if (!response.ok) throw new Error('Could not save attention feedback');
    await mutate();
    if (getActiveSessionCacheScope() !== sessionCacheScope) throw new Error('Attention access changed.');
  }, [mutate, sessionCacheScope]);

  return {
    items,
    counts: firstPage?.counts ?? {
      needs_you: { count: 0, unseen: 0 },
      updates: { count: 0, unseen: 0 },
    },
    nextCursor: lastPage?.next_cursor ?? null,
    hasMore: Boolean(lastPage?.next_cursor),
    loadMore: () => setSize(size + 1),
    isLoadingMore: isValidating && Boolean(data) && (data?.length ?? 0) < size,
    error,
    isLoading,
    refresh: mutate,
    markSeen: (id: string) => transition(id, 'seen'),
    acknowledge: (id: string) => transition(id, 'acknowledge'),
    resolve: (id: string, resolution = 'dismissed') => transition(id, 'resolve', { resolution }),
    snooze: (id: string, until: Date) => transition(id, 'snooze', { until: until.toISOString() }),
    markAllSeen,
    feedback,
  };
}
