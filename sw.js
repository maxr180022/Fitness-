'use strict';
// Service worker: контент всегда берётся из сети (если она есть), иначе из кэша.
// Видео кэшируются при первом просмотре. Пересобирать приложение не нужно:
// достаточно обновить файлы в репозитории.
const CORE = 'fit-core-v5';
const MEDIA = 'fit-media-v1';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'data/program.json', 'data/nutrition.json', 'data/body.json',
  'fonts/unbounded-cyrillic-800-normal.woff2', 'fonts/unbounded-latin-800-normal.woff2',
  'fonts/manrope-cyrillic-500-normal.woff2', 'fonts/manrope-cyrillic-700-normal.woff2', 'fonts/manrope-cyrillic-800-normal.woff2',
  'fonts/manrope-latin-500-normal.woff2', 'fonts/manrope-latin-700-normal.woff2', 'fonts/manrope-latin-800-normal.woff2',
  'media/p/squat.jpg', 'media/p/pushup.jpg', 'media/p/bridge.jpg', 'media/p/plank.jpg', 'media/p/birddog.jpg',
  'media/p/deadbug.jpg', 'media/p/hipflex.jpg', 'media/p/catcow.jpg', 'media/p/child.jpg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CORE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('fit-core-') && k !== CORE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('.mp4')) { e.respondWith(media(req)); return; }
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CORE);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(req, { cache: 'no-cache', signal: ctrl.signal });
    clearTimeout(t);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    return new Response('Нет сети', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function media(req) {
  const cache = await caches.open(MEDIA);
  const key = req.url;
  let res = await cache.match(key);
  if (!res) {
    try {
      const net = await fetch(key);
      if (!net.ok) return net;
      await cache.put(key, net.clone());
      res = net;
    } catch (err) {
      return new Response('Видео недоступно без сети', { status: 503 });
    }
  }
  const range = req.headers.get('range');
  if (!range) return res;
  const buf = await res.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : buf.byteLength - 1;
  if (!m || (m[1] === '' && m[2] !== '')) { // суффиксный диапазон: последние N байт
    const n = m && m[2] ? parseInt(m[2], 10) : buf.byteLength;
    start = Math.max(0, buf.byteLength - n); end = buf.byteLength - 1;
  }
  end = Math.min(end, buf.byteLength - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buf.byteLength}` } });
  const body = buf.slice(start, end + 1);
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(body.byteLength),
      'Accept-Ranges': 'bytes'
    }
  });
}
