/**
 * sw.js · Service Worker
 * 缝纫空间 M1.1 工程骨架
 *
 * 缓存策略：
 *   - 静态资源（vendor/dexie.min.js、style.css、js/*.js、icons/*、manifest）→ Cache-First
 *   - 导航请求（HTML）→ Network-First，回退到缓存的 index.html
 *   - 数据请求（Dexie 不走网络）→ 透传
 *
 * 版本：每次升级时改 CACHE_VERSION，旧缓存会被自动清理。
 */

const CACHE_VERSION = 'sewing-space-v1.4.4'; // v1.4.4 M1.6 收尾：P2-PKG-1 修补 deploy.yml，代码零改动
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const HTML_CACHE = `${CACHE_VERSION}-html`;

// 预缓存关键静态资源（vendor 文件相对大，单独一组）
const PRECACHE_STATIC = [
  './',
  './index.html',
  './manifest.webmanifest',
  './style.css',
  './vendor/dexie.min.js',
  './js/utils.js',
  './js/db.js',
  './js/components.js',
  './js/pages.js',
  './js/router.js',
  './js/app.js',
  './main.js',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
];

/* ============ install：预缓存 ============ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      // 逐个 add，单个失败不影响其它（首次部署 / 部分网络下更稳）
      await Promise.allSettled(
        PRECACHE_STATIC.map((url) =>
          cache.add(url).catch((e) => console.warn('[SW] precache 失败：', url, e))
        )
      );
      self.skipWaiting();
    })
  );
});

/* ============ activate：清理旧缓存 ============ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/* ============ fetch：路由分发 ============ */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 仅处理 GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 同源资源
  if (url.origin === self.location.origin) {
    // 导航请求 → Network-First，回退缓存
    if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
      event.respondWith(networkFirst(req, HTML_CACHE, './index.html'));
      return;
    }
    // 静态资源 → Cache-First
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // 跨域（如字体、CDN 图片）→ 透传
  // M1.1 阶段不引入跨域资源，全部本地化
});

/* ============ Cache-First ============ */
async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200 && fresh.type === 'basic') {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (e) {
    // 无缓存 + 无网络：返回最简错误
    return new Response('', { status: 504, statusText: 'Offline & Not Cached' });
  }
}

/* ============ Network-First ============ */
async function networkFirst(req, cacheName, fallbackUrl) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    // 最后兜底：返回 index.html（SPA 路由可由前端处理）
    if (fallbackUrl) {
      const fb = await caches.match(fallbackUrl);
      if (fb) return fb;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

/* ============ message：允许页面触发 skipWaiting ============ */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});