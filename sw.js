// 墨游 · 离线缓存
// 只缓存本站的页面文件；API 请求一律不经过缓存。
// 策略：先联网取最新（4 秒超时），取不到再用缓存——部署新版后刷新一次就能用上。
const CACHE = 'yl2c-v0.7.0';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/util.js',
  './js/state.js',
  './js/db.js',
  './js/api.js',
  './js/prompt.js',
  './js/parse.js',
  './js/cost.js',
  './js/fanwai.js',
  './js/memory.js',
  './js/discuss.js',
  './js/views/discuss.js',
  './js/views/library.js',
  './js/views/story-edit.js',
  './js/views/story.js',
  './js/views/extras.js',
  './js/views/memory.js',
  './js/views/chars.js',
  './js/views/play.js',
  './js/views/settings.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不碰 API 和其他网站
  e.respondWith(
    Promise.race([fetch(req), timeout(4000)])
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))
      )
  );
});
