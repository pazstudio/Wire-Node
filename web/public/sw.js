// Wire-Node service worker: lets pages that were opened before be viewed again without a
// connection (e.g. on the workshop floor). Changes still need the server.
//
// - App files (/assets/*, hashed names) and pictures (/uploads/*, never reused): cache first.
// - Pages: network first, falling back to the cached app shell.
// - API reads (GET /api/*): network first, falling back to the last answer seen.
// Only runs on HTTPS or localhost (browsers do not allow service workers on plain HTTP).
const VERSION = 'wn-v1';
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const API = `${VERSION}-api`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add('/')).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Signing out clears the saved API answers, so the next person on this device does not see them.
self.addEventListener('message', (event) => {
  if (event.data === 'clear-api-cache') event.waitUntil(caches.delete(API));
});

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(request)) || (fallbackUrl && (await caches.match(fallbackUrl)));
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('X-Wire-Node-Offline', '1');
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Downloads that record something (wiring summary export) and backups are never served from cache.
  if (/\/(wiring\.md|backup)(\/|$|\?)/.test(url.pathname) || url.pathname.startsWith('/api/auth/')) return;
  if (req.mode === 'navigate') return event.respondWith(networkFirst(req, SHELL, '/'));
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/uploads/')) return event.respondWith(cacheFirst(req));
  if (url.pathname.startsWith('/api/')) return event.respondWith(networkFirst(req, API));
});
