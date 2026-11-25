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
 *
 * Events that arrive together (an approval raised, seen and decided; the
 * room and its thread panel both listening) make one re-read per room, at
 * most one every ROOM_PENDING_APPROVALS_EVENT_DELAY_MS, so a burst cannot
 * spend the per-user limit an approve click needs.
 */
import { useEffect } from 'react';
import { getSocket } from '@/lib/socket';

/** The fallback poll of a room's pending approvals. */
export const ROOM_PENDING_APPROVALS_REFRESH_MS = 30_000;

/** How long after an approval event a room re-reads; later events until then join that re-read. */
export const ROOM_PENDING_APPROVALS_EVENT_DELAY_MS = 750;

/** The Inbox events a room re-reads its approvals on (lib/attention.ts, emitAttention). */
export const APPROVAL_ATTENTION_EVENTS = ['attention:new', 'attention:updated'] as const;

/** An Inbox event about an approval (the item of an agent action). */
export function isApprovalAttentionEvent(item: unknown): boolean {
  return typeof item === 'object' && item !== null && (item as { source_type?: unknown }).source_type === 'agent_action';
}

type Timers = { set: (run: () => void, ms: number) => unknown };
const browserTimers: Timers = { set: (run, ms) => setTimeout(run, ms) };

/** One scheduled re-read per room (SWR key), shared by every view of that room in this tab. */
const scheduled = new Map<string, { timer: unknown; refresh: () => unknown }>();

/**
 * Re-read the room `key` once, ROOM_PENDING_APPROVALS_EVENT_DELAY_MS from the
 * first event not yet answered; events until then join it (the latest
 * `refresh` runs). A re-read after its views closed only refreshes the cache.
 */
export function scheduleRoomPendingApprovalsRefresh(key: string, refresh: () => unknown, timers: Timers = browserTimers): void {
  const current = scheduled.get(key);
  if (current) {
    current.refresh = refresh;
    return;
  }
  const entry: { timer: unknown; refresh: () => unknown } = { timer: undefined, refresh };
  entry.timer = timers.set(() => {
    scheduled.delete(key);
    Promise.resolve(entry.refresh()).catch(() => undefined);
  }, ROOM_PENDING_APPROVALS_EVENT_DELAY_MS);
  scheduled.set(key, entry);
}

/** Re-read the room's pending approvals (`refresh`, SWR's bound mutate) on the viewer's approval Inbox events. */
export function useRoomPendingApprovalsRefresh(key: string | null, refresh: () => unknown) {
  useEffect(() => {
    if (!key) return;
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const onAttention = (item: unknown) => {
      if (isApprovalAttentionEvent(item)) scheduleRoomPendingApprovalsRefresh(key, refresh);
    };
    for (const event of APPROVAL_ATTENTION_EVENTS) socket.on(event, onAttention);
    return () => {
      for (const event of APPROVAL_ATTENTION_EVENTS) socket.off(event, onAttention);
    };
  }, [key, refresh]);
}
