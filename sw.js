// Service worker: lets the site be installed as an app and keeps the page shell available offline.
// It only ever touches files from this site. Requests to Supabase, fonts and the sign-in library pass straight through,
// so no account data is ever stored by the service worker.
// Bump CACHE when you change this file's list of files.
const CACHE = 'giftlist-v1';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'themes/themes.js', 'themes/legacy.css',
               'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon.ico'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first, so updates arrive as soon as you are online; the cached copy is the offline fallback.
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(r).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); } return res; })
      .catch(() => caches.match(r).then(hit => hit || (r.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
