import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowAccountLoginAttempt } from '../src/routes/auth.js';

test('login guard allows ten attempts per account and isolates other accounts', () => {
  const email = `rate-limit-${Date.now()}@deft.invalid`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal(allowAccountLoginAttempt(email), true);
  }
  assert.equal(allowAccountLoginAttempt(email), false);
  assert.equal(allowAccountLoginAttempt(`other-${email}`), true);
});
