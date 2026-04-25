#!/usr/bin/env python3
"""
PWA (Progressive Web App) ビルダ。

build_bundled.py の出力 (build/これをクリック.html) をベースに、
Service Worker + Web App Manifest + Apple Touch Icon を加えて
完全オフライン動作する PWA を pwa/ ディレクトリに生成する。

生成物:
  pwa/index.html             — PWA エントリ (manifest + SW 登録 + Apple meta タグ追加済)
  pwa/sw.js                  — Service Worker (HTML を install 時にキャッシュ)
  pwa/manifest.webmanifest   — Web App Manifest
  pwa/icon-{192,512}.png     — PWA アイコン
  pwa/apple-touch-icon.png   — iOS ホーム画面アイコン (180x180)

使い方:
  python3 build/build_pwa.py
  python3 -m http.server 8765 -d pwa  # ローカル動作確認

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
OUT_DIR = PROJECT_ROOT / "pwa"

APP_NAME = "農薬簡易検索"
APP_SHORT = "農薬検索"
THEME_COLOR = "#16a34a"   # アプリのアクセント緑
BG_COLOR = "#fafafa"


SW_JS = r"""// Service Worker — 完全オフライン動作のためのキャッシュ
const CACHE = "pesticide-search-v1";
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

self.addEventListener("fetch", e => {
  // GET 以外は素通し
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // 同一オリジンのみキャッシュに足す
        const url = new URL(e.request.url);
        if (url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match("./index.html"));
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


def make_icon(size: int, dest: Path):
    """シンプルな緑背景 + 白い文字のアイコンを生成。"""
    img = Image.new("RGB", (size, size), THEME_COLOR)
    draw = ImageDraw.Draw(img)
    # 文字を中央に
    text = "農"
    # フォント候補 (macOS)
    font_paths = [
        "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    font = None
    for fp in font_paths:
        if Path(fp).exists():
            try:
                font = ImageFont.truetype(fp, int(size * 0.62))
                break
            except Exception:
                continue
    if font is None:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    draw.text((x, y), text, fill="white", font=font)
    img.save(dest, "PNG", optimize=True)


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

    # 2. Service Worker
    (OUT_DIR / "sw.js").write_text(SW_JS, encoding="utf-8")
    print(f"  sw.js")

    # 3. Manifest
    (OUT_DIR / "manifest.webmanifest").write_text(MANIFEST, encoding="utf-8")
    print(f"  manifest.webmanifest")

    # 4. アイコン
    make_icon(192, OUT_DIR / "icon-192.png")
    make_icon(512, OUT_DIR / "icon-512.png")
    make_icon(180, OUT_DIR / "apple-touch-icon.png")
    print(f"  icon-192.png / icon-512.png / apple-touch-icon.png")

    total = sum(f.stat().st_size for f in OUT_DIR.iterdir() if f.is_file())
    print(f"\nDone. 合計 {total/1024/1024:.1f} MB")
    print(f"動作確認: python3 -m http.server 8765 -d pwa")
    print(f"        → http://localhost:8765/")


if __name__ == "__main__":
    main()
