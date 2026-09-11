import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteSaveCoordinator } from './note-save-coordinator';

test('does not report saved while a body edit is still pending behind a title save', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  const coordinator = new NoteSaveCoordinator(async (payload) => {
    requests.push(payload);
    return true;
  }, status => statuses.push(status));

  const bodyRevision = coordinator.markDirty('content');
  const titleRevision = coordinator.markDirty('title');
  await coordinator.save('title', titleRevision, { title: 'Changed title' });

  assert.equal(coordinator.status, 'saving');
  await coordinator.save('content', bodyRevision, { content: '<p>Changed body</p>' });
  assert.equal(coordinator.status, 'saved');
  assert.deepEqual(requests, [
    { title: 'Changed title' },
    { content: '<p>Changed body</p>' },
  ]);
  assert.equal(statuses.includes('saved'), true);
});

test('keeps a failed field dirty and never reports saved after an HTTP failure', async () => {
  const coordinator = new NoteSaveCoordinator(async () => false);
  const revision = coordinator.markDirty('content');

  await coordinator.save('content', revision, { content: '<p>Not persisted</p>' });

  assert.equal(coordinator.status, 'error');
  assert.equal(coordinator.isDirty('content'), true);
});

test('serializes note writes so delayed responses cannot overwrite newer fields out of order', async () => {
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const coordinator = new NoteSaveCoordinator(async (payload) => {
    started.push(Object.keys(payload)[0]);
    await new Promise<void>(resolve => releases.push(resolve));
    return true;
  });
  const bodyRevision = coordinator.markDirty('content');
  const titleRevision = coordinator.markDirty('title');

  const bodySave = coordinator.save('content', bodyRevision, { content: 'body' });
  const titleSave = coordinator.save('title', titleRevision, { title: 'title' });
  await Promise.resolve();
  assert.deepEqual([...started], ['content']);
  releases.shift()?.();
  await bodySave;
  await Promise.resolve();
  assert.deepEqual([...started], ['content', 'title']);
  releases.shift()?.();
  await Promise.all([bodySave, titleSave]);
  assert.equal(coordinator.status, 'saved');
});

test('awaitIdle waits for a debounce-fired in-flight failure before Back decides to leave', async () => {
  let release!: (ok: boolean) => void;
  const coordinator = new NoteSaveCoordinator(() => new Promise<boolean>(resolve => { release = resolve; }));
  const revision = coordinator.markDirty('content');
  void coordinator.save('content', revision, { content: 'delayed body' });
  await Promise.resolve();

  let settled = false;
  const idle = coordinator.awaitIdle().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  release(false);
  await idle;
  assert.equal(coordinator.status, 'error');
});

test('a new dirty edit made while Back awaits an older save keeps the editor unsettled', async () => {
  let release!: () => void;
  const coordinator = new NoteSaveCoordinator(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return true;
  });
  const firstRevision = coordinator.markDirty('content');
  void coordinator.save('content', firstRevision, { content: 'first edit' });
  await Promise.resolve();

  const idle = coordinator.awaitIdle();
  coordinator.markDirty('content');
  release();
  await idle;

  assert.equal(coordinator.status, 'saving');
  assert.equal(coordinator.isDirty('content'), true);
});
