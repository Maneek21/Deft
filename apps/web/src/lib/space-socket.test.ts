import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeToSpace } from './space-socket';

function socketHarness(connected: boolean) {
  const emitted: Array<[string, ...unknown[]]> = [];
  const listeners = new Map<string, Set<() => void>>();
  return {
    socket: {
      connected,
      emit(event: string, ...args: unknown[]) {
        emitted.push([event, ...args]);
      },
      on(event: string, listener: () => void) {
        const handlers = listeners.get(event) ?? new Set();
        handlers.add(listener);
        listeners.set(event, handlers);
      },
      off(event: string, listener: () => void) {
        listeners.get(event)?.delete(listener);
      },
    },
    emitted,
    fire(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

test('joins immediately and rejoins after reconnect', () => {
  const harness = socketHarness(true);
  const unsubscribe = subscribeToSpace(harness.socket, 'space-1');

  harness.fire('connect');
  assert.deepEqual(harness.emitted, [
    ['space:join', 'space-1'],
    ['space:join', 'space-1'],
  ]);

  unsubscribe();
  assert.deepEqual(harness.emitted.at(-1), ['space:leave', 'space-1']);
});

test('waits for connect before joining a disconnected socket', () => {
  const harness = socketHarness(false);
  subscribeToSpace(harness.socket, 'space-2');

  assert.deepEqual(harness.emitted, []);
  harness.fire('connect');
  assert.deepEqual(harness.emitted, [['space:join', 'space-2']]);
});
