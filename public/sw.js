/**
 * SERVICE WORKER — OpsOS Offline Support
 * 
 * Strategy:
 *   - App shell (HTML, JS, CSS): Cache-first (instant load)
 *   - API requests: Network-first with offline fallback
 *   - Static assets: Cache-first
 *   - POST/PUT/DELETE: Queue for background sync
 * 
 * The SW does NOT handle data sync — that's the Sync Engine's job.
 * The SW ensures the app LOADS offline and API GETs have cached fallbacks.
 */

const CACHE_NAME = 'opsos-v1';
const STATIC_CACHE = 'opsos-static-v1';
const API_CACHE = 'opsos-api-v1';

// App shell — cached on install
const APP_SHELL = [
  '/',
  '/login',
  '/kds',
  '/delivery-board',
  '/admin/orders/new',
  '/admin/menu',
  '/admin/inventory',
  '/manifest.json',
];

// ─── Install: Pre-cache app shell ────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      // Cache app shell pages
      for (const url of APP_SHELL) {
        try {
          await cache.add(url);
        } catch (err) {
          console.warn(`[SW] Failed to cache ${url}:`, err);
        }
      }
    })
  );
  // Activate immediately (don't wait for old SW to stop)
  self.skipWaiting();
});

// ─── Activate: Clean old caches ──────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== API_CACHE && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  // Take control of all clients immediately
  self.clients.claim();
});

// ─── Fetch: Route-based caching strategy ─────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET for caching (mutations handled by Sync Engine)
  if (event.request.method !== 'GET') return;

  // Skip external requests
  if (url.origin !== self.location.origin) return;

  // API routes: Network-first with cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstWithCache(event.request, API_CACHE));
    return;
  }

  // Next.js static assets (_next/static): Cache-first
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(event.request, STATIC_CACHE));
    return;
  }

  // Next.js data routes (_next/data): Network-first
  if (url.pathname.startsWith('/_next/data/')) {
    event.respondWith(networkFirstWithCache(event.request, STATIC_CACHE));
    return;
  }

  // Everything else (pages): Network-first, fallback to cache, ultimate fallback to app shell
  event.respondWith(networkFirstWithAppShell(event.request));
});

// ─── Caching Strategies ──────────────────────────────────

/**
 * Cache-first: Try cache, fall back to network
 * Used for: static assets that rarely change
 */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Network-first with cache fallback
 * Used for: API responses
 */
async function networkFirstWithCache(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    // Return empty JSON for API calls when fully offline
    return new Response(JSON.stringify({ _offline: true, error: 'Offline' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Network-first with app shell fallback
 * Used for: HTML page navigations
 */
async function networkFirstWithAppShell(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Try exact match in cache
    const cached = await caches.match(request);
    if (cached) return cached;

    // Fallback: serve the root page (SPA will handle routing)
    const rootCached = await caches.match('/');
    if (rootCached) return rootCached;

    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

// ─── Minimal offline fallback page ───────────────────────

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpsOS — Offline</title>
  <style>
    body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #111827; color: white; }
    .container { text-align: center; padding: 2rem; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    p { color: #9ca3af; margin-bottom: 1.5rem; }
    button { background: #2563eb; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 0.5rem; font-size: 1rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="container">
    <div style="font-size: 3rem; margin-bottom: 1rem;">⚡</div>
    <h1>OpsOS</h1>
    <p>L'app si sta caricando. Se il problema persiste, ricarica la pagina.</p>
    <button onclick="location.reload()">Ricarica</button>
  </div>
</body>
</html>`;

// ─── Background Sync (Browser API) ──────────────────────
// This complements our custom Sync Engine for when the app is closed

self.addEventListener('sync', (event) => {
  if (event.tag === 'opsos-sync') {
    event.waitUntil(
      // Notify the app to run sync
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SYNC_REQUESTED' });
        });
      })
    );
  }
});

// ─── Push Notifications (future) ─────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'OpsOS', {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: data.url,
      })
    );
  } catch { /* ignore bad push data */ }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.notification.data) {
    event.waitUntil(self.clients.openWindow(event.notification.data));
  }
});
