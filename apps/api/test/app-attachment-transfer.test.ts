import assert from 'node:assert/strict';
import test from 'node:test';
import { AppAttachmentTransferLimiter } from '../src/lib/app-attachment-transfer.js';

test('held I/O response aborts boundedly and retains the two transfer permits until underlying work settles', async () => {
  const limiter = new AppAttachmentTransferLimiter(25);
  const release: (() => void)[] = []; const entered: (() => void)[] = [];
  let published = 0;
  const call = () => limiter.run(async signal => {
    await new Promise<void>(resolve => { release.push(resolve); entered.shift()?.(); });
    signal.throwIfAborted(); published++; return true;
  });
  let firstStarted!: () => void; const firstReady = new Promise<void>(r => { firstStarted=r; }); entered.push(firstStarted);
  const first = call(); const firstDenied = assert.rejects(first); await firstReady;
  let secondStarted!: () => void; const secondReady = new Promise<void>(r => { secondStarted=r; }); entered.push(secondStarted);
  const second = call(); const secondDenied = assert.rejects(second); await secondReady;
  await Promise.all([firstDenied,secondDenied]);
  await assert.rejects(call()); assert.equal(release.length,2);
  release.forEach(r => r()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(published,0); assert.equal(await limiter.run(async () => true),true);
});
test('caller abort rejects held read and an already-aborted request allocates no transfer', async () => {
  const limiter = new AppAttachmentTransferLimiter(1000), controller = new AbortController();
  let release!: () => void, start!: () => void; const ready = new Promise<void>(r => { start=r; });
  const call = limiter.run(async signal => { await new Promise<void>(r => { release=r; start(); }); signal.throwIfAborted(); return true; },controller.signal);
  const denied = assert.rejects(call); await ready; controller.abort(); await denied;
  await assert.rejects(limiter.run(async () => true,controller.signal));
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await limiter.run(async () => true),true);
});
