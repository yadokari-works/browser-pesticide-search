#!/usr/bin/env python3
"""
農林水産省の通知「農薬の適用病害虫の範囲及び使用方法に係る適用農作物等の名称について」
(平成31年3月29日付け30消安第6281号、FAMIC 掲載 PDF) の表から、作物群とそこに含まれる作物、
作物の別名の対応表を作り、src/js/core/crop_groups.js に書き出す。

検索で「こまつな」と入力したとき、適用作物が「非結球あぶらな科葉菜類」で
登録されている剤も拾うために使う (src/js/core/normalize.js の cropGroupMembers)。
別名は、正式名で登録された行を別名で引くのにも使う (同 cropAliasSet。例: 京菜 → みずな)。

分類表は通知の改正時 (数年に一度) にしか変わらないため、毎週のデータ更新では実行しない。
改正があったら PDF_URL を新しい版に差し替えて手動で実行する。

依存: pdfplumber (このスクリプトだけが使う)

  python3 scripts/build_crop_groups.py            # PDF を取得して生成
  python3 scripts/build_crop_groups.py --pdf FILE # 手元の PDF から生成
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import unicodedata
import urllib.request
from collections import defaultdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT = PROJECT_ROOT / "src" / "js" / "core" / "crop_groups.js"

PDF_URL = "https://www.acis.famic.go.jp/shinsei/6281_20240401.pdf"
PDF_REVISION = "令和6年4月1日改正"
USER_AGENT = "browser-pesticide-search-updater/1.0 (+https://github.com/)"

# 列の x 範囲 (pt)。表1 (食用・飼料用) は 1〜12 ページ、表2 (それ以外) は 13 ページ以降。
TABLE1_COLS = {"large": (58, 135), "mid": (135, 245), "small": (245, 357), "name": (357, 527), "alias": (527, 664)}
TABLE2_COLS = {"large": (76, 210), "mid": (210, 344), "name": (344, 478), "alias": (478, 611)}
TABLE2_FIRST_PAGE = 13

# 表2 注2): 大グループ「薬用作物」は、表1 の大作物群「野菜類」の適用のある農薬を使用できる。
EXTRA_MEMBERS = {"野菜類": ["薬用作物"]}

# 別名欄の括弧のうち、別名ではなく注記 (栽培の型・収穫部位) を書いた語。
# "水稲(移植、直播)" → 水稲、"海野(肥大茎)" → 海野。別名にすると "直播" の検索で稲の登録すべてが出てしまう。
NOTE_WORDS = {"移植", "直播", "肥大茎"}


def nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s).strip()


def clean_name(s: str) -> str:
    # 「※」は食用・飼料用の両方に使う作物の印で、作物名の一部ではない
    return nfkc(s).replace("※", "").strip()


def norm_key(s: str) -> str:
    """検索側 (src/js/core/normalize.js の normalize) と同じ正規化。重なりの判定に使う。
    NFKC → ひらがなをカタカナに → 大文字化 → 空白除去 ("ハゲイトウ" と "はげいとう" は同じ語)。"""
    t = unicodedata.normalize("NFKC", s)
    t = "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in t)
    return "".join(t.upper().split())


def cell_bounds(page, xa: float, xb: float, top: float, bottom: float) -> list[tuple[float, float]]:
    """列 [xa, xb] を横切る罫線で区切ったセルの (上端, 下端)。ページの上下端も境界に含める。"""
    ys = {round(e["top"], 1) for e in page.edges
          if e["orientation"] == "h" and e["x0"] <= xa + 3 and e["x1"] >= xb - 3
          and top - 1 <= e["top"] <= bottom + 1}
    ys |= {round(top, 1), round(bottom, 1)}
    ys = sorted(ys)
    return [(a, b) for a, b in zip(ys, ys[1:]) if b - a >= 2]


def text_in(words, xa: float, xb: float, a: float, b: float) -> str:
    ws = [w for w in words
          if xa - 1 <= (w["x0"] + w["x1"]) / 2 <= xb + 1 and a <= (w["top"] + w["bottom"]) / 2 <= b]
    ws.sort(key=lambda w: (round(w["top"]), w["x0"]))
    return "".join(w["text"] for w in ws).strip()


def extract_rows(pdf_path: Path) -> list[dict]:
    import pdfplumber

    rows = []
    carry: dict = {}
    with pdfplumber.open(pdf_path) as pdf:
        for pi, page in enumerate(pdf.pages):
            table = 1 if pi + 1 < TABLE2_FIRST_PAGE else 2
            cols = TABLE1_COLS if table == 1 else TABLE2_COLS
            if carry.get("table") != table:
                carry = {"table": table}
            v = [e for e in page.edges if e["orientation"] == "v"]
            if not v:
                continue
            top, bottom = min(e["top"] for e in v), max(e["bottom"] for e in v)
            words = page.extract_words()
            group_cells = {
                g: [(a, b, text_in(words, *cols[g], a, b)) for a, b in cell_bounds(page, *cols[g], top, bottom)]
                for g in ("large", "mid", "small") if g in cols
            }
            for a, b in cell_bounds(page, *cols["name"], top, bottom):
                name = text_in(words, *cols["name"], a, b)
                alias = text_in(words, *cols["alias"], a, b)
                mid_y = (a + b) / 2
                groups = {}
                for g, cells in group_cells.items():
                    for ga, gb, gt in cells:
                        if not (ga <= mid_y <= gb):
                            continue
                        if gt:
                            carry[g] = gt
                        elif ga > top + 1 and ga >= a - 1:
                            # この行から始まる空欄のセル = グループ無し
                            # (ページ先頭の空欄は前ページからの続き)
                            carry.pop(g, None)
                        groups[g] = carry.get(g, "")
                        break
                rows.append({"page": pi + 1, "table": table, **groups, "name": name, "alias": alias})
    return rows


def build_groups(rows: list[dict]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        name = clean_name(r["name"])
        # 見出し行と、作物名欄にある注記の文 (「作物群内の作物間での交配種は…」など) を除く
        if not name or "。" in name or name == "作物名":
            continue
        for g in ("large", "mid", "small"):
            label = nfkc(r.get(g, ""))
            if not label or label in ("－", "-", "大作物群", "中作物群", "小作物群", "大グループ名", "中グループ名"):
                continue
            if name not in groups[label]:
                groups[label].append(name)
    for target, sources in EXTRA_MEMBERS.items():
        for src in sources:
            for name in groups.get(src, []):
                if name not in groups[target]:
                    groups[target].append(name)
    return dict(groups)


def split_aliases(text: str) -> list[str]:
    """別名欄を語に分ける。"さんとうさい（山東菜、べかな）" → [さんとうさい, 山東菜, べかな]。
    括弧の中が "〜栽培" の語 ("こまつな（なばな的栽培）") は栽培方法の注記なので括弧ごと 1 語にする。
    括弧の中が注記の語 (NOTE_WORDS) だけなら括弧ごと外す ("水稲（移植、直播）" → [水稲])。
    括弧の後に "の〜" が続く語は、括弧の前の語と括弧の中の各語の両方に付ける
    ("ヤマノイモ（ジネンジョ）のむかご" → [ヤマノイモのむかご, ジネンジョのむかご])。"""
    t = nfkc(text).replace("注1)", "").replace("注2)", "")
    t = re.sub(r"\(([^()]*)\)",
               lambda m: "" if all(w.strip() in NOTE_WORDS for w in m[1].split("、")) else m[0], t)
    t = re.sub(r"([^、()]+)\(([^()]+)\)(の[^、()]+)",
               lambda m: "、".join([m[1] + m[3]] + [w + m[3] for w in m[2].split("、")]), t)
    items, cur, inner, depth = [], "", "", 0
    for ch in t:
        if ch == "(":
            depth += 1
            if depth == 1:
                inner = ""
                continue
        elif ch == ")":
            depth -= 1
            if depth == 0:
                if inner.strip().endswith("栽培"):
                    cur += f"({inner.strip()})"
                else:
                    items.append(cur)
                    items.extend(inner.split("、"))
                    cur = ""
                continue
        if depth >= 1:
            inner += ch
        elif ch == "、":
            items.append(cur)
            cur = ""
        else:
            cur += ch
    items.append(cur)
    return [x.strip() for x in items if x.strip()]


def build_aliases(rows: list[dict], groups: dict[str, list[str]]) -> dict[str, list[str]]:
    """作物群に属する作物の別名 (作物名 → 別名の配列)。
    別の作物名と同じ語・複数の作物に出てくる語・"〜栽培" "〜除く" を含む語は、
    除外の解決や検索で別の作物を巻き込むので使わない。
    同じ語かどうかは検索側と同じ正規化 (norm_key) で判定する
    (別名 "ハゲイトウ" は花き類の作物名 "はげいとう" と同じ語なので使わない)。"""
    members = {m for ms in groups.values() for m in ms}
    member_keys = {norm_key(m) for m in members}
    raw: dict[str, list[str]] = {}
    seen: dict[str, int] = defaultdict(int)
    for r in rows:
        name = clean_name(r["name"])
        if name not in members or not r.get("alias"):
            continue
        words = [w for w in split_aliases(r["alias"])
                 if norm_key(w) != norm_key(name) and "栽培" not in w and "除く" not in w and "。" not in w and len(w) <= 20]
        raw[name] = words
        for k in {norm_key(w) for w in words}:
            seen[k] += 1
    out = {}
    for name, words in raw.items():
        ok, keys = [], set()
        for w in words:
            k = norm_key(w)
            if k in keys or seen[k] != 1 or k in member_keys:
                continue
            keys.add(k)
            ok.append(w)
        if ok:
            out[name] = ok
    return out


def write_js(groups: dict[str, list[str]], aliases: dict[str, list[str]]) -> None:
    body = json.dumps(groups, ensure_ascii=False, indent=2)
    alias_body = json.dumps(aliases, ensure_ascii=False, indent=2)
    js = (
        "/**\n"
        " * 作物群 → 含まれる作物 の対応表 (scripts/build_crop_groups.py が生成。手で編集しない)\n"
        " * 出典: 農林水産省「農薬の適用病害虫の範囲及び使用方法に係る適用農作物等の名称について」\n"
        f" *       (平成31年3月29日付け30消安第6281号、{PDF_REVISION}) の表1・表2\n"
        f" *       {PDF_URL}\n"
        " * 表2 注2) により「野菜類」には「薬用作物」の作物も含めている。\n"
        " * 表1 注2) と表2 注1) のとおり、大作物群、中作物群の豆類(種実)・豆類(未成熟)・ピーマン及びとうがらし類、\n"
        " * 表2 の大・中グループには、表に載っていない作物も含まれる。そのため、この表は網羅的ではない。\n"
        " */\n"
        f"export const CROP_GROUPS = {body};\n"
        "\n"
        "/** 作物名 → 表の「作物名に含まれる別名、地方名、品種名等の例」\n"
        " * (別の作物名と重なる語・複数の作物に出てくる語は除いてある。ひらがなとカタカナの違いは同じ語とみなす) */\n"
        f"export const CROP_ALIASES = {alias_body};\n"
    )
    OUT.write_text(js, encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf", type=Path, help="手元の分類表 PDF (省略時は PDF_URL から取得)")
    args = ap.parse_args()

    if args.pdf:
        pdf_path = args.pdf
    else:
        req = urllib.request.Request(PDF_URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        tmp.write(data)
        tmp.close()
        pdf_path = Path(tmp.name)

    rows = extract_rows(pdf_path)
    groups = build_groups(rows)
    aliases = build_aliases(rows, groups)
    if len(groups) < 40:
        sys.exit(f"ERROR: 作物群が {len(groups)} 件しか取れませんでした。PDF の版や列の位置が変わった可能性があります。")
    write_js(groups, aliases)
    total = sum(len(v) for v in groups.values())
    n_alias = sum(len(v) for v in aliases.values())
    print(f"OK: {OUT.relative_to(PROJECT_ROOT)} (作物群 {len(groups)} 件, 所属 {total} 件, 別名 {n_alias} 語)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
