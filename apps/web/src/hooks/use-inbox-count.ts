'use client';

/**
 * useInboxCount — lightweight SWR hook for the inbox unread count.
 * Polls the durable attention feed for unseen Needs-you items.
 */
import useSWR from 'swr';
import { api } from '@/lib/api';

async function fetchCount(): Promise<number> {
  const res = await api.get('/api/attention?lane=needs_you&limit=1');
  if (!res.ok) return 0;
  const body = await res.json() as { counts?: { needs_you?: { unseen?: number } } };
  return body.counts?.needs_you?.unseen ?? 0;
}

export function useInboxCount() {
  const { data } = useSWR<number>(
    '/api/attention?lane=needs_you&limit=1',
    fetchCount,
    { refreshInterval: 15_000, revalidateOnFocus: true, fallbackData: 0 },
  );
  const count = data ?? 0;
  return { count, hasUnread: count > 0 };
}
