/**
 * Socket boundary for the mounted chat tests. `getSocket` returns an in-memory
 * emitter so tests can deliver server events without a live Deft API.
 */
export * from '../../src/lib/socket';

type Listener = (...args: unknown[]) => void;

const listeners = new Map<string, Set<Listener>>();
const emitted: Array<{ event: string; args: unknown[] }> = [];

const socket = {
  connected: true,
  on(event: string, listener: Listener) {
    const bucket = listeners.get(event) ?? new Set<Listener>();
    bucket.add(listener);
    listeners.set(event, bucket);
    return socket;
  },
  off(event: string, listener: Listener) {
    listeners.get(event)?.delete(listener);
    return socket;
  },
  emit(event: string, ...args: unknown[]) {
    emitted.push({ event, args });
    return socket;
  },
  removeAllListeners() {
    listeners.clear();
    return socket;
  },
};

export function getSocket(_token?: string) {
  return socket;
}

export function deliver(event: string, payload?: unknown) {
  for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
}

export function emittedEvents() {
  return emitted.map(entry => entry.event);
}

declare global {
  interface Window {
    __deftDeliver?: typeof deliver;
    __deftEmitted?: typeof emittedEvents;
  }
}

if (typeof window !== 'undefined') {
  window.__deftDeliver = deliver;
  window.__deftEmitted = emittedEvents;
}
