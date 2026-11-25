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
import { useSWRConfig } from 'swr';
import { getSocket } from '@/lib/socket';

/** The fallback poll of a room's pending approvals. */
export const ROOM_PENDING_APPROVALS_REFRESH_MS = 30_000;

/** How long after an approval event a room re-reads; later events until then join that re-read. */
export const ROOM_PENDING_APPROVALS_EVENT_DELAY_MS = 750;

/** How long a re-read may hold its room: a request that never settles does not stop later events. */
export const ROOM_PENDING_APPROVALS_READ_TIMEOUT_MS = 15_000;

/** The Inbox events a room re-reads its approvals on (lib/attention.ts, emitAttention). */
export const APPROVAL_ATTENTION_EVENTS = ['attention:new', 'attention:updated'] as const;

/** An Inbox event about an approval (the item of an agent action). */
export function isApprovalAttentionEvent(item: unknown): boolean {
  return typeof item === 'object' && item !== null && (item as { source_type?: unknown }).source_type === 'agent_action';
}

type Timers = { set: (run: () => void, ms: number) => unknown };
const browserTimers: Timers = { set: (run, ms) => setTimeout(run, ms) };

type RoomRefresh = { refresh: () => unknown; reading: boolean; again: boolean };

/** One pending or running re-read per room (SWR key), shared by every view of that room in this tab. */
const rooms = new Map<string, RoomRefresh>();

/**
 * Re-read the room `key` ROOM_PENDING_APPROVALS_EVENT_DELAY_MS after an event,
 * one read at a time. Events before the read starts join it; events while it
 * runs queue one more read after it completes. A read started while another
 * runs would replace it (SWR drops the older response), so events closer
 * together than a read takes would otherwise keep the card from ever
 * updating (astra, review of b0ee15db). A read holds its room for at most
 * ROOM_PENDING_APPROVALS_READ_TIMEOUT_MS: one that never settles releases it
 * then, and the queued read (which replaces it) runs (astra, review of
 * ad034701). `refresh` re-reads the room's own key.
 */
export function scheduleRoomPendingApprovalsRefresh(key: string, refresh: () => unknown, timers: Timers = browserTimers): void {
  const current = rooms.get(key);
  if (current) {
    current.refresh = refresh;
    if (current.reading) current.again = true;
    return;
  }
  const entry: RoomRefresh = { refresh, reading: false, again: false };
  rooms.set(key, entry);
  const read = () => timers.set(() => {
    entry.reading = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.reading = false;
      if (entry.again) {
        entry.again = false;
        read();
      } else {
        rooms.delete(key);
      }
    };
    timers.set(release, ROOM_PENDING_APPROVALS_READ_TIMEOUT_MS);
    Promise.resolve()
      .then(() => entry.refresh())
      .catch(() => undefined)
      .then(release);
  }, ROOM_PENDING_APPROVALS_EVENT_DELAY_MS);
  read();
}

/**
 * Re-read the room `key`'s pending approvals on the viewer's approval Inbox
 * events. It re-reads that key itself (SWR's global mutate), not the
 * component's current key, so a read scheduled before a switch to another
 * room still re-reads the room it was for.
 */
export function useRoomPendingApprovalsRefresh(key: string | null) {
  const { mutate } = useSWRConfig();
  useEffect(() => {
    if (!key) return;
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const onAttention = (item: unknown) => {
      if (isApprovalAttentionEvent(item)) scheduleRoomPendingApprovalsRefresh(key, () => mutate(key));
    };
    for (const event of APPROVAL_ATTENTION_EVENTS) socket.on(event, onAttention);
    return () => {
      for (const event of APPROVAL_ATTENTION_EVENTS) socket.off(event, onAttention);
    };
  }, [key, mutate]);
}
