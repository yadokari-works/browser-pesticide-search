#!/usr/bin/env python3
"""
RAC コード (IRAC/FRAC/HRAC) の最新状況を確認する。データ更新のたびに update_data.py から呼ばれる。

確認する項目:
  1. CropLife の RAC 表が最新か (公開ファイルの Last-Modified / サイズと手元の取得ファイルを比較)
     と、表の版 (シート名の年月) が前回ビルドの記録から変わっていないか
  2. 有効な製品の成分で、RAC コードも rac_manual.json の分類理由も無いもの (= 新規登録成分の取りこぼし)
  3. rac_manual.json の手動コードが、CropLife 表のコードと食い違っていないか
  4. 手動ラベル/手動コードの成分が、CropLife 表に載った (= 手動の記載を整理できる) か

警告があっても終了コードは 0 (毎週の自動更新を止めない)。--strict を付けると警告で 1 を返す。
GitHub Actions 上では ::warning:: 注釈と Step Summary にも出力する。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import build_data  # noqa: E402  (RAC 表の読み込み処理を再利用する)

PESTICIDES_JSON = PROJECT_ROOT / "src" / "data" / "pesticides.json"
RAC_URL = "https://www.croplifejapan.org/assets/file/labo/mechanism/mechanism_rac.xlsx"
USER_AGENT = "browser-pesticide-search-updater/1.0 (+https://github.com/)"


def fetch_remote_head() -> tuple[str | None, int | None]:
    """公開側 RAC 表の (Last-Modified, サイズ)。取得できなければ (None, None)。"""
    try:
        req = urllib.request.Request(RAC_URL, method="HEAD", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as r:
            size = r.headers.get("Content-Length")
            return r.headers.get("Last-Modified"), int(size) if size else None
    except Exception as e:  # ネットワーク不通でも更新全体は止めない
        print(f"  (公開側の確認に失敗: {e})")
        return None, None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--strict", action="store_true", help="警告があれば終了コード 1")
    ap.add_argument("--offline", action="store_true", help="公開側への問い合わせを省く")
    args = ap.parse_args()

    warnings = []   # 要対応
    notes = []      # 参考 (整理できる記載など)

    # --- 1. RAC 表の版・鮮度 ---
    print("[RAC 1] CropLife RAC 表の版と鮮度")
    _, ing_master = build_data.load_rac_excel()
    edition = build_data.RAC_EDITION
    local_size = build_data.RAC_XLSX.stat().st_size
    print(f"  手元の表: {edition} 版 / {local_size:,} バイト")

    prev_edition = None
    if PESTICIDES_JSON.exists():
        data = json.loads(PESTICIDES_JSON.read_text(encoding="utf-8"))
        src = data.get("sources", {}).get("rac", "")
        prev_edition = src.split(" ")[0] if src else None
        if prev_edition and prev_edition != edition:
            warnings.append(
                f"RAC 表の版が {prev_edition} → {edition} に更新された。rac_manual.json の "
                f"recent/legacy ラベル・手動コードの見直しが必要"
            )
    else:
        data = {"products": []}

    if not args.offline:
        last_mod, remote_size = fetch_remote_head()
        if last_mod:
            print(f"  公開側の表: 最終更新 {last_mod} / {remote_size:,} バイト")
            if remote_size is not None and remote_size != local_size:
                warnings.append(
                    f"手元の RAC 表 ({local_size:,} B) が公開側 ({remote_size:,} B, {last_mod}) と"
                    f"異なる。update_data.py で取得し直すこと"
                )

    # --- 2. 取りこぼし成分 ---
    manual = build_data.load_manual_rac()
    unresolved = defaultdict(list)  # {成分名: [製品名...]}
    for p in data["products"]:
        if p.get("status") != "有効":
            continue
        for ing in p["ingredients"]:
            if not ing.get("rac_code") and not ing.get("rac_status"):
                unresolved[ing["name"]].append(p["product_name"])
    print(f"[RAC 2] 有効製品でコードも分類理由も無い成分: {len(unresolved)} 種")
    for name, prods in sorted(unresolved.items(), key=lambda x: -len(x[1])):
        warnings.append(
            f"成分「{name}」にRACコードも分類理由も無い ({len(prods)} 製品: "
            f"{', '.join(prods[:3])}{' ほか' if len(prods) > 3 else ''})。"
            f"IRAC/FRAC/HRAC 公式分類を確認し rac_manual.json に追加すること"
        )

    # --- 3 & 4. 手動記載と CropLife 表の突き合わせ ---
    print("[RAC 3] rac_manual.json と CropLife 表の突き合わせ")
    for name, man in manual.items():
        table_code = build_data._lookup_rac_by_name(name, ing_master)
        if not table_code:
            continue
        if man.get("rac_code") and man["rac_code"] != table_code:
            warnings.append(
                f"成分「{name}」: 手動コード {man['rac_code']} と CropLife 表のコード {table_code} が不一致"
                f" (表が優先されて出力される)"
            )
        else:
            notes.append(f"成分「{name}」は CropLife 表に収録済み (コード {table_code})。rac_manual.json の記載は整理可能")

    # --- 出力 ---
    print()
    for n in notes:
        print(f"  参考: {n}")
    gha = os.environ.get("GITHUB_ACTIONS") == "true"
    for w in warnings:
        print(f"  警告: {w}")
        if gha:
            print(f"::warning title=RAC コード確認::{w}")
    if not warnings:
        print("  RAC コード: 要対応なし")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### RAC コード確認 (表 {edition} 版)\n")
            f.write("\n".join(f"- ⚠️ {w}" for w in warnings) if warnings else "- 要対応なし")
            f.write("\n")

    return 1 if (warnings and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
