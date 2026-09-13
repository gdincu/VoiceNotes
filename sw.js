// sw.js — app-shell caching so VoiceNotes launches and runs fully offline.
// Recordings themselves live in IndexedDB (see js/db.js), never in this
// cache — this worker is only responsible for the static UI shell.

const CACHE_VERSION = 'v3';
const CACHE_NAME = `voicenotes-shell-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/recorder.js',
  './js/waveform.js',
  './js/share.js',
  './js/ui.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // Cache assets individually so one missing/failed file doesn't fail the
  // whole install (cache.addAll is all-or-nothing).
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        await cache.add(url);
      } catch (err) {
        console.warn('Service worker: failed to cache', url, err);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('voicenotes-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin GET requests; let everything else (e.g. any
  // cross-origin calls a future version might add) pass through untouched.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  // Navigations: try the network first for freshness, fall back to the
  // cached shell so the app still opens with no connection.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put('./index.html', copy))
            .catch(() => {});
        }
        return response;
      } catch {
        const cached = await caches.match('./index.html');
        if (cached) return cached;
        throw new Error('Offline and no cached shell available.');
      }
    })());
    return;
  }

  // Static assets: cache-first, then network, caching new same-origin
  // responses as they're fetched so the shell stays complete over time.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME)
          .then((cache) => cache.put(request, copy))
          .catch(() => {});
      }
      return response;
    } catch (err) {
      // Offline and never cached: propagate the network error instead of
      // resolving with `undefined` (which would throw an opaque error).
      throw err;
    }
  })());
});
