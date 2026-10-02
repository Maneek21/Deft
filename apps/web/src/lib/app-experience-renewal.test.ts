import assert from 'node:assert/strict';
import test from 'node:test';
import { experienceRenewalDue, settleDispatchedExperienceWrites } from './app-experience-renewal';

test('renewal warning uses the earlier original deadline and excludes expired authority', () => {
  const now = 1_000_000, iso = (offset: number) => new Date(now + offset).toISOString();
  assert.equal(experienceRenewalDue(iso(120_000), iso(90_000), now), true);
  assert.equal(experienceRenewalDue(iso(90_001), undefined, now), false);
  assert.equal(experienceRenewalDue(iso(0), iso(90_000), now), false);
  assert.equal(experienceRenewalDue('invalid', undefined, now), false);
});

test('renewal bounds known writes and never waits for a later Worker write', async () => {
  let finish!: () => void;
  const writes = new Set<Promise<unknown>>([new Promise<void>(resolve => { finish = resolve; })]);
  const settled = settleDispatchedExperienceWrites(writes, 100);
  writes.add(new Promise(() => {})); finish();
  assert.equal(await settled, true);
  assert.equal(await settleDispatchedExperienceWrites([new Promise(() => {})], 5), false);
  assert.equal(await settleDispatchedExperienceWrites([Promise.reject(new Error('write failed'))]), false);
});
