import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeCreateIntent } from './native-create-intent';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test('retains an unresolved key for equal payloads and rotates it for edits or acknowledged success', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const access = `header.${btoa(JSON.stringify({ id: 'user', org_id: 'org', sid: 'tab-session' })).replace(/=+$/, '')}.signature`;
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  local.setItem('deft-access-token', access);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
  t.after(() => {
    for (const [name, descriptor] of [['window', originalWindow], ['localStorage', originalLocal], ['sessionStorage', originalSession]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  });

  const first = createNativeCreateIntent('message:space-a');
  const firstKey = await first.keyFor({ content: 'private draft', file_ids: ['file-1'] });
  assert.equal(await first.keyFor({ file_ids: ['file-1'], content: 'private draft' }), firstKey);
  const [concurrentFirst, concurrentSecond] = await Promise.all([
    first.keyFor({ content: 'private draft', file_ids: ['file-1'] }),
    first.keyFor({ file_ids: ['file-1'], content: 'private draft' }),
  ]);
  assert.equal(concurrentFirst, concurrentSecond, 'duplicate clicks share one unresolved intent key');
  assert.equal([...session.values.values()].some((value) => value.includes('private draft')), false, 'storage must not retain raw draft content');
  const reloaded = createNativeCreateIntent('message:space-a');
  assert.equal(await reloaded.keyFor({ content: 'private draft', file_ids: ['file-1'] }), firstKey, 'same tab reload retains unresolved intent');
  local.setItem('deft-access-token', `header.${btoa(JSON.stringify({ id: 'other-user', org_id: 'org', sid: 'other-session' })).replace(/=+$/, '')}.signature`);
  assert.notEqual(await reloaded.keyFor({ content: 'private draft', file_ids: ['file-1'] }), firstKey, 'a session change cannot reuse another user\'s intent');
  local.setItem('deft-access-token', access);
  const editedKey = await reloaded.keyFor({ content: 'edited draft', file_ids: ['file-1'] });
  assert.notEqual(editedKey, firstKey, 'changed payload rotates intent');
  reloaded.acknowledgeSuccess(firstKey);
  assert.equal(await reloaded.keyFor({ content: 'edited draft', file_ids: ['file-1'] }), editedKey, 'late success for an older intent cannot clear a newer edit');
  reloaded.acknowledgeSuccess(editedKey);
  assert.notEqual(await reloaded.keyFor({ content: 'edited draft', file_ids: ['file-1'] }), editedKey, 'success clears intent for a deliberate equal create');
});

test('storage failures do not prevent a create intent', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const access = `header.${btoa(JSON.stringify({ id: 'user', org_id: 'org', sid: 'tab-session' })).replace(/=+$/, '')}.signature`;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => access } });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  } });
  t.after(() => {
    for (const [name, descriptor] of [['window', originalWindow], ['localStorage', originalLocal], ['sessionStorage', originalSession]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  });
  const intent = createNativeCreateIntent('event:create-modal');
  const key = await intent.keyFor({ title: 'Private event' });
  assert.equal(typeof key, 'string');
  assert.doesNotThrow(() => intent.acknowledgeSuccess(key));
  assert.doesNotThrow(() => intent.cancel());
});
