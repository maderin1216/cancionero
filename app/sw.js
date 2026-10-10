// Service worker: guarda la app para que abra sin conexión. Las canciones las guarda la app aparte.
// Estrategia: responder desde la caché y actualizarla en segundo plano.
const CACHE = 'cancionero-2.8';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/chords.js', 'js/config.js', 'js/editor.js', 'js/render.js',
  'js/song.js', 'js/store.js', 'js/textimport.js', 'js/ui.js', 'js/util.js',
  'fonts/carlito-400.woff2', 'fonts/carlito-700.woff2', 'icons/icon.svg', 'icons/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const key = url.search.includes('code=') ? new Request(url.origin + url.pathname) : e.request;
    const cached = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(key, r.clone()); return r; }).catch(() => cached);
    return cached || fresh;
  }));
});
