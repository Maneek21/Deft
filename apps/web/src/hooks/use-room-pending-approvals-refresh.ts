'use client';

/**
 * When a room re-reads its pending approvals (the cards under chat messages).
 *
 * The people a room shows an approval card to are the action's reviewers,
 * and each of them has an Inbox item for it: raising, changing or resolving
 * the approval sends them `attention:new` or `attention:updated` with
 * `source_type: 'agent_action'` (lib/attention.ts, upsertAttentionItem). A
 * pending action raised without its item gets one at the reviewer's next
 * Inbox count poll (the backfill, every 15 seconds), which sends the event
 * then. So a room re-reads on those events, and polls only as a fallback,
 * every 30 seconds instead of every 5: each open room polled 12 times a
 * minute, which planned a large database statement on every pooled connection
 * and ran into the per-user rate limit with a few tabs open (release 152).
 */
import { useEffect } from 'react';
import { getSocket } from '@/lib/socket';

/** The fallback poll of a room's pending approvals. */
export const ROOM_PENDING_APPROVALS_REFRESH_MS = 30_000;

/** An Inbox event about an approval (the item of an agent action). */
export function isApprovalAttentionEvent(item: unknown): boolean {
  return typeof item === 'object' && item !== null && (item as { source_type?: unknown }).source_type === 'agent_action';
}

/** Re-read the room's pending approvals (`refresh`, SWR's bound mutate) on the viewer's approval Inbox events. */
export function useRoomPendingApprovalsRefresh(key: string | null, refresh: () => unknown) {
  useEffect(() => {
    if (!key) return;
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const onAttention = (item: unknown) => {
      if (isApprovalAttentionEvent(item)) Promise.resolve(refresh()).catch(() => undefined);
    };
    socket.on('attention:new', onAttention);
    socket.on('attention:updated', onAttention);
    return () => {
      socket.off('attention:new', onAttention);
      socket.off('attention:updated', onAttention);
    };
  }, [key, refresh]);
}
