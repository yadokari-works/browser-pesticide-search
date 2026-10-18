#!/usr/bin/env python3
"""
PWA (Progressive Web App) ビルダ。

build_bundled.py の出力 (build/これをクリック.html) をベースに、
Service Worker + Web App Manifest + Apple Touch Icon を加えて
完全オフライン動作する PWA を docs/ ディレクトリに生成する。

生成物:
  docs/index.html             — PWA エントリ (manifest + SW 登録 + Apple meta タグ追加済)
  docs/sw.js                  — Service Worker (HTML を install 時にキャッシュ)
  docs/manifest.webmanifest   — Web App Manifest
  docs/icon-{192,512}.png     — PWA アイコン
  docs/apple-touch-icon.png   — iOS ホーム画面アイコン (180x180)

使い方:
  python3 build/build_pwa.py
  python3 build/build_pwa.py --regen-icons  # アイコンを作り直す (要 CJK フォント)
  python3 -m http.server 8765 -d docs  # ローカル動作確認

iOS Safari で `https://...` 経由でアクセスし、共有 → ホーム画面に追加。
1 回開いたあとはネット接続を切っても動作する。
"""

import re
import shutil
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("ERROR: Pillow が必要です。pip install Pillow")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BUILD = PROJECT_ROOT / "build"
SRC_HTML = BUILD / "これをクリック.html"
OUT_DIR = PROJECT_ROOT / "docs"  # GitHub Pages の制約上 /docs を使用

APP_NAME = "農薬簡易検索"
APP_SHORT = "農薬検索"
THEME_COLOR = "#16a34a"   # アプリのアクセント緑
BG_COLOR = "#fafafa"

# --regen-icons: 既存の docs/*.png を無視してアイコンを作り直す
REGEN_ICONS = "--regen-icons" in sys.argv


SW_JS_TEMPLATE = r"""// Service Worker - バージョンアップ時に確実にキャッシュを更新する戦略
// 1. CACHE 名にバージョンを埋め込み、新版デプロイ時に古い CACHE を破棄する。
//    消すのはこのアプリのキャッシュ (pesticide-search-) だけ (同じ origin の他のアプリのキャッシュは消さない)
// 2. HTML は network-first で最新を取得する。4 秒で応答が無く、キャッシュがあればキャッシュを返す
//    (電波の弱い圃場でも起動を待たせない)。取得は裏で続け、届いたらキャッシュを更新する
// 3. アプリ本体の HTML (./ と ./index.html) は 1 つのキーにまとめる (約 30 MB を 2 重に保存しないため)
// 4. 静的アセット (アイコン等) は cache-first
const VERSION = "__APP_VERSION__";
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
"""


MANIFEST = f"""{{
  "name": "{APP_NAME}",
  "short_name": "{APP_SHORT}",
  "description": "FAMIC + CropLife 統合のオフライン農薬検索ツール",
  "start_url": ".",
  "scope": ".",
  "display": "standalone",
  "orientation": "any",
  "theme_color": "{THEME_COLOR}",
  "background_color": "{BG_COLOR}",
  "lang": "ja",
  "icons": [
    {{ "src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" }},
    {{ "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }}
  ]
}}
"""


ICON_TEXT = "農"

# "農" を描ける CJK フォント候補。macOS / Linux (CI) の両方を含める。
# ImageFont.load_default() は CJK グリフを持たないため、フォールバックには使わない
# (ベタ塗りの緑正方形になり、アイコンが黙って壊れる)。
ICON_FONT_PATHS = [
    # macOS
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    # Linux (ubuntu-latest 等。fonts-noto-cjk / fonts-ipafont-gothic)
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/truetype/ipafont-gothic/ipagp.ttf",
]


def load_icon_font(size: int):
    """CJK フォントを 1 つ読み込む。見つからなければ致命エラーで停止する。"""
    for fp in ICON_FONT_PATHS:
        if Path(fp).exists():
            try:
                return ImageFont.truetype(fp, int(size * 0.62))
            except Exception:
                continue
    sys.exit(
        "ERROR: アイコン生成用の CJK フォントが見つかりません。\n"
        "  探索したパス: " + ", ".join(ICON_FONT_PATHS) + "\n"
        "  Linux なら apt-get install -y fonts-noto-cjk を実行するか、\n"
        "  既存の docs/*.png を残したまま (再生成しずに) ビルドしてください。"
    )


def make_icon(size: int, dest: Path):
    """緑背景 + 白い「農」のアイコンを生成する。

    既存ファイルがあれば再生成しない。フォントは環境ごとに違うため、
    毎回生成すると CI (Linux) と手元 (macOS) で別画像になり、週次の自動更新の
    たびにアイコンが差し替わってしまう。作り直したいときは
    `--regen-icons` を付けるか、docs/*.png を削除する。
    """
    if dest.exists() and not REGEN_ICONS:
        return False

    font = load_icon_font(size)
    img = Image.new("RGB", (size, size), THEME_COLOR)
    draw = ImageDraw.Draw(img)
    bbox = draw.textbbox((0, 0), ICON_TEXT, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    draw.text((x, y), ICON_TEXT, fill="white", font=font)

    # 字が実際に描かれたか検算する。フォントにグリフが無いと例外は出ずに
    # ベタ塗りの正方形ができてしまうため、色数で落とす。
    # getcolors() は色数が maxcolors を超えると None を返す (= 十分に描かれている)。
    colors = img.getcolors(maxcolors=2)
    if colors is not None and len(colors) < 2:
        sys.exit(f"ERROR: アイコンに「{ICON_TEXT}」が描画されませんでした ({dest.name})。"
                 " フォントに CJK グリフがありません。")

    img.save(dest, "PNG", optimize=True)
    return True


PWA_HEAD_INJECT = f"""
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="{THEME_COLOR}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="{APP_SHORT}">
<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="icon-192.png">
"""

SW_REGISTER_SCRIPT = """
<script>
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err => {
      console.warn("SW 登録失敗:", err);
    });
  });
}
</script>
"""


def inject_pwa_bits(html: str) -> str:
    """既存のバンドル HTML に PWA メタタグと SW 登録スクリプトを差し込む。"""
    # CSP を緩和: worker-src 'self' を追加 (Service Worker のため)
    html = re.sub(
        r'(default-src [^"]+?)("[^>]*?>)',
        lambda m: m.group(1) + " worker-src 'self'; manifest-src 'self';" + m.group(2),
        html,
        count=1,
    )
    # head に meta + manifest を差し込み
    html = html.replace("</head>", f"{PWA_HEAD_INJECT}</head>", 1)
    # body 末尾直前に SW 登録スクリプト
    html = html.replace("</body>", f"{SW_REGISTER_SCRIPT}</body>", 1)
    return html


def main():
    if not SRC_HTML.exists():
        sys.exit(f"ERROR: {SRC_HTML} が無い。先に build/build_bundled.py を実行してください。")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Building PWA → {OUT_DIR.relative_to(PROJECT_ROOT)}/")

    # 1. HTML を読み込んで PWA 化
    html = SRC_HTML.read_text(encoding="utf-8")
    html = inject_pwa_bits(html)
    (OUT_DIR / "index.html").write_text(html, encoding="utf-8")
    print(f"  index.html      ({len(html)/1024/1024:.1f} MB)")

    # 2. Service Worker (VERSION を埋め込み、CACHE 名をバージョン付きにする)
    version = (PROJECT_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    sw_js = SW_JS_TEMPLATE.replace("__APP_VERSION__", version)
    (OUT_DIR / "sw.js").write_text(sw_js, encoding="utf-8")
    print(f"  sw.js (CACHE = pesticide-search-{version})")

    # 3. Manifest
    (OUT_DIR / "manifest.webmanifest").write_text(MANIFEST, encoding="utf-8")
    print(f"  manifest.webmanifest")

    # 4. アイコン (既存があれば維持。--regen-icons で作り直す)
    made = [
        make_icon(192, OUT_DIR / "icon-192.png"),
        make_icon(512, OUT_DIR / "icon-512.png"),
        make_icon(180, OUT_DIR / "apple-touch-icon.png"),
    ]
    state = "生成" if any(made) else "既存を維持"
    print(f"  icon-192.png / icon-512.png / apple-touch-icon.png ({state})")

    total = sum(f.stat().st_size for f in OUT_DIR.iterdir() if f.is_file())
    print(f"\nDone. 合計 {total/1024/1024:.1f} MB")
    print(f"動作確認: python3 -m http.server 8765 -d docs")
    print(f"        → http://localhost:8765/")


if __name__ == "__main__":
    main()
