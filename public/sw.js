// 版本号：每次部署更新此值，强制所有客户端丢弃旧缓存
const CACHE_VERSION = 'v20261007-icon';
const CACHE_NAME = 'ai-os-' + CACHE_VERSION;

self.addEventListener('install', (e) => {
  // 立即激活，不等旧 SW 释放
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // 通知所有客户端强制刷新（防止内存中的旧 JS 继续运行）
        return self.clients.matchAll({ type: 'window' }).then((clients) => {
          clients.forEach((client) => client.navigate(client.url));
        });
      })
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (
    e.request.mode === 'navigate' ||
    (e.request.headers.get('accept') || '').includes('text/html') ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html')
  ) {
    // HTML 永远走网络，不缓存
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
