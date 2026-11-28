/* PitStop-Sports Service Worker — Network-First App Shell + Preservação de rally-offline-tiles-v1 */
const APP_SHELL_CACHE = 'pitstop-app-shell-v1';
const STATIC_ASSET_CACHE = 'pitstop-static-v1';
const OFFLINE_TILES_CACHE = 'rally-offline-tiles-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              key !== OFFLINE_TILES_CACHE &&
              key !== APP_SHELL_CACHE &&
              key !== STATIC_ASSET_CACHE
          )
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event?.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isAppShellRequest(request, url) {
  if (request.mode === 'navigate') return true;
  const path = url.pathname.toLowerCase();
  if (
    path === '/' ||
    path.endsWith('/index.html') ||
    path.endsWith('.html') ||
    path.endsWith('.js') ||
    path.endsWith('.mjs') ||
    path.endsWith('.css') ||
    path.endsWith('/manifest.webmanifest')
  ) {
    return true;
  }
  return false;
}

function isStaticAssetRequest(url) {
  const path = url.pathname.toLowerCase();
  return (
    path.endsWith('.png') ||
    path.endsWith('.jpg') ||
    path.endsWith('.jpeg') ||
    path.endsWith('.webp') ||
    path.endsWith('.svg') ||
    path.endsWith('.ico') ||
    path.endsWith('.woff') ||
    path.endsWith('.woff2') ||
    path.endsWith('.wasm')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Never intercept external map tile servers, OSRM, Open-Meteo, Supabase, or APIs;
  // map tiles are managed persistently by rally-offline-tiles-v1 inside the app.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never cache local /api/* calls
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Network-First for index.html, navigation, JS, CSS, and manifest
  if (isAppShellRequest(request, url)) {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request, { cache: 'no-store' });
          if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(APP_SHELL_CACHE);
            cache.put(request, networkResponse.clone()).catch(() => {});
          }
          return networkResponse;
        } catch {
          const cached = await caches.match(request, { ignoreSearch: true });
          if (cached) return cached;
          if (request.mode === 'navigate') {
            const fallbackIndex = await caches.match('/index.html', { ignoreSearch: true });
            if (fallbackIndex) return fallbackIndex;
          }
          return new Response('Offline', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })()
    );
    return;
  }

  // Static images/icons/fonts/wasm: Network-First with cache fallback so updates stay fresh offline too
  if (isStaticAssetRequest(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_ASSET_CACHE);
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.ok) {
            cache.put(request, networkResponse.clone()).catch(() => {});
          }
          return networkResponse;
        } catch {
          const cached = await cache.match(request);
          if (cached) return cached;
          return new Response('', { status: 404 });
        }
      })()
    );
  }
});
