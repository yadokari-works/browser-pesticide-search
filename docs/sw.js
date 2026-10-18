// Service Worker - バージョンアップ時に確実にキャッシュを更新する戦略
// 1. CACHE 名にバージョンを埋め込み、新版デプロイ時に古い CACHE を破棄する。
//    消すのはこのアプリのキャッシュ (pesticide-search-) だけ (同じ origin の他のアプリのキャッシュは消さない)
// 2. HTML は network-first で最新を取得する。4 秒で応答が無く、キャッシュがあればキャッシュを返す
//    (電波の弱い圃場でも起動を待たせない)。取得は裏で続け、届いたらキャッシュを更新する
// 3. アプリ本体の HTML (./ と ./index.html) は 1 つのキーにまとめる (約 30 MB を 2 重に保存しないため)
// 4. 静的アセット (アイコン等) は cache-first
const VERSION = "1.9.0";
const CACHE_PREFIX = "pesticide-search-";
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const APP_KEY = "./";
const HTML_TIMEOUT_MS = 4000;
const ASSETS = [
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([APP_KEY, ...ASSETS])).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isHtmlRequest(request) {
  if (request.mode === "navigate") return true;
  const url = new URL(request.url);
  return url.pathname === "/" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
}

// アプリ本体は APP_KEY に、使い方のページなど他の HTML はそれぞれの URL で保存する
function htmlCacheKey(request) {
  const scope = new URL(APP_KEY, self.location).pathname;
  const path = new URL(request.url).pathname;
  return (path === scope || path === `${scope}index.html`) ? APP_KEY : request;
}

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  if (isHtmlRequest(e.request)) {
    const key = htmlCacheKey(e.request);
    const network = fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        e.waitUntil(caches.open(CACHE).then(c => c.put(key, clone)));
      }
      return res;
    });
    // 先にキャッシュを返しても、取得とキャッシュの更新は最後まで続ける
    e.waitUntil(network.catch(() => {}));
    const cachedAfterTimeout = new Promise(resolve => setTimeout(resolve, HTML_TIMEOUT_MS))
      .then(() => caches.match(key));
    e.respondWith(
      Promise.race([network, cachedAfterTimeout])
        .then(res => res || network)          // 4 秒たってもキャッシュが無ければ、取得を待つ
        .catch(() => caches.match(key))       // 取得に失敗したら (オフライン) キャッシュ
        .then(res => res || caches.match(APP_KEY))
    );
    return;
  }
  // 静的アセットは cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, clone)));
        }
        return res;
      }).catch(() => caches.match(APP_KEY));
    })
  );
});
