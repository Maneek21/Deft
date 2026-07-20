import test from 'node:test';
import assert from 'node:assert/strict';
import { protectPushSubscription, revealPushSubscription } from '../src/lib/push-subscription.js';

test('push subscription credentials are encrypted at rest and recover exactly', () => {
  const source = {
    endpoint: 'https://push.example.test/subscription/one',
    p256dh: 'public-key-material-123456',
    auth: 'auth-secret-material',
  };
  const protectedValue = protectPushSubscription(source);
  assert.notEqual(protectedValue.endpoint, source.endpoint);
  assert.notEqual(protectedValue.p256dh, source.p256dh);
  assert.notEqual(protectedValue.auth, source.auth);
  assert.match(protectedValue.endpoint_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(revealPushSubscription(protectedValue), source);
});
