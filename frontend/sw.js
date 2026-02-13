// ═══════════════════════════════════════════════════════
// FIDDO — Service Worker (PWA minimal)
// Strategy: Network-first, no cache
// Purpose: Enable PWA install + standalone mode on iOS/Android
// ═══════════════════════════════════════════════════════

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
