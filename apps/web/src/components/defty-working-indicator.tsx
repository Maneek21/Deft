'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { getSocket } from '@/lib/socket';

export type DeftyWorkingEvent = {
  space_id: string;
  thread_id: string | null;
  agent_user_id: string;
  agent_name: 'Defty';
  state: 'started' | 'finished';
  label: string;
};

type DeftyWork = DeftyWorkingEvent & { expiresAt: number };
type WorkingMessage = { space_id?: string; parent_id?: string | null; user_id: string };
type WorkingAction =
  | { type: 'working'; event: DeftyWorkingEvent; now: number }
  | { type: 'message'; message: WorkingMessage }
  | { type: 'expire'; now: number }
  | { type: 'clear' };

export function deftyWorkingReducer(state: readonly DeftyWork[], action: WorkingAction): readonly DeftyWork[] {
  // A dropped socket can never deliver the matching finish, so drop the row
  // instead of leaving a stale "reading…" indicator for two minutes.
  if (action.type === 'clear') return state.length === 0 ? state : [];
  const remaining = state.filter(item => {
    if (action.type === 'expire') return item.expiresAt > action.now;
    const scope = action.type === 'working' ? action.event : {
      space_id: action.message.space_id,
      thread_id: action.message.parent_id ?? null,
      agent_user_id: action.message.user_id,
    };
    return item.space_id !== scope.space_id || item.thread_id !== scope.thread_id
      || item.agent_user_id !== scope.agent_user_id;
  });
  if (action.type === 'working' && action.event.state === 'started') {
    return [...remaining, { ...action.event, expiresAt: action.now + 120_000 }];
  }
  return remaining.length === state.length ? state : remaining;
}

export function visibleDeftyWork(
  state: readonly DeftyWork[], spaceId: string, threadId: string | null, inlineRootIds: readonly string[] = [],
): readonly DeftyWork[] {
  return state.filter(item => item.space_id === spaceId && (threadId === null
    ? item.thread_id === null || inlineRootIds.includes(item.thread_id)
    : item.thread_id === threadId));
}

const EMPTY_WORK: readonly DeftyWork[] = [];
type WorkingStore = {
  state: readonly DeftyWork[];
  listeners: Set<() => void>;
  dispose: () => void;
};
// Share active work between the channel and a panel opened after the start event.
// Stores live only while a view is subscribed and are isolated by auth session.
const stores = new Map<string, WorkingStore>();

function createWorkingStore(spaceId: string, token: string): WorkingStore {
  const socket = getSocket(token);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const store: WorkingStore = { state: EMPTY_WORK, listeners: new Set(), dispose: () => {} };
  const update = (action: WorkingAction) => {
    const next = deftyWorkingReducer(store.state, action);
    if (next === store.state) return;
    store.state = next;
    clearTimeout(timeout);
    if (next.length > 0) {
      const expiresAt = Math.min(...next.map(item => item.expiresAt));
      timeout = setTimeout(() => update({ type: 'expire', now: Date.now() }), Math.max(0, expiresAt - Date.now()));
    }
    store.listeners.forEach(listener => listener());
  };
  const onWorking = (event: DeftyWorkingEvent) => {
    if (event.space_id === spaceId && event.agent_name === 'Defty') update({ type: 'working', event, now: Date.now() });
  };
  const onMessage = (message: WorkingMessage) => {
    if (message.space_id === spaceId) update({ type: 'message', message });
  };
  const onDisconnect = () => update({ type: 'clear' });
  socket.on('agent:working', onWorking);
  socket.on('message:new', onMessage);
  socket.on('disconnect', onDisconnect);
  store.dispose = () => {
    clearTimeout(timeout);
    socket.off('agent:working', onWorking);
    socket.off('message:new', onMessage);
    socket.off('disconnect', onDisconnect);
  };
  return store;
}

export function useDeftyWorking(spaceId: string, sessionCacheScope: string | null): readonly DeftyWork[] {
  const key = JSON.stringify([sessionCacheScope, spaceId]);
  const subscribe = useCallback((listener: () => void) => {
    if (!sessionCacheScope) return () => {};
    const token = localStorage.getItem('deft-access-token');
    if (!token) return () => {};
    let store = stores.get(key);
    if (!store) {
      store = createWorkingStore(spaceId, token);
      stores.set(key, store);
    }
    const activeStore = store;
    activeStore.listeners.add(listener);
    return () => {
      activeStore.listeners.delete(listener);
      if (activeStore.listeners.size === 0) {
        activeStore.dispose();
        stores.delete(key);
      }
    };
  }, [key, sessionCacheScope, spaceId]);
  const getSnapshot = useCallback(() => stores.get(key)?.state ?? EMPTY_WORK, [key]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_WORK);
}

export function DeftyWorkingIndicator() {
  return (
    <div role="status" className="flex flex-shrink-0 items-center gap-2 px-6 py-1 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
      <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full motion-reduce:animate-none" style={{ background: 'var(--primary)' }} />
      <span><span style={{ color: 'var(--foreground-secondary)' }}>Defty</span> is reading the conversation…</span>
    </div>
  );
}
