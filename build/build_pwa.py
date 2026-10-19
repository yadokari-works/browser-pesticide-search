#!/usr/bin/env python3
"""
PWA (Progressive Web App) ビルダ。

build_bundled.py の出力 (build/これをクリック.html) をベースに、
Service Worker + Web App Manifest + Apple Touch Icon を加えて
完全オフライン動作する PWA を docs/ ディレクトリに生成する。

生成物:
  docs/index.html                 — PWA エントリ (manifest + SW 登録 + Apple meta タグ追加済)
  docs/sw.js                      — Service Worker (HTML を install 時にキャッシュ)
  docs/manifest.webmanifest       — Web App Manifest
  docs/icon-192-<版>.png 等       — PWA アイコン (角丸、外側は透明)
  docs/apple-touch-icon-<版>.png  — iOS ホーム画面アイコン (180x180、角を絵の色で埋めた不透明)

アイコンの正本は build/icon/ (元絵 app-icon.png から作る)。docs/ へは版番号付きの名前でコピーする。
版番号を入れるのは、iOS がホーム画面に追加した時点の画像を取り直さないため。

使い方:
  python3 build/build_pwa.py
  python3 build/build_pwa.py --regen-icons  # 元絵からアイコンを作り直す (元絵が無ければ「農」の字。要 numpy・scipy)
  ※ --regen-icons の後は build/build_bundled.py も回す (単一ファイル版はタブ用アイコンを build/icon/ から埋め込む)
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
  "./__ICON_192__",
  "./__ICON_512__",
  "./__APPLE_ICON__",
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


def icon_names(version: str) -> dict:
    """docs/ に置くアイコンのファイル名。版番号を入れ、版が変わると別の URL になるようにする。"""
    return {
        "192": f"icon-192-{version}.png",
        "512": f"icon-512-{version}.png",
        "apple": f"apple-touch-icon-{version}.png",
    }


# icons の purpose は any のみ。元絵は角丸の絵で、maskable (円形の切り抜き) だと柄が欠けるため
def manifest_text(names: dict) -> str:
    return f"""{{
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
    {{ "src": "{names['192']}", "sizes": "192x192", "type": "image/png", "purpose": "any" }},
    {{ "src": "{names['512']}", "sizes": "512x512", "type": "image/png", "purpose": "any" }}
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


# 正本のアイコン (build/icon/)。元絵 app-icon.png から作り、docs/ へは版番号付きの名前でコピーする
ICON_DIR = BUILD / "icon"
ICON_SOURCE = ICON_DIR / "app-icon.png"  # 元絵 (1254x1254 の RGB。角丸の外側は透明ではなく白い余白)


def make_icon_from_source(size: int, dest: Path, opaque: bool):
    """元絵から角丸のアイコンを作る。

    opaque=False: 角丸の外側を透明にする (ホーム画面・ファビコン用)。
    opaque=True: 透明部分を最も近い絵の色で埋める (iOS は透明部分を黒く塗るため)。
    """
    try:
        import numpy as np
        from scipy import ndimage
    except ImportError:
        sys.exit("ERROR: 元絵からアイコンを作るには numpy と scipy が必要です。pip install numpy scipy")

    art = np.asarray(Image.open(ICON_SOURCE).convert("RGB"))
    # 白い余白 (三色とも 230 以上) のうち、画像の端につながる部分を外側とみなす。
    # 絵の中の白 (虫眼鏡の縁) は緑に囲まれているので、端にはつながらない。
    white = art.min(axis=2) >= 230
    labels, _ = ndimage.label(white)
    edge_labels = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    outside = np.isin(labels, edge_labels[edge_labels != 0])
    inside = ~outside

    ys, xs = np.where(inside)
    x0, y0 = int(xs.min()), int(ys.min())
    side = max(int(xs.max()) - x0 + 1, int(ys.max()) - y0 + 1)  # 正方形に切り出す
    rgb = art[y0:y0 + side, x0:x0 + side]
    keep = inside[y0:y0 + side, x0:x0 + side]

    if opaque:
        # 外側との境目は色が薄いので塗りの元にしない。内側 4 画素より奥の緑だけを使う
        solid = ndimage.binary_erosion(keep, iterations=4)
        _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_distances=True, return_indices=True)
        img = Image.fromarray(rgb[iy, ix])
    else:
        img = Image.fromarray(np.dstack([rgb, keep.astype(np.uint8) * 255]))

    img.resize((size, size), Image.LANCZOS).save(dest, "PNG", optimize=True)
    return True


def make_icon(size: int, dest: Path, opaque: bool = False):
    """緑背景 + 白い「農」のアイコンを生成する (元絵があれば元絵から作る)。

    既存ファイルがあれば再生成しない。フォントは環境ごとに違うため、
    毎回生成すると CI (Linux) と手元 (macOS) で別画像になり、週次の自動更新の
    たびにアイコンが差し替わってしまう。作り直したいときは
    `--regen-icons` を付けるか、docs/*.png を削除する。
    """
    if dest.exists() and not REGEN_ICONS:
        return False
    if ICON_SOURCE.exists():
        return make_icon_from_source(size, dest, opaque)

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


def pwa_head(names: dict) -> str:
    """docs/index.html の head に足す PWA 用のタグ。アイコンは版番号付きのファイル名。"""
    return f"""
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="{THEME_COLOR}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="{APP_SHORT}">
<link rel="apple-touch-icon" sizes="180x180" href="{names['apple']}">
<link rel="icon" type="image/png" sizes="192x192" href="{names['192']}">
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


def inject_pwa_bits(html: str, names: dict) -> str:
    """既存のバンドル HTML に PWA メタタグと SW 登録スクリプトを差し込む。"""
    # CSP を緩和: worker-src 'self' を追加 (Service Worker のため)
    html = re.sub(
        r'(default-src [^"]+?)("[^>]*?>)',
        lambda m: m.group(1) + " worker-src 'self'; manifest-src 'self';" + m.group(2),
        html,
        count=1,
    )
    # head に meta + manifest を差し込み
    html = html.replace("</head>", f"{pwa_head(names)}</head>", 1)
    # body 末尾直前に SW 登録スクリプト
    html = html.replace("</body>", f"{SW_REGISTER_SCRIPT}</body>", 1)
    return html


STALE_ICON = re.compile(r"^(icon-192|icon-512|apple-touch-icon)(-[0-9.]+)?\.png$")


def remove_stale_icons(keep: set):
    """古い版のアイコン (版番号が無いもの、別の版のもの) を docs/ から消す。"""
    for p in OUT_DIR.iterdir():
        if STALE_ICON.match(p.name) and p.name not in keep:
            p.unlink()
            print(f"  削除: docs/{p.name} (古い版のアイコン)")


def main():
    if not SRC_HTML.exists():
        sys.exit(f"ERROR: {SRC_HTML} が無い。先に build/build_bundled.py を実行してください。")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Building PWA → {OUT_DIR.relative_to(PROJECT_ROOT)}/")

    version = (PROJECT_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    names = icon_names(version)

    # 1. HTML を読み込んで PWA 化
    html = SRC_HTML.read_text(encoding="utf-8")
    html = inject_pwa_bits(html, names)
    (OUT_DIR / "index.html").write_text(html, encoding="utf-8")
    print(f"  index.html      ({len(html)/1024/1024:.1f} MB)")

    # 2. Service Worker (VERSION を埋め込み、CACHE 名をバージョン付きにする)
    sw_js = (SW_JS_TEMPLATE.replace("__APP_VERSION__", version)
             .replace("__ICON_192__", names["192"])
             .replace("__ICON_512__", names["512"])
             .replace("__APPLE_ICON__", names["apple"]))
    (OUT_DIR / "sw.js").write_text(sw_js, encoding="utf-8")
    print(f"  sw.js (CACHE = pesticide-search-{version})")

    # 3. Manifest
    (OUT_DIR / "manifest.webmanifest").write_text(manifest_text(names), encoding="utf-8")
    print(f"  manifest.webmanifest")

    # 4. アイコン: 正本は build/icon/ (既存があれば維持。--regen-icons で作り直す)。
    #    docs/ へは版番号付きの名前でコピーし、古い版のファイルは消す
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    made = [
        make_icon(192, ICON_DIR / "icon-192.png"),
        make_icon(512, ICON_DIR / "icon-512.png"),
        make_icon(180, ICON_DIR / "apple-touch-icon.png", opaque=True),
        make_icon(32, ICON_DIR / "favicon-32.png"),
    ]
    state = "生成" if any(made) else "既存を維持"
    shutil.copyfile(ICON_DIR / "icon-192.png", OUT_DIR / names["192"])
    shutil.copyfile(ICON_DIR / "icon-512.png", OUT_DIR / names["512"])
    shutil.copyfile(ICON_DIR / "apple-touch-icon.png", OUT_DIR / names["apple"])
    remove_stale_icons(keep=set(names.values()))
    print(f"  {names['192']} / {names['512']} / {names['apple']} ({state})")

    total = sum(f.stat().st_size for f in OUT_DIR.iterdir() if f.is_file())
    print(f"\nDone. 合計 {total/1024/1024:.1f} MB")
    print(f"動作確認: python3 -m http.server 8765 -d docs")
    print(f"        → http://localhost:8765/")


if __name__ == "__main__":
    main()
