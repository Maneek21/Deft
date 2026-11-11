/**
 * Live chat socket events as data, and one pure reducer that applies them to
 * a message list. The live socket handlers and the replay after a history
 * read both use it. Every case is idempotent, so replaying an event the
 * server state already reflects changes nothing.
 */

export type ChatReaction = { emoji: string; count: number; users: string[] };

export type EventMessage = {
  id: string;
  created_at: string;
  content?: string;
  edited_at?: string | null;
  is_deleted?: boolean;
  is_pinned?: boolean;
  reactions?: ChatReaction[];
  reply_count?: number;
  latest_reply_at?: string | null;
  metadata?: unknown;
};

export type MessageEvent<T extends EventMessage = EventMessage> =
  | { type: 'new'; message: T }
  | { type: 'edited'; id: string; content: string; edited_at: string | null; metadata?: unknown }
  | { type: 'deleted'; id: string }
  | { type: 'reaction_added'; message_id: string; emoji: string; user_id: string }
  | { type: 'reaction_removed'; message_id: string; emoji: string; user_id: string }
  | { type: 'pinned'; message_id: string }
  | { type: 'unpinned'; message_id: string }
  | { type: 'thread_updated'; parent_id: string; reply_count: number; latest_reply_at: string | null };

function timeOf(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function updateOne<T extends EventMessage>(list: readonly T[], id: string, update: (message: T) => T): T[] {
  const index = list.findIndex((message) => message.id === id);
  if (index < 0) return list as T[];
  const current = list[index]!;
  const next = update(current);
  if (next === current) return list as T[];
  const copy = [...list];
  copy[index] = next;
  return copy;
}

function addReaction(reactions: readonly ChatReaction[], emoji: string, userId: string): ChatReaction[] | null {
  const existing = reactions.find((reaction) => reaction.emoji === emoji);
  if (existing?.users.includes(userId)) return null;
  if (existing) {
    return reactions.map((reaction) => reaction === existing
      ? { ...reaction, count: reaction.count + 1, users: [...reaction.users, userId] }
      : reaction);
  }
  return [...reactions, { emoji, count: 1, users: [userId] }];
}

function removeReaction(reactions: readonly ChatReaction[], emoji: string, userId: string): ChatReaction[] | null {
  const existing = reactions.find((reaction) => reaction.emoji === emoji);
  if (!existing || !existing.users.includes(userId)) return null;
  const users = existing.users.filter((user) => user !== userId);
  const count = existing.count - 1;
  if (count <= 0 || users.length === 0) return reactions.filter((reaction) => reaction !== existing);
  return reactions.map((reaction) => reaction === existing ? { ...reaction, count, users } : reaction);
}

/** Apply one event. Returns the same list when the event changes nothing. */
export function applyMessageEvent<T extends EventMessage>(list: readonly T[], event: MessageEvent<T>): T[] {
  switch (event.type) {
    case 'new': {
      if (list.some((message) => message.id === event.message.id)) return list as T[];
      const at = timeOf(event.message.created_at);
      let index = list.length;
      while (index > 0 && timeOf(list[index - 1]!.created_at) > at) index--;
      const copy = [...list];
      copy.splice(index, 0, event.message);
      return copy;
    }
    case 'edited':
      return updateOne(list, event.id, (message) => {
        // An edit older than what is shown (for example a fetched later edit) is stale.
        if (event.edited_at && message.edited_at && timeOf(event.edited_at) < timeOf(message.edited_at)) return message;
        return {
          ...message,
          content: event.content,
          edited_at: event.edited_at,
          metadata: event.metadata ?? message.metadata,
        };
      });
    case 'deleted':
      return updateOne(list, event.id, (message) => message.is_deleted === true ? message : { ...message, is_deleted: true });
    case 'reaction_added':
      return updateOne(list, event.message_id, (message) => {
        const reactions = addReaction(message.reactions ?? [], event.emoji, event.user_id);
        return reactions ? { ...message, reactions } : message;
      });
    case 'reaction_removed':
      return updateOne(list, event.message_id, (message) => {
        const reactions = removeReaction(message.reactions ?? [], event.emoji, event.user_id);
        return reactions ? { ...message, reactions } : message;
      });
    case 'pinned':
    case 'unpinned': {
      const pinned = event.type === 'pinned';
      return updateOne(list, event.message_id, (message) => message.is_pinned === pinned ? message : { ...message, is_pinned: pinned });
    }
    case 'thread_updated':
      return updateOne(list, event.parent_id, (message) => {
        // A count older than what is shown is stale.
        if (event.latest_reply_at && message.latest_reply_at && timeOf(event.latest_reply_at) < timeOf(message.latest_reply_at)) return message;
        return { ...message, reply_count: event.reply_count, latest_reply_at: event.latest_reply_at };
      });
    default:
      return list as T[];
  }
}

/** Apply events in order. */
export function replayMessageEvents<T extends EventMessage>(list: readonly T[], events: readonly MessageEvent<T>[]): T[] {
  return events.reduce<T[]>((current, event) => applyMessageEvent(current, event), list as T[]);
}
