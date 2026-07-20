'use client';

import { useCallback, useEffect } from 'react';
import useSWRInfinite from 'swr/infinite';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';

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
  items: AttentionItem[];
  counts: Record<AttentionLane, { count: number; unseen: number }>;
  next_cursor: string | null;
};

async function fetchAttention(url: string): Promise<AttentionResponse> {
  const response = await api.get(url);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load attention (${response.status})`);
  }
  return response.json() as Promise<AttentionResponse>;
}

export function useAttention(options: {
  lane?: AttentionLane;
  state?: 'open' | 'all' | string;
  limit?: number;
} = {}) {
  const query = new URLSearchParams();
  if (options.lane) query.set('lane', options.lane);
  if (options.state) query.set('state', options.state);
  query.set('limit', String(options.limit ?? 60));
  const baseQuery = query.toString();
  const getKey = (pageIndex: number, previousPage: AttentionResponse | null) => {
    if (pageIndex > 0 && !previousPage?.next_cursor) return null;
    const pageQuery = new URLSearchParams(baseQuery);
    if (pageIndex > 0 && previousPage?.next_cursor) pageQuery.set('cursor', previousPage.next_cursor);
    return `/api/attention?${pageQuery.toString()}`;
  };
  const { data, error, isLoading, isValidating, mutate, size, setSize } = useSWRInfinite<AttentionResponse>(getKey, fetchAttention, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
  const firstPage = data?.[0];
  const lastPage = data?.[data.length - 1];
  const items = data?.flatMap((page) => page.items) ?? [];

  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const refresh = () => { void mutate(); };
    socket.on('attention:new', refresh);
    socket.on('attention:updated', refresh);
    return () => {
      socket.off('attention:new', refresh);
      socket.off('attention:updated', refresh);
    };
  }, [mutate]);

  const transition = useCallback(async (
    id: string,
    action: 'seen' | 'acknowledge' | 'resolve' | 'snooze',
    body: Record<string, unknown> = {},
  ) => {
    const response = await api.post(`/api/attention/${id}/${action}`, body);
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Could not ${action} item`);
    }
    await mutate();
    return response.json();
  }, [mutate]);

  const markAllSeen = useCallback(async (lane?: AttentionLane) => {
    const response = await api.post('/api/attention/mark-all-seen', { lane });
    if (!response.ok) throw new Error('Could not mark attention items seen');
    await mutate();
  }, [mutate]);

  const feedback = useCallback(async (id: string, value: 'not_for_me' | 'not_urgent') => {
    const response = await api.post(`/api/attention/${id}/feedback`, { feedback: value });
    if (!response.ok) throw new Error('Could not save attention feedback');
    await mutate();
  }, [mutate]);

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
