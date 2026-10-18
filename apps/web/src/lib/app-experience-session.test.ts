import assert from 'node:assert/strict';
import test from 'node:test';
import { experienceLifetimeIsCurrent } from './app-experience-session';

test('delayed responses cannot outlive known session or exposure deadlines', async () => {
  let now = 1000;
  const sessionExpiry = new Date(3000).toISOString();
  const exposureExpiry = new Date(2000).toISOString();
  let finish!: () => void;
  const response = new Promise<void>(resolve => { finish = resolve; });
  const live = async () => {
    if (!experienceLifetimeIsCurrent(sessionExpiry, exposureExpiry, now)) return false;
    await response;
    return experienceLifetimeIsCurrent(sessionExpiry, exposureExpiry, now);
  };
  const pending = live(); now = 2000; finish();
  assert.equal(await pending, false);
  assert.equal(experienceLifetimeIsCurrent(sessionExpiry, undefined, 3000), false);
  assert.equal(experienceLifetimeIsCurrent('invalid', exposureExpiry, 1000), false);
  assert.equal(experienceLifetimeIsCurrent(sessionExpiry, 'invalid', 1000), false);
});
