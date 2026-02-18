// ═══════════════════════════════════════════════════════
// FIDDO Client — Service Worker (PWA + custom 502)
// Strategy: Network-first, cache 502 fallback page
// ═══════════════════════════════════════════════════════

var CACHE = 'fiddo-client-fallback-v1';
var FALLBACK = '/app/502.html';

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.add(FALLBACK);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  // Only intercept navigation requests (HTML pages)
  if (e.request.mode !== 'navigate') {
    return;
  }

  e.respondWith(
    fetch(e.request).then(function(response) {
      // Intercept 502, 503, 504
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        return caches.match(FALLBACK).then(function(cached) {
          return cached || response;
        });
      }
      return response;
    }).catch(function() {
      // Network error (offline, DNS failure, etc.)
      return caches.match(FALLBACK).then(function(cached) {
        return cached || new Response('Service indisponible', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      });
    })
  );
});
