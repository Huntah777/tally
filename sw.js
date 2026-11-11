/* Tally service worker — offline shell.
   Bump CACHE on every deploy that changes a SHELL file. */
const CACHE = 'tally-v2';
/* Large and only needed for receipts, so cached on first use instead of at
   install — a fresh install shouldn't cost 7 MB of mobile data. */
const LAZY = 'tally-lazy-v1';

const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/tally-icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/lib/engine.js',
  '/lib/importers.js',
  '/lib/receipt.js',
  '/lib/dishes.js',
  '/vendor/react.min.js',
  '/vendor/react-dom.min.js',
  '/vendor/babel.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE && k !== LAZY).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Fonts — stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const net = fetch(request).then((r) => { cache.put(request, r.clone()); return r; }).catch(() => cached);
      return cached || net;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // OCR reader, barcode library — cache on first use
  if (url.pathname.startsWith('/vendor/tesseract/') || url.pathname === '/vendor/zxing.min.js') {
    event.respondWith(caches.open(LAZY).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const r = await fetch(request);
      if (r.ok) cache.put(request, r.clone());
      return r;
    }));
    return;
  }

  // App shell — network first so deploys land immediately, cache when offline
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/lib/')) {
    event.respondWith(fetch(request).then((r) => {
      if (r.ok) caches.open(CACHE).then((c) => c.put(request.mode === 'navigate' ? '/' : request, r.clone()));
      return r;
    }).catch(() => caches.match(request.mode === 'navigate' ? '/' : request)));
    return;
  }

  // Everything else — cache first
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((r) => {
    if (r.ok) caches.open(CACHE).then((c) => c.put(request, r.clone()));
    return r;
  })));
});
