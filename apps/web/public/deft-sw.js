self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  event.waitUntil(self.registration.showNotification(payload.title || 'Deft', {
    body: payload.body || 'Open Deft to review.',
    icon: '/brand/deft-icon.png',
    badge: '/brand/deft-icon.png',
    tag: payload.tag || 'deft-attention',
    renotify: false,
    data: { url: payload.url || '/inbox?lane=needs_you' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/inbox?lane=needs_you', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ('focus' in client) {
        client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
