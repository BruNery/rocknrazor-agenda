/* Service worker mínimo: só torna a app instalável. Sem cache de propósito: horários desatualizados são pior do que nenhuns. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
