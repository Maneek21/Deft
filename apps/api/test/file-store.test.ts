import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileStore } from '../src/lib/file-store.js';

test('local file store keeps bytes inside its root and supports the full lifecycle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'deft-file-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalFileStore(root);

  await store.put('proof.txt', Buffer.from('private attachment'));
  assert.equal((await store.get('proof.txt')).toString('utf8'), 'private attachment');
  assert.equal((await store.stat('proof.txt'))?.size, 18);

  await store.delete('proof.txt');
  assert.equal(await store.stat('proof.txt'), null);
  await store.delete('proof.txt');

  for (const key of ['', '..', '../escape.txt', 'nested/escape.txt', 'nested\\escape.txt']) {
    await assert.rejects(store.put(key, Buffer.from('blocked')), /Invalid storage key/);
  }
});
