#!/usr/bin/env python3
"""
シングルHTML バンドラ。
CSS, JS, JSON を src/index.html にインライン化して build/これをクリック.html を生成。

JS は ES module 形式だが、バンドル時に import/export を除去して 1 つの IIFE に結合する。
タブ用のアイコン (build/icon/favicon-32.png) は data: で埋め込む。
"""

import base64
import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SRC = PROJECT_ROOT / "src"
BUILD = PROJECT_ROOT / "build"
OUT = BUILD / "これをクリック.html"
ICON_FAVICON = BUILD / "icon" / "favicon-32.png"  # build_pwa.py が作る正本

# 結合する JS の順序（依存関係順）
JS_ORDER = [
    "js/core/crop_groups.js",
    "js/core/normalize.js",
    "js/core/search.js",
    "js/core/filter.js",
    "js/core/resistance.js",
    "js/io/export.js",
    "js/io/applications.js",
    "js/io/resistance_data.js",
    "js/app.js",
]


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def strip_module_syntax(js):
    """
    import / export 文を削除。
    - export function foo → function foo
    - export const foo = → const foo =
    - export { ... } → (削除)
    - import ... from "..." → (削除)
    - export default ... → (削除)
    """
    # import 文（複数行対応）
    js = re.sub(r'^\s*import\s+.*?from\s+["\'][^"\']+["\'];?\s*$',
                '', js, flags=re.MULTILINE | re.DOTALL)
    # export { ... } 文
    js = re.sub(r'^\s*export\s*\{[^}]*\}\s*;?\s*$',
                '', js, flags=re.MULTILINE)
    # export function / const / let / class
    js = re.sub(r'^(\s*)export\s+(function|const|let|class|async)',
                r'\1\2', js, flags=re.MULTILINE)
    # export default
    js = re.sub(r'^\s*export\s+default\s+', '', js, flags=re.MULTILINE)
    return js


def inline_css(html, base):
    def rep(m):
        href = m.group(1)
        css = read(base / href)
        return f"<style>\n{css}\n</style>"
    return re.sub(r'<link\s+rel="stylesheet"\s+href="([^"]+)"\s*/?>',
                  rep, html)


def inline_js(html):
    """元の <script type="module" src="js/app.js"></script> を置換"""
    combined_js = []
    for rel in JS_ORDER:
        js = read(SRC / rel)
        js_stripped = strip_module_syntax(js)
        combined_js.append(f"/* ===== {rel} ===== */\n{js_stripped}")
    full_js = "\n".join(combined_js)
    # </script 出現エスケープ
    full_js = full_js.replace("</script", "<\\/script")
    replacement = f"<script>\n(function() {{\n'use strict';\n{full_js}\n}})();\n</script>"
    return re.sub(r'<script\s+type="module"\s+src="[^"]+"\s*>\s*</script>',
                  lambda m: replacement, html)


def inline_data(html):
    """pesticides.json と applications.json と resistance.json を window 変数として埋め込む"""
    main_path = SRC / "data" / "pesticides.json"
    apps_path = SRC / "data" / "applications.json"
    res_path = SRC / "data" / "resistance.json"

    if not main_path.exists():
        sys.exit("ERROR: pesticides.json が無い。先に scripts/build_data.py を実行してください。")
    if not apps_path.exists():
        # 適用データ無しで配布すると、作物・病害虫の検索が黙って 0 件になるため止める
        sys.exit("ERROR: applications.json が無い。先に scripts/build_data.py を実行してください。")
    if not res_path.exists():
        # 抵抗性データ無しで配布すると、抵抗性の欄が読込エラーになるため止める
        sys.exit("ERROR: resistance.json が無い。先に scripts/build_resistance.py を実行してください。")

    main_size = main_path.stat().st_size / 1024 / 1024
    apps_size = apps_path.stat().st_size / 1024 / 1024
    res_size = res_path.stat().st_size / 1024
    print(f"  Embedding data: main={main_size:.2f}MB, apps={apps_size:.2f}MB, resistance={res_size:.1f}KB")

    # データ中の "</script>" や "<!--" で script 要素が閉じないよう、"<" を \u003c にする。
    # JSON では "<" は文字列の中にしか現れないので、読み込んだ値は変わらない
    main_json = read(main_path).replace("<", "\\u003c")
    apps_json = read(apps_path).replace("<", "\\u003c")
    res_json = read(res_path).replace("<", "\\u003c")

    data_script = (
        f'<script>\n'
        f'window.PESTICIDES_DB = {main_json};\n'
        f'window.APPLICATIONS = {apps_json};\n'
        f'window.RESISTANCE_DB = {res_json};\n'
        f'</script>'
    )
    # </head> 直前に挿入
    return html.replace("</head>", f"{data_script}\n</head>")


def add_csp(html):
    """Content-Security-Policy を付与 (file://でも動くよう外部通信を禁止)"""
    csp = (
        '<meta http-equiv="Content-Security-Policy" content="'
        "default-src \'self\' blob: data:; "
        "script-src \'self\' \'unsafe-inline\' blob:; "
        "style-src \'self\' \'unsafe-inline\'; "
        "connect-src \'self\' blob: data:; "
        "img-src \'self\' blob: data:;"
        '">'
    )
    if "Content-Security-Policy" not in html:
        html = html.replace("<head>", f"<head>\n{csp}", 1)
    return html


def add_favicon(html):
    """タブ用アイコンを data: で埋め込む。単一ファイルを開いたブラウザのタブにも絵が出る。"""
    if not ICON_FAVICON.exists():
        sys.exit(f"ERROR: {ICON_FAVICON} が無い。python3 build/build_pwa.py --regen-icons を先に実行してください。")
    b64 = base64.b64encode(ICON_FAVICON.read_bytes()).decode("ascii")
    link = f'<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,{b64}">'
    return html.replace("</head>", f"{link}\n</head>", 1)


def main():
    print("Bundling to single HTML...")
    print(f"  Source: {SRC / 'index.html'}")
    print(f"  Output: {OUT}")

    html = read(SRC / "index.html")
    html = inline_css(html, SRC)
    print("  CSS inlined")

    html = inline_data(html)
    print("  Data inlined (pesticides + applications)")

    html = inline_js(html)
    print("  JS inlined (modules combined & stripped)")

    html = add_csp(html)
    print("  CSP added")

    html = add_favicon(html)
    print("  favicon embedded (tab icon)")

    BUILD.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)

    size_mb = OUT.stat().st_size / 1024 / 1024
    print(f"\n  OK Output: {OUT}")
    print(f"  OK Size: {size_mb:.2f} MB")


if __name__ == "__main__":
    main()
