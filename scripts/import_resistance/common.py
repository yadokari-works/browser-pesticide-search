"""
外部データベースの取り込み役が共用する部品。
取り込んだ行は rawdata/resistance/external/<id>.csv (Git 管理外) に、build_resistance.py の EXTERNAL_COLUMNS の列で書く。
配布物に残すかは rawdata/resistance/sources.json の include で決める (build_resistance.py が included/ へ写す)。
"""

import csv
import datetime
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from build_resistance import EXTERNAL_COLUMNS, PREFECTURES, RAW  # noqa: E402

SOURCES_JSON = RAW / "sources.json"

# 都道府県のローマ字 → 名前 (取り込み元の表記ゆれ Ohita・Hyougo なども受ける)
_ROMAJI = [
    "hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima", "ibaraki", "tochigi", "gunma",
    "saitama", "chiba", "tokyo", "kanagawa", "niigata", "toyama", "ishikawa", "fukui", "yamanashi", "nagano",
    "gifu", "shizuoka", "aichi", "mie", "shiga", "kyoto", "osaka", "hyogo", "nara", "wakayama",
    "tottori", "shimane", "okayama", "hiroshima", "yamaguchi", "tokushima", "kagawa", "ehime", "kochi", "fukuoka",
    "saga", "nagasaki", "kumamoto", "oita", "miyazaki", "kagoshima", "okinawa",
]
PREF_ROMAJI = dict(zip(_ROMAJI, PREFECTURES))
PREF_ROMAJI.update({"ohita": "大分県", "hyougo": "兵庫県", "kouchi": "高知県", "gumma": "群馬県",
                    "kyouto": "京都府", "oosaka": "大阪府", "toukyou": "東京都"})

JAPAN_NAMES = {"japan", "日本", "jp", "jpn"}


def prefecture_name(text):
    """ローマ字か日本語の都道府県名を、build_resistance.py が受け付ける名前にする。分からなければ None"""
    t = (text or "").strip().lower()
    t = re.sub(r"\s*(prefecture|pref\.?)$", "", t)
    t = re.sub(r"-(ken|fu|to)$", "", t)
    t = re.sub(r"[\s\-]", "", t)
    if t in PREF_ROMAJI:
        return PREF_ROMAJI[t]
    for name in PREFECTURES:
        if text and (text.strip() == name or text.strip() == re.sub(r"[都府県]$", "", name)):
            return name
    return None


def country_name(text):
    """日本を表す表記は「日本」にそろえ、それ以外は取り込み元の表記のまま返す"""
    t = (text or "").strip()
    return "日本" if t.lower() in JAPAN_NAMES else t


def today():
    return datetime.date.today().isoformat()


def write_external(source_id, rows):
    """取り込んだ行を external/<id>.csv に書き、sources.json の imported_at を今日にする"""
    out_dir = RAW / "external"
    out_dir.mkdir(exist_ok=True)
    path = out_dir / f"{source_id}.csv"
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=EXTERNAL_COLUMNS, extrasaction="raise")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in EXTERNAL_COLUMNS})
    data = json.loads(SOURCES_JSON.read_text(encoding="utf-8"))
    for s in data["sources"]:
        if s["id"] == source_id:
            s["imported_at"] = today()
            break
    else:
        sys.exit(f"ERROR: sources.json に id {source_id} が無い")
    SOURCES_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK {path.relative_to(RAW.parent.parent)} に {len(rows)} 行を書いた")
    print("   配布物に残すかは rawdata/resistance/sources.json の include で決める "
          "(true にするには terms_checked と verified_at を書く)。その後 python3 scripts/build_resistance.py")
