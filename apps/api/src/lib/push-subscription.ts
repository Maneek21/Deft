import { createHash } from 'node:crypto';
import { decrypt, encrypt } from './encryption.js';

type PushSubscriptionSecrets = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export function protectPushSubscription(subscription: PushSubscriptionSecrets) {
  return {
    endpoint: encrypt(subscription.endpoint),
    endpoint_hash: createHash('sha256').update(subscription.endpoint).digest('hex'),
    p256dh: encrypt(subscription.p256dh),
    auth: encrypt(subscription.auth),
  };
}

export function revealPushSubscription(subscription: Pick<PushSubscriptionSecrets, 'endpoint' | 'p256dh' | 'auth'>) {
  return {
    endpoint: decrypt(subscription.endpoint),
    p256dh: decrypt(subscription.p256dh),
    auth: decrypt(subscription.auth),
  };
}
