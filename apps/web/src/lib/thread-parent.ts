import { applyMessageEvent, type EventMessage, type MessageEvent } from './chat-message-events';

/** A live event as received, with the space its payload names when it names one. */
export type ScopedMessageEvent<T extends EventMessage = EventMessage> = MessageEvent<T> & { space_id?: string | null };

function eventMessageId(event: MessageEvent): string | null {
  switch (event.type) {
    case 'edited':
    case 'deleted':
      return event.id;
    case 'reaction_added':
    case 'reaction_removed':
      return event.message_id;
    default:
      return null;
  }
}

/**
 * An event changes an open thread's parent only when it is an edit, delete or
 * reaction of exactly that message and, when it names a space, the thread's space.
 */
export function eventTargetsThreadParent(event: ScopedMessageEvent, parentId: string, spaceId: string): boolean {
  if (eventMessageId(event) !== parentId) return false;
  return event.space_id == null || event.space_id === spaceId;
}

/** Applies a targeted event with the same reducer the message lists use. */
export function applyThreadParentEvent<T extends EventMessage>(parent: T, event: ScopedMessageEvent<T>, spaceId: string): T {
  if (!eventTargetsThreadParent(event as ScopedMessageEvent, parent.id, spaceId)) return parent;
  return applyMessageEvent([parent], event)[0] ?? parent;
}

function editedAt(message: { edited_at?: string | null }): number {
  const parsed = message.edited_at ? Date.parse(message.edited_at) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * A new copy of the shown parent from the caller. Another message replaces
 * it; the same message is merged, keeping the live reactions, a newer shown
 * edit and a shown delete.
 */
export function refreshThreadParent<T extends EventMessage>(current: T, incoming: T): T {
  if (incoming.id !== current.id) return incoming;
  let next: T = { ...current, ...incoming, reactions: current.reactions ?? incoming.reactions };
  if (editedAt(current) > editedAt(incoming)) {
    next = { ...next, content: current.content, edited_at: current.edited_at, metadata: current.metadata };
  }
  return current.is_deleted ? { ...next, is_deleted: true } : next;
}

/** A parent from a thread read, with the live events received during that read replayed on it. */
export function adoptFetchedThreadParent<T extends EventMessage>(
  current: T, fetched: T | null | undefined, events: readonly ScopedMessageEvent<T>[], spaceId: string,
): T {
  if (!fetched || fetched.id !== current.id) return current;
  // A read's reactions are authoritative; reactions received during it are replayed.
  const merged: T = { ...refreshThreadParent(current, fetched), reactions: fetched.reactions ?? current.reactions };
  return events.reduce((next, event) => applyThreadParentEvent(next, event, spaceId), merged);
}
