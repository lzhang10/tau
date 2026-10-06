// Tau Service Worker — minimal, just enables PWA install
// No aggressive caching since Tau connects to a live local server

const CACHE_NAME = 'tau-v1';

// Cache only the app shell on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // issue 170: precache under the registration scope (the SW is
      // registered at <base>sw.js, so the scope IS the base path).
      const base = self.registration.scope;
      return cache.addAll([
        '/',
        '/style.css',
        '/app.js',
        '/state.js',
        '/themes.js',
        '/markdown.js',
        '/message-renderer.js',
        '/tool-card.js',
        '/dialogs.js',
        '/session-sidebar.js',
        '/websocket-client.js',
        '/manifest.json',
      ].map((p) => new URL(p === '/' ? '' : p.slice(1), base).href));
    })
  );
  self.skipWaiting();
});

// Clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Network-first strategy — always try live server, fall back to cache
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't cache API/WebSocket requests
  if (url.pathname.startsWith(self.registration.scope + 'api/') ||
      url.pathname.startsWith(self.registration.scope + 'ws')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Update cache with fresh response
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline — serve from cache
        return caches.match(event.request).then((cached) => {
          return cached || new Response('Tau is offline — start your pi session to connect.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          });
        });
      })
  );
});
