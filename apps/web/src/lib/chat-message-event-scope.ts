export type ChatEventMessage = { id: string; space_id?: string; parent_id?: string | null; metadata?: Record<string, unknown> | null };

// Commit identity from a layout effect, never from an interruptible render.
export class ChatMessageEventScope {
  private current: { space: string; session: string | null } | null = null;
  commit(space: string, session: string | null) {
    const identity = { space, session };
    this.current = identity;
    return () => { if (this.current === identity) this.current = null; };
  }
  capture(space: string, session: string | null) {
    const identity = this.current;
    let active = true;
    const isCurrent = () => active && session !== null && identity !== null && this.current === identity && identity.space === space && identity.session === session;
    return { isCurrent, accepts: (messageSpace: string | undefined) => isCurrent() && messageSpace === space, dispose: () => { active = false; } };
  }
}

export function createChatMessageNewHandler<T extends ChatEventMessage>(ports: {
  visit: ReturnType<ChatMessageEventScope['capture']>;
  update: (updater: (previous: T[]) => T[]) => void;
  normalize: (message: T) => T;
  openThread: (parent: T) => void;
  scroll: () => void;
  schedule: (callback: () => void, delay: number) => unknown;
}) {
  return (message: T) => {
    if (!ports.visit.accepts(message.space_id)) return;
    if (message.parent_id) {
      if (message.metadata?.is_agent_reply) ports.update(previous => {
        if (!ports.visit.isCurrent()) return previous;
        const parent = previous.find(item => item.id === message.parent_id);
        if (parent) ports.schedule(() => { if (ports.visit.isCurrent()) ports.openThread(parent); }, 0);
        return previous;
      });
      return;
    }
    const normalized = ports.normalize(message);
    ports.update(previous => !ports.visit.isCurrent() || previous.some(item => item.id === normalized.id) ? previous : [...previous, normalized]);
    ports.schedule(() => { if (ports.visit.isCurrent()) ports.scroll(); }, 50);
  };
}
