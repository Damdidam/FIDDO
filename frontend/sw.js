// ═══════════════════════════════════════════════════════
// FIDDO — Service Worker (PWA + custom 502)
// Strategy: Network-first, cache 502 fallback page
// v2 — more resilient: re-caches fallback on every success
// ═══════════════════════════════════════════════════════

var CACHE = 'fiddo-fallback-v2';
var FALLBACK = '/502.html';

// Inline fallback in case cached 502.html is missing
var INLINE_FALLBACK = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FIDDO — Maintenance</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a1a24;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;color:#fff}.c{background:rgba(255,255,255,.07);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.1);border-radius:24px;padding:40px 28px;max-width:400px;width:100%;text-align:center}.logo{font-size:24px;font-weight:800;color:#0891B2;margin-bottom:20px}h1{font-size:20px;margin-bottom:8px}.sub{font-size:14px;color:rgba(255,255,255,.5);margin-bottom:24px}.btn{padding:12px 24px;background:#0891B2;color:#fff;font-size:15px;font-weight:700;border-radius:12px;border:none;cursor:pointer;font-family:inherit}.pulse{width:8px;height:8px;border-radius:50%;background:#22d3ee;display:inline-block;animation:p 2s infinite;margin-right:8px}@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}.st{font-size:13px;color:rgba(255,255,255,.4);margin-bottom:20px}</style></head><body><div class="c"><div class="logo">FIDDO</div><h1>On revient tout de suite</h1><p class="sub">Le serveur est momentanément indisponible.</p><p class="st"><span class="pulse"></span>Reconnexion automatique...</p><button class="btn" onclick="location.reload()">Réessayer</button></div><script>var n=0;function r(){if(n++>30)return;fetch(location.href,{method:"HEAD",cache:"no-store"}).then(function(x){x.ok?location.reload():setTimeout(r,8e3)}).catch(function(){setTimeout(r,8e3)})}setTimeout(r,8e3)</script></body></html>';

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.add(FALLBACK);
    }).catch(function(err) {
      // Install even if 502 page can't be fetched — we have inline fallback
      console.warn('[SW] Could not cache fallback page:', err);
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
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  // Only intercept navigation requests (HTML pages)
  if (e.request.mode !== 'navigate') {
    return;
  }

  e.respondWith(
    fetch(e.request).then(function(response) {
      // On success, re-cache the 502 page in background (keeps it fresh)
      if (response.ok) {
        caches.open(CACHE).then(function(cache) {
          cache.add(FALLBACK).catch(function() {});
        });
      }

      // Intercept 502, 503, 504
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        return caches.match(FALLBACK).then(function(cached) {
          return cached || new Response(INLINE_FALLBACK, {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        });
      }
      return response;
    }).catch(function() {
      // Network error (offline, DNS failure, etc.)
      return caches.match(FALLBACK).then(function(cached) {
        return cached || new Response(INLINE_FALLBACK, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      });
    })
  );
});
