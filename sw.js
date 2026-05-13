/* Sakinah Ridge Farm service worker.
 *
 * Goals:
 *   1. Make the site installable as a PWA (works alongside manifest.json).
 *   2. Provide a basic "stale-while-revalidate" cache for static assets so
 *      navigations are instant on a flaky connection.
 *   3. Never cache API/auth responses or POST/PUT/DELETE requests so the
 *      app stays correct against a constantly changing backend.
 */

const CACHE_NAME = 'srf-cache-v1';
const PRECACHE = [
  '/',
  '/index.html',
  '/about.html',
  '/journal.html',
  '/manifest.json',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Best-effort precache; ignore individual failures so the SW still
      // activates if a single resource (e.g. a not-yet-deployed page) 404s.
      Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API responses, auth, billing webhooks, CSRF tokens, RSS, or uploads.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/') ||
    url.pathname.startsWith('/stripe-') ||
    url.pathname === '/webhook' ||
    url.pathname === '/feed.xml' ||
    url.pathname === '/healthz'
  ) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          // Only cache successful, basic (same-origin) responses.
          if (res && res.ok && res.type === 'basic') {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
