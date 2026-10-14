/* Service worker da app de marcações: recebe avisos (push) e abre a agenda ao tocar no aviso.
   Propositadamente sem cache offline: uma agenda desatualizada é pior do que nenhuma. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : '' }; }
  const title = typeof m.title === 'string' && m.title ? m.title : "Rock n' Razor";
  e.waitUntil(self.registration.showNotification(title, {
    body: typeof m.body === 'string' ? m.body : '',
    tag: typeof m.tag === 'string' ? m.tag : undefined,
    renotify: !!m.tag,
    icon: 'icons/icon-192.png', badge: 'icons/badge.png',
    data: { url: typeof m.url === 'string' ? m.url : './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope);
  if (url.origin !== self.location.origin) return; // só abre páginas da própria app
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope)) { c.navigate(url.href); return c.focus(); } }
    return self.clients.openWindow(url.href);
  }));
});
