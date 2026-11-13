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

/** A parent from a thread read, with the live events received during that read replayed on it. */
export function adoptFetchedThreadParent<T extends EventMessage>(
  current: T, fetched: Partial<T> | null | undefined, events: readonly ScopedMessageEvent<T>[], spaceId: string,
): T {
  if (!fetched || fetched.id !== current.id) return current;
  return events.reduce((next, event) => applyThreadParentEvent(next, event, spaceId), { ...current, ...fetched } as T);
}
