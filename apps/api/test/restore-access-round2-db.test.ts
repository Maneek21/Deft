import assert from 'node:assert/strict';
import test from 'node:test';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && /^\/deft_test/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
})();

test('restore access round 2: placeholder (behaviours covered by restore-access-db and app-restore-access-http-db)',
  { skip: !safe }, async () => {
    assert.ok(true);
  });