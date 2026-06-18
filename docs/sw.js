// Service Worker - バージョンアップ時に確実にキャッシュを更新する戦略
// 1. CACHE 名にバージョンを埋め込み、新版デプロイ時に古い CACHE を強制破棄
// 2. index.html (HTML) は network-first で常に最新を取得 (オフライン時のみキャッシュ)
// 3. 静的アセット (アイコン等) は cache-first
const VERSION = "1.3.0";
const CACHE = `pesticide-search-${VERSION}`;
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isHtmlRequest(request) {
  if (request.mode === "navigate") return true;
  const url = new URL(request.url);
  return url.pathname === "/" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
}

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  if (isHtmlRequest(e.request)) {
    // network-first: 最新の HTML を取得し、失敗時のみキャッシュ
    e.respondWith(
      fetch(e.request).then(res => {
        const url = new URL(e.request.url);
        if (url.origin === self.location.origin && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() =>
        caches.match(e.request).then(cached => cached || caches.match("./index.html"))
      )
    );
    return;
  }
  // 静的アセットは cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const url = new URL(e.request.url);
        if (url.origin === self.location.origin && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
