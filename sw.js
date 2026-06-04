// Goings On — photo cache service worker.
// Caches Google Places photo images on-device so each photo is fetched from
// the API only once per device. Every later view is served from cache with
// zero API calls, which keeps photo usage comfortably inside the free tier.

const PHOTO_CACHE = 'goings-on-photos-v1';
// Cap the cache to roughly the most-recent ~400 photos (~20 MB). Oldest entries
// are dropped first so storage never grows unbounded.
const MAX_ENTRIES = 400;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop any older photo-cache versions.
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('goings-on-photos-') && n !== PHOTO_CACHE)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  // Only intercept Google Places photo-media requests; everything else passes
  // straight through to the network untouched.
  if (!/places\.googleapis\.com\/.*\/media/.test(event.request.url)) return;
  event.respondWith(cacheFirstPhoto(event.request));
});

async function cacheFirstPhoto(request) {
  const cache = await caches.open(PHOTO_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;                  // already on-device → no API call
  try {
    const resp = await fetch(request);  // first time → one API call, then store
    cache.put(request, resp.clone()).then(() => trimCache(cache)).catch(() => {});
    return resp;
  } catch (e) {
    // Offline / fetch failed — fall back to whatever might be cached.
    return (await cache.match(request)) || Response.error();
  }
}

async function trimCache(cache) {
  const keys = await cache.keys();      // insertion order = oldest first
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) {
    await cache.delete(keys[i]);
  }
}
