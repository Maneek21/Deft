export async function activePushRegistration(serviceWorker: ServiceWorkerContainer, timeoutMs = 15_000) {
  await serviceWorker.register('/deft-sw.js');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Notification service worker did not activate. Please try Enable again.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
export async function currentPushDevice(
  serviceWorker: ServiceWorkerContainer,
  devices: Array<{ id: string; endpoint_hash: string }>,
) {
  const registration = await serviceWorker.getRegistration('/deft-sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return devices.find((device) => device.endpoint_hash === hash)?.id ?? null;
}
