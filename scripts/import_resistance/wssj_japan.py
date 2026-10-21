#!/usr/bin/env python3
"""
日本雑草学会「Herbicide Resistant Weeds in Japan」(https://wssj.jp/~hr/index.html) を取り込む。

ページの一覧表 (1 行 = 初めて確認された県・年・作物と作用点) を正とし、表の後ろの詳細の文章から、
同じ種・同じ年の事例の除草剤名を拾って成分にする。除草剤名は rawdata/resistance/ingredient_en.csv で
FAMIC の成分名に対応づける (対応が無ければ、作用点の HRAC グループだけで照合する)。
一覧表は初確認の県だけを載せ、その後に広がった県は載せていない。

使い方:
  python3 scripts/import_resistance/wssj_japan.py              # ページを取得して取り込む
  python3 scripts/import_resistance/wssj_japan.py --input 保存したページ.html
"""

import argparse
import html
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import prefecture_name, today, write_external  # noqa: E402
from build_resistance import (INGREDIENT_EN_COLUMNS, RAW, codes_for_system, known_ingredient,  # noqa: E402
                              load_ingredient_rac, read_csv)

SOURCE_ID = "wssj_japan"
URL = "https://wssj.jp/~hr/index.html"
TITLE = "Herbicide Resistant Weeds in Japan (Uchino, Iwakami, Tominaga, Itoh)"
PUBLISHER = "日本雑草学会 除草剤抵抗性雑草研究会 (Japanese Herbicide Resistance Working Group, WSSJ)"
# 作物・場所の英語表記 → 日本語 (表示用)。無いものは英語のまま
CROP_JA = {
    "rice": "稲", "wheat": "小麦", "wheat, barley": "小麦、大麦", "vegetable": "野菜", "orchards": "果樹園",
    "mulberry": "桑", "paddy levees": "水田畦畔", "roadsides": "道路沿い", "railways": "鉄道敷",
    "golfcourses": "ゴルフ場", "golf courses": "ゴルフ場",
}
SPECIES_RE = r"([A-Z][a-z]+ (?:x )?[a-z\-]+(?: (?:var\.|subsp\.|ssp\.) [a-z\-]+)?)"


def text_of(cell):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", cell))).strip()


def parse(page):
    """一覧表の行と、詳細の (種, 年) → 除草剤名の集合 を返す"""
    table = re.search(r"<table.*?</table>", page, flags=re.S)
    if not table:
        sys.exit("ERROR: 一覧表が見つからない (ページの構成が変わった可能性)")
    rows = []
    for tr in re.findall(r"<tr.*?</tr>", table.group(0), flags=re.S):
        cells = [text_of(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, flags=re.S)]
        if len(cells) >= 8 and cells[0].isdigit():
            rows.append(dict(zip(["no", "year", "species", "japanese", "common", "soa", "prefecture", "crops"],
                                 cells[:8])))
    if cells_header_missing(table.group(0)):
        sys.exit("ERROR: 一覧表の見出しが想定と違う (Year / Species / Japanese Name / … / Crops)")

    rest = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", page[table.end():])))
    herbicides = {}
    blocks = list(re.finditer(SPECIES_RE + r"\s*\[Japanese Name\]", rest))
    for k, m in enumerate(blocks):
        body = rest[m.end(): blocks[k + 1].start() if k + 1 < len(blocks) else len(rest)]
        for c in re.finditer(r"\[Year\]\s*(\d{4})\s*/?\s*\[Herbicides?\]\s*(.+?)\s*"
                             r"(?=References|\[Prefecture\]|First Identification|$)", body):
            names = herbicides.setdefault((m.group(1), c.group(1)), set())
            for h in re.split(r",|、", re.sub(r"\(.*?\)", "", c.group(2))):
                h = h.strip(" /").lower()
                if h and h != "?":
                    names.add(h)
    return rows, herbicides


def cells_header_missing(table_html):
    head = text_of(table_html[: table_html.find("</tr>")])
    return not all(w in head for w in ["Year", "Species", "Japanese Name", "Site of Action", "Prefecture", "Crops"])


def main():
    ap = argparse.ArgumentParser(description="日本雑草学会の抵抗性雑草の一覧を取り込む")
    ap.add_argument("--input", help="保存したページの HTML (省略時は取得する)")
    args = ap.parse_args()
    if args.input:
        page = Path(args.input).read_text(encoding="utf-8")
    else:
        req = urllib.request.Request(URL, headers={"User-Agent": "browser-pesticide-search importer"})
        with urllib.request.urlopen(req, timeout=60) as res:
            page = res.read().decode("utf-8")

    rows, herbicides = parse(page)
    if len(rows) < 30:
        sys.exit(f"ERROR: 一覧表の行が {len(rows)} 行しか読めない (2026-10-22 時点で 43 行)")

    # 除草剤名 → (FAMIC の成分名, HRAC コード)。詳細の文章は同じ種・同じ年の別の行 (別の作用点) の事例も
    # 含むので、FAMIC の HRAC コードがその行の作用点に無い除草剤は、その行には付けない
    errors = []
    en_rows = read_csv(RAW / "ingredient_en.csv", INGREDIENT_EN_COLUMNS, errors)
    if errors:
        sys.exit("ERROR: " + " / ".join(errors))
    en_map = {r["english"].lower(): r["ingredient"] for r in en_rows}
    # 出典の綴りの誤りとして対応表に置いた名前 (glyphoaste) は、正しい綴りが同じ行にあればそちらを使う
    misspelled = {r["english"].lower() for r in en_rows if "綴りの誤り" in r["note"]}
    ing_rac = load_ingredient_rac()

    def famic(h):
        name = en_map.get(h)
        key = known_ingredient(name, ing_rac) if name else None
        return (name, codes_for_system(ing_rac[key], "H")) if key else (None, None)

    accessed = today()
    out = []
    for r in rows:
        groups = re.findall(r"HRAC\s*Group\s*(\w+)", r["soa"])
        base = {
            "scientific_name": r["species"], "japanese_name": r["japanese"], "kind": "雑草",
            "host_crop": CROP_JA.get(r["crops"].lower(), r["crops"]), "country": "日本",
            "survey_year": r["year"], "evidence": "データベースの記録", "level": "抵抗性あり",
            "source_wording": f"初確認 {r['year']} 年 {r['prefecture']} ({r['crops']})。作用点: {r['soa']}",
            "source_title": TITLE, "source_publisher": PUBLISHER, "source_url": URL,
            "source_page": f"一覧表 No.{r['no']}", "accessed": accessed,
        }
        # 県の欄に複数の県がある行 ("Ibaraki, Akita") は、県ごとに 1 行にする
        prefs = []
        for p in [x.strip() for x in r["prefecture"].split(",") if x.strip()]:
            name = prefecture_name(p)
            if not name:
                print(f"  注意 No.{r['no']}: 県名「{p}」を読めない。県を空にする")
            prefs.append(name or "")
        kept, seen = [], set()
        for h in sorted(herbicides.get((r["species"], r["year"]), set()), key=lambda h: (h in misspelled, h)):
            name, codes = famic(h)
            if codes is None:
                # FAMIC に対応しない除草剤 (失効したシマジンなど) は、作用点が 1 つの行でだけ、その系統として付ける
                if len(groups) == 1 and h not in seen:
                    kept.append({"ingredient_en": h, "rac_code": groups[0]})
                    seen.add(h)
            elif set(codes) & set(groups) and name not in seen:
                kept.append({"ingredient": name, "ingredient_en": h})
                seen.add(name)
        if not kept:
            kept = [{"rac_code": g, "ingredient_en": f"hrac{g}",
                     "note": "詳細の文章に除草剤名が見つからないため、作用点の系統だけで照合する"} for g in groups]
        for i, pref in enumerate(prefs or [""]):
            suffix = f"-{i + 1}" if len(prefs) > 1 else ""
            for k in kept:
                rid = f"{r['no']}{suffix}-{re.sub(r'[^a-z0-9]+', '-', k['ingredient_en'])}"
                rec = {**base, **k, "record_id": rid, "prefecture": pref}
                if k["ingredient_en"].startswith("hrac"):
                    rec["ingredient_en"] = ""
                out.append(rec)
    write_external(SOURCE_ID, out)
    print(f"   一覧表 {len(rows)} 行 → {len(out)} 行 (除草剤ごとに 1 行)")


if __name__ == "__main__":
    main()
