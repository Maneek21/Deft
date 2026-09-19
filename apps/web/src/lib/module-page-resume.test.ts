import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeModulePageResume } from './module-page-resume';
import { setActiveSessionCacheScope } from './session-cache';

test('focus/reconnect refresh the active infinite controller; hidden, duplicate and old-session events do not', () => {
  const browser = new EventTarget();
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let time = 0;
  let calls = 0;
  setActiveSessionCacheScope('session-a');
  const stop = subscribeModulePageResume('session-a', async () => { calls++; }, browser, page, () => time);
  try {
    browser.dispatchEvent(new Event('focus'));
    page.dispatchEvent(new Event('visibilitychange'));
    assert.equal(calls, 1);
    time += 5_000;
    browser.dispatchEvent(new Event('online'));
    assert.equal(calls, 2);
    time += 5_000;
    page.visibilityState = 'hidden';
    browser.dispatchEvent(new Event('focus'));
    assert.equal(calls, 2);
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    assert.equal(calls, 3);
    setActiveSessionCacheScope('session-b');
    time += 5_000;
    browser.dispatchEvent(new Event('online'));
    assert.equal(calls, 3);
    stop();
    setActiveSessionCacheScope('session-a');
    browser.dispatchEvent(new Event('focus'));
    assert.equal(calls, 3);
  } finally {
    stop();
    setActiveSessionCacheScope(null);
  }
});
