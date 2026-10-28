// sw.js — app-shell caching so VoiceNotes launches and runs fully offline.
// Recordings themselves live in IndexedDB (see js/db.js), never in this
// cache — this worker is only responsible for the static UI shell.

const CACHE_VERSION = 'v4';
const CACHE_NAME = `voicenotes-shell-${CACHE_VERSION}`;
const CDN_CACHE_NAME = `voicenotes-cdn-${CACHE_VERSION}`;

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
  './js/enhance.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// Cross-origin runtimes the enhancement path needs offline after first use:
// - esm.sh: @desert-ant-labs/clear JS wrapper (dynamic import)
// - cdn.jsdelivr.net: LiteRT WASM runtime + ClearWeb.wasm (via import.meta.url)
const CDN_CACHEABLE_HOSTS = new Set(['esm.sh', 'cdn.jsdelivr.net']);

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
        keys.filter((key) =>
          (key.startsWith('voicenotes-shell-') && key !== CACHE_NAME) ||
          (key.startsWith('voicenotes-cdn-') && key !== CDN_CACHE_NAME)
        )
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Runtime-cache the enhancement CDN (Clear wrapper + LiteRT WASM) so the
  // "Clean up audio" path works fully offline after its first use.
  // Model weights from Hugging Face are cached by the SDK itself, not here.
  if (request.method === 'GET' && CDN_CACHEABLE_HOSTS.has(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CDN_CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const copy = response.clone();
          cache.put(request, copy).catch(() => {});
        }
        return response;
      } catch (err) {
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // Only handle same-origin GET requests beyond this point; let everything
  // else (e.g. Hugging Face weight downloads) pass through untouched.
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
