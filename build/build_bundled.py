#!/usr/bin/env python3
"""
シングルHTML バンドラ。
CSS, JS, JSON を src/index.html にインライン化して build/pesticide_search_bundled.html を生成。

JS は ES module 形式だが、バンドル時に import/export を除去して 1 つの IIFE に結合する。
"""

import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SRC = PROJECT_ROOT / "src"
BUILD = PROJECT_ROOT / "build"
OUT = BUILD / "これをクリック.html"

# 結合する JS の順序（依存関係順）
JS_ORDER = [
    "js/core/normalize.js",
    "js/core/search.js",
    "js/core/filter.js",
    "js/io/export.js",
    "js/io/applications.js",
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
    """pesticides.json と applications.json を window 変数として埋め込む"""
    main_path = SRC / "data" / "pesticides.json"
    apps_path = SRC / "data" / "applications.json"

    if not main_path.exists():
        sys.exit("ERROR: pesticides.json が無い。先に scripts/build_data.py を実行してください。")

    main_size = main_path.stat().st_size / 1024 / 1024
    apps_size = apps_path.stat().st_size / 1024 / 1024 if apps_path.exists() else 0
    print(f"  Embedding data: main={main_size:.2f}MB, apps={apps_size:.2f}MB")

    main_json = read(main_path)
    apps_json = read(apps_path) if apps_path.exists() else "{}"

    data_script = (
        f'<script>\n'
        f'window.PESTICIDES_DB = {main_json};\n'
        f'window.APPLICATIONS = {apps_json};\n'
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

    BUILD.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)

    size_mb = OUT.stat().st_size / 1024 / 1024
    print(f"\n  OK Output: {OUT}")
    print(f"  OK Size: {size_mb:.2f} MB")


if __name__ == "__main__":
    main()
