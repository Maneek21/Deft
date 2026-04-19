'use client';

/**
 * usePendingApprovals — SWR-poll the agent-actions pending queue so the
 * Agent nav entry + notification bell can surface a red count from any
 * screen in the app.
 *
 * Block 0 Task 0.2 of OpenClaw Unlock plan.
 */
import useSWR from 'swr';
import { api } from '@/lib/api';

type PendingAction = { id: string };

async function fetchPending(): Promise<PendingAction[]> {
  const res = await api.get('/api/agent/actions/pending');
  if (!res.ok) return [];
  const body = (await res.json()) as unknown;
  if (Array.isArray(body)) return body as PendingAction[];
  if (body && typeof body === 'object' && Array.isArray((body as { actions?: unknown }).actions)) {
    return (body as { actions: PendingAction[] }).actions;
  }
  return [];
}

export function usePendingApprovals() {
  const { data } = useSWR<PendingAction[]>(
    '/api/agent/actions/pending',
    fetchPending,
    { refreshInterval: 15_000, revalidateOnFocus: true, fallbackData: [] },
  );
  const count = data?.length ?? 0;
  return { count, hasPending: count > 0 };
}
