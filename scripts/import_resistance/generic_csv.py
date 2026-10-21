#!/usr/bin/env python3
"""
外部データベースから書き出した CSV を、列の対応表 (scripts/import_resistance/maps/<id>.json) に従って取り込む。
APRD・WeedScience.org・FRAC のように、スクリプトで取得できない、または書き出しの形式が決まっていない出どころに使う。

対応表の形:
  {
    "source_id": "aprd",                     rawdata/resistance/sources.json の id
    "encoding": "utf-8-sig",                 入力の文字コード (省略時 utf-8-sig)
    "columns": {"scientific_name": "<入力の列名>", ...},   取り込み先の列 → 入力の列名
    "defaults": {"level": "抵抗性あり", ...}  入力に列が無い項目の値
  }
取り込み先の列は build_resistance.py の EXTERNAL_COLUMNS。columns に書いた列名が入力に無ければ、
入力の見出しを表示して止まる (書き出したファイルを見て対応表を直す)。
国の「Japan」は「日本」に、県のローマ字は県名にそろえる。record_id の列が無ければ行番号を使う。

使い方:
  python3 scripts/import_resistance/generic_csv.py --map scripts/import_resistance/maps/aprd.json --input 書き出し.csv
  … --dry-run   最初の 5 行の変換結果を表示するだけ (書かない)
"""

import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import country_name, prefecture_name, today, write_external  # noqa: E402
from build_resistance import EXTERNAL_COLUMNS  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="外部データベースの CSV を列の対応表で取り込む")
    ap.add_argument("--map", required=True, help="列の対応表 (JSON)")
    ap.add_argument("--input", required=True, help="書き出した CSV")
    ap.add_argument("--dry-run", action="store_true", help="変換結果を 5 行表示するだけで書かない")
    args = ap.parse_args()

    spec = json.loads(Path(args.map).read_text(encoding="utf-8"))
    columns = spec.get("columns", {})
    defaults = spec.get("defaults", {})
    unknown = [c for c in [*columns, *defaults] if c not in EXTERNAL_COLUMNS]
    if unknown:
        sys.exit(f"ERROR: 取り込み先に無い列 {unknown} (使える列: {EXTERNAL_COLUMNS})")

    with open(args.input, encoding=spec.get("encoding", "utf-8-sig"), newline="") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        missing = [src for src in columns.values() if src not in header]
        if missing:
            print("入力の見出し:", header)
            sys.exit(f"ERROR: 対応表の列名 {missing} が入力に無い。{args.map} を入力の見出しに合わせて直す")
        rows = list(reader)

    out = []
    accessed = today()
    for n, row in enumerate(rows, start=2):
        r = {**defaults}
        for dest, src in columns.items():
            value = (row.get(src) or "").strip()
            if value:
                r[dest] = value
        r["country"] = country_name(r.get("country", ""))
        if r.get("prefecture"):
            name = prefecture_name(r["prefecture"])
            if not name:
                print(f"  注意 {n} 行目: 県名「{r['prefecture']}」を読めない。県を空にして、元の表記を note に残す")
                r["note"] = "; ".join(x for x in [r.get("note", ""), f"地域: {r['prefecture']}"] if x)
            r["prefecture"] = name or ""
        if r["country"] != "日本" and r.get("prefecture"):
            r["prefecture"] = ""
        r.setdefault("record_id", str(n))
        r.setdefault("accessed", accessed)
        out.append(r)

    if args.dry_run:
        for r in out[:5]:
            print(json.dumps(r, ensure_ascii=False))
        print(f"(全 {len(out)} 行。--dry-run なので書いていない)")
        return
    write_external(spec["source_id"], out)


if __name__ == "__main__":
    main()
