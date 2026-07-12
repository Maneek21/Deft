// apps/web/src/hooks/use-inbox.ts
'use client';

import useSWR from 'swr';
import { useCallback } from 'react';
import { api } from '@/lib/api';

export type InboxItemKind =
  | 'mention' | 'dm_unread' | 'task_assigned' | 'task_updated'
  | 'blocked' | 'cross_reference' | 'wiki_update' | 'system' | 'work_capture' | 'pending_approval';

export type InboxItem = {
  id: string;
  kind: InboxItemKind;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read: boolean;
  source: 'notification' | 'dm' | 'approval';
  approval?: {
    action_id: string;
    action: string;
    params: Record<string, unknown>;
    approval_tier: 'auto' | 'quick' | 'full';
    agent_employee_id: string | null;
    employee_name: string | null;
    employee_slug: string | null;
    employee_avatar: string | null;
    proposer: 'employee' | 'defty';
  };
  dm?: { space_id: string; unread_count: number; last_message_preview: string | null };
};

type InboxResponse = {
  items: InboxItem[];
  unread_count: number;
  has_more: boolean;
  next_cursor: string | null;
};

async function fetchInbox(url: string): Promise<InboxResponse> {
  const res = await api.get(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load inbox (${res.status})`);
  }
  return (await res.json()) as InboxResponse;
}

export function useInbox(kinds?: InboxItemKind[], options: { includeRead?: boolean } = {}) {
  const kindQuery = kinds?.length ? kinds.join(',') : '';
  const query = new URLSearchParams();
  if (kindQuery) query.set('kind', kindQuery);
  if (options.includeRead) query.set('include_read', '1');
  const queryString = query.toString();
  const url = queryString ? `/api/inbox?${queryString}` : '/api/inbox';
  const { data, mutate, isLoading, error } = useSWR<InboxResponse>(url, fetchInbox, {
    refreshInterval: 15_000,
    revalidateOnFocus: true,
  });

  const markRead = useCallback(async (ids: string[]) => {
    await api.post('/api/inbox/read', { ids });
    void mutate();
  }, [mutate]);

  const markAllRead = useCallback(async () => {
    await api.post('/api/inbox/read', { all: true, kinds });
    void mutate();
  }, [kinds, mutate]);

  return {
    items: data?.items ?? [],
    unreadCount: data?.unread_count ?? 0,
    hasMore: data?.has_more ?? false,
    isLoading,
    error,
    markRead,
    markAllRead,
    refresh: mutate,
  };
}
