// Offline app-shell cache. API responses are always fetched live (market data must be fresh).
const CACHE = 'q26-shell-v3';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

// The page's own scripts and styles (/assets/… named in index.html) are cached with the shell, so a page
// opened while the server is down still starts and shows "waiting for the server" instead of a blank screen.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(async (c) => {
        await c.addAll(SHELL);
        const html = await (await c.match('/index.html', { ignoreVary: true })).text();
        const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
        await c.addAll(assets);
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html', { ignoreVary: true })));
    return;
  }
  e.respondWith(
    // ignoreVary: the server adds "Vary: Origin" (CORS) and module scripts are requested with an Origin header.
    caches.match(e.request, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }),
    ),
  );
});
