import test from 'node:test';
import assert from 'node:assert/strict';
import { watchCatchUp, type CatchUpResult } from './space-socket';

function socketHarness(connected: boolean) {
  const listeners = new Map<string, Set<() => void>>();
  const socket = {
    connected,
    on(event: string, listener: () => void) {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(listener);
      listeners.set(event, handlers);
    },
    off(event: string, listener: () => void) {
      listeners.get(event)?.delete(listener);
    },
  };
  return {
    socket,
    fire(event: 'connect' | 'disconnect') {
      socket.connected = event === 'connect';
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('R2-3: a conversation opened while the socket is down catches up on the next connect', async () => {
  const { socket, fire } = socketHarness(false);
  let runs = 0;
  const watch = watchCatchUp(socket, 'thread:opened-offline', async () => { runs++; return 'ok'; });
  fire('connect');
  await flush();
  assert.equal(runs, 1);
  fire('connect'); // an ordinary later connect without a drop does nothing
  await flush();
  assert.equal(runs, 1);
  watch.dispose();
});

test('R2-3: the need to catch up survives the watcher being recreated', async () => {
  const first = socketHarness(true);
  const a = watchCatchUp(first.socket, 'space:recreated', async () => 'ok');
  first.fire('disconnect');
  a.dispose();
  first.socket.connected = true; // reconnected before the new watcher starts
  let runs = 0;
  const b = watchCatchUp(first.socket, 'space:recreated', async () => { runs++; return 'ok'; });
  await b.retry();
  assert.equal(runs, 1);
  b.dispose();
});

test('R2-4: a failed catch-up keeps the flag until one succeeds', async () => {
  const { socket, fire } = socketHarness(true);
  const results: CatchUpResult[] = ['failed', 'ok'];
  let runs = 0;
  const watch = watchCatchUp(socket, 'space:failing', async () => { runs++; return results.shift()!; });
  fire('disconnect');
  fire('connect');
  await flush();
  assert.equal(runs, 1);
  fire('connect'); // still pending after the failure
  await flush();
  assert.equal(runs, 2);
  fire('connect'); // succeeded: nothing pending
  await flush();
  assert.equal(runs, 2);
  watch.dispose();
});
