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
