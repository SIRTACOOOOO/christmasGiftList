// Service worker: lets the site be installed as an app and keeps the page shell available offline.
// It only ever touches files from this site. Requests to Supabase, fonts and the sign-in library pass straight through,
// so no account data is ever stored by the service worker.
// Bump CACHE when you change this file's list of files.
const CACHE = 'giftlist-v13';
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

// ---- The round picture in a notification: the sender's photo if it can be read, else their coloured letter, else the gift ----
const oklch = (L, C, h) => {      // the same colours as the letter circles in the app
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  return 'rgb(' + lin.map(x => Math.round(255 * Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)))).join(',') + ')';
};
async function pngDataUrl(canvas) {
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()); let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return 'data:image/png;base64,' + btoa(s);
}
async function letterIcon(letter, hue) {
  const S = 128, c = new OffscreenCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = hue == null ? '#d9dedb' : oklch(0.86, 0.06, hue); g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.fill();
  g.fillStyle = hue == null ? '#5d6b66' : oklch(0.3, 0.06, hue); g.font = '600 58px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(letter || '?').slice(0, 1), S / 2, S / 2 + 3);
  return pngDataUrl(c);
}
async function circlePhoto(url) {      // null if the picture's website does not let us read it (or is slow)
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 1800);
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob()), side = Math.min(bmp.width, bmp.height), S = 128, c = new OffscreenCanvas(S, S), g = c.getContext('2d');
    g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.clip();
    g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, S, S);
    return await pngDataUrl(c);
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
async function pickIcon(d) {
  const t0 = Date.now();
  if (d.icon) {
    const round = await circlePhoto(d.icon); if (round) return round;
    // the photo's website refuses to be read: use the photo as it is, unless that already took too long
    if (Date.now() - t0 < 1000) { const ok = await Promise.race([fetch(d.icon, { mode: 'no-cors', referrerPolicy: 'no-referrer' }).then(() => true, () => false), new Promise(r => setTimeout(() => r(false), 1000))]); if (ok) return d.icon; }
  }
  if (d.initial) { try { return await letterIcon(d.initial, d.hue == null ? null : d.hue); } catch (e) {} }
  return 'icons/notification-icon.png';
}

// ---- Phone notifications ----
// The push service wakes this file up when the "push" Edge Function sends a message. If the app is open and in front of you,
// no banner is shown (the page just refreshes the chat); otherwise a normal notification appears.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach(w => w.postMessage({ type: 'push-arrived' }));                      // an open page refreshes the chat straight away
    const watching = !d.force && wins.some(w => w.visibilityState === 'visible' && w.focused);
    // Every push must show a notification (iPhones cancel notifications for sites that sometimes show none), so when you are
    // already looking at the app it is shown silently and removed after a few seconds.
    const icon = await pickIcon(d);
    await self.registration.showNotification(d.title || 'Gift List', {
      body: d.body || '', icon, badge: 'icons/notification-badge.png',      // badge = the small white gift in the phone's status bar
     
      tag: d.tag || 'giftlist', renotify: !watching, silent: watching, data: { group: d.group || '' }
    });
    if (watching) { await new Promise(r => setTimeout(r, 3500)); (await self.registration.getNotifications({ tag: d.tag || 'giftlist' })).forEach(n => n.close()); }
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
