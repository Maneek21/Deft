import test from 'node:test';
import assert from 'node:assert/strict';
import { activePushRegistration } from './browser-push';

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
