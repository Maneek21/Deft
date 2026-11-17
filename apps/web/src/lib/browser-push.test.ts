import test from 'node:test';
import assert from 'node:assert/strict';
import { activePushRegistration, currentPushDevice } from './browser-push';

test('another device does not enable this browser, and removed subscriptions can be enabled again', async () => {
  const endpoint = 'https://push.example.test/phone';
  let subscription: { endpoint: string } | null = null;
  const serviceWorker = {
    getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }),
  } as unknown as ServiceWorkerContainer;
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))).toString('hex');
  const devices = [{ id: 'desktop', endpoint_hash: 'other' }];
  assert.equal(await currentPushDevice(serviceWorker, devices), null);
  subscription = { endpoint };
  assert.equal(await currentPushDevice(serviceWorker, devices), null);
  devices.push({ id: 'phone', endpoint_hash: hash });
  assert.equal(await currentPushDevice(serviceWorker, devices), 'phone');
  assert.equal(await currentPushDevice(serviceWorker, devices.slice(0, 1)), null);
});

test('Enable waits for a slow activation before subscribing', async () => {
  let activate!: (registration: ServiceWorkerRegistration) => void;
  let subscribed = false;
  const registration = { pushManager: { subscribe: async () => { subscribed = true; } } } as unknown as ServiceWorkerRegistration;
  const serviceWorker = {
    register: async () => registration,
    ready: new Promise<ServiceWorkerRegistration>((resolve) => { activate = resolve; }),
  } as unknown as ServiceWorkerContainer;
  const enabling = activePushRegistration(serviceWorker).then((active) => active.pushManager.subscribe());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(subscribed, false);
  activate(registration);
  await enabling;
  assert.equal(subscribed, true);
});

test('Enable gives a clear error when activation never completes', async () => {
  const serviceWorker = {
    register: async () => ({}),
    ready: new Promise(() => {}),
  } as unknown as ServiceWorkerContainer;
  await assert.rejects(activePushRegistration(serviceWorker, 10), /did not activate.*try Enable again/);
});
