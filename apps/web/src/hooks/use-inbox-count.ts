'use client';

/**
 * useInboxCount — lightweight SWR hook for the inbox unread count.
 * Polls /api/inbox?count_only=1 every 15s to feed the sidebar badge.
 * Separate from useInbox (full feed) to avoid unnecessary payload transfers.
 */
import useSWR from 'swr';
import { api } from '@/lib/api';

async function fetchCount(): Promise<number> {
  const res = await api.get('/api/inbox?count_only=1');
  if (!res.ok) return 0;
  const body = (await res.json()) as unknown;
  if (typeof body === 'object' && body !== null && 'unread_count' in body) {
    const count = (body as { unread_count?: unknown }).unread_count;
    if (typeof count === 'number') return count;
  }
  return 0;
}

export function useInboxCount() {
  const { data } = useSWR<number>(
    '/api/inbox?count_only=1',
    fetchCount,
    { refreshInterval: 15_000, revalidateOnFocus: true, fallbackData: 0 },
  );
  const count = data ?? 0;
  return { count, hasUnread: count > 0 };
}
