// Service worker: lets the site be installed as an app and keeps the page shell available offline.
// It only ever touches files from this site. Requests to Supabase, fonts and the sign-in library pass straight through,
// so no account data is ever stored by the service worker.
// Bump CACHE when you change this file's list of files.
const CACHE = 'giftlist-v9';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'themes/themes.js', 'themes/legacy.css',
               'icons/icon-192.png', 'icons/maskable-512.png', 'icons/favicon.ico'];

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
    fetch(r, { cache: 'no-cache' }).then(res => { if (res.ok && !new URL(r.url).search) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); } return res; })
      .catch(() => caches.match(r).then(hit => hit || (r.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});

// ---- Phone notifications ----
// The push service wakes this file up when the "push" Edge Function sends a message. If the app is open and in front of you,
// no banner is shown (the page just refreshes the chat); otherwise a normal notification appears.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some(w => w.visibilityState === 'visible' && w.focused)) { wins.forEach(w => w.postMessage({ type: 'push-arrived' })); return; }
    await self.registration.showNotification(d.title || 'Gift List', {
      body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      tag: d.tag || 'giftlist', renotify: true, data: { group: d.group || '' }
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const g = (e.notification.data || {}).group || '';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) { try { await wins[0].focus(); } catch (x) {} wins[0].postMessage({ type: 'open-chat', group: g }); return; }
    await self.clients.openWindow('./#chat=' + (g || 'open'));
  })());
});
