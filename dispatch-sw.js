'use strict';
self.addEventListener('push', event => {
  let data = { title:'2FLY Dispatch', body:'A Dispatch task needs attention.', url:'./dispatch.html' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || '2FLY Dispatch', {
    body: data.body || 'A Dispatch task needs attention.',
    tag: data.url || '2fly-dispatch', renotify: true, data: { url: data.url || './dispatch.html' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './dispatch.html', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type:'window', includeUncontrolled:true });
    for (const client of windows) { if ('focus' in client) { await client.focus(); if ('navigate' in client) await client.navigate(target); return; } }
    if (clients.openWindow) await clients.openWindow(target);
  })());
});
