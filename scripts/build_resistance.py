#!/usr/bin/env python3
"""
rawdata/resistance/ の CSV から src/data/resistance.json (抵抗性・耐性の報告) を作り、内容を検査する。

入力 (列の意味は rawdata/resistance/README.md):
- taxa.csv        病原菌・害虫・雑草の種 (学名・和名・種類)
- pest_map.csv    FAMIC の病害虫名 → 種。同じ病名でも作物で病原菌が違うため、作物ごとに持つ (* は全作物)
- records.csv     国内の報告。利用者が確かめた行だけを置く (確認者・確認日が空ならビルドを止める)
- ingredient_en.csv  英語の成分名 → FAMIC の成分名 (外部データベースの取り込みに使う)
- sources.json    外部データベースごとの「配布物に残すか」(include)。include が true の出どころだけを入れる
- external/<id>.csv  取り込み役 (scripts/import_resistance/) が作った外部データベースの行 (Git 管理外)
- included/<id>.csv  配布物に残すと決めた外部データベースの行 (Git 管理。CI は external/ を持たないため)

成分の RAC コードは src/data/pesticides.json から付ける (成分名が登録データに無いときは CSV の rac_code)。
出力に日時を入れず、入力が同じなら同じファイルになる (週次の自動更新で毎回差分が出ないように)。
異常 (確認日の空欄、存在しない種、程度の値の誤りなど) が 1 つでもあれば、出力せずに終了コード 1。
"""

import argparse
import csv
import json
import re
import shutil
import sys
import unicodedata
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW = PROJECT_ROOT / "rawdata" / "resistance"
DB = PROJECT_ROOT / "src" / "data" / "pesticides.json"
APPS = PROJECT_ROOT / "src" / "data" / "applications.json"
OUT = PROJECT_ROOT / "src" / "data" / "resistance.json"

TAXA_COLUMNS = ["taxon_id", "scientific_name", "synonyms", "japanese_name", "kind", "source",
                "verified_by", "verified_at", "note"]
PEST_MAP_COLUMNS = ["pest", "crop", "taxon_ids", "source", "verified_by", "verified_at", "note"]
RECORD_COLUMNS = ["record_id", "taxon_id", "host_crop", "country", "prefecture", "survey_year", "published",
                  "ingredient", "rac_code", "evidence", "metric", "level", "source_wording",
                  "source_title", "source_publisher", "source_url", "source_page", "accessed",
                  "verified_by", "verified_at", "note"]
# 外部データベースの行は種を学名で持つ (taxa.csv に無い種もあるため)。確認は sources.json で取り込みの単位に行う
EXTERNAL_COLUMNS = ["record_id", "scientific_name", "japanese_name", "kind", "host_crop", "country", "prefecture",
                    "survey_year", "published", "ingredient", "ingredient_en", "rac_code", "evidence", "metric",
                    "level", "source_wording", "source_title", "source_publisher", "source_url", "source_page",
                    "accessed", "note"]
INGREDIENT_EN_COLUMNS = ["english", "ingredient", "note"]

# 種類 → RAC の系統 (IRAC=I / FRAC=F / HRAC=H)。成分の RAC コードのうち、どの系統のコードと照合するかを決める
KIND_SYSTEM = {"昆虫": "I", "ダニ": "I", "線虫": "I", "糸状菌": "F", "卵菌": "F", "細菌": "F", "雑草": "H"}
# 程度の 4 段階 (rawdata/resistance/README.md)。CSV には日本語の名前で書き、JSON にはキーで出す
LEVELS = {"効果低下": "field_failure", "抵抗性あり": "resistant", "感受性低下": "reduced", "検出されず": "not_detected"}
EVIDENCE = {"圃場での効果低下", "生物検定", "遺伝子診断", "データベースの記録"}
JAPAN = "日本"

# 都道府県 (JIS X 0401 の順。コードは 01〜47)
PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
    "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
    "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]
PREF_CODE = {}
for _i, _name in enumerate(PREFECTURES, start=1):
    PREF_CODE[_name] = f"{_i:02d}"
    PREF_CODE[re.sub(r"[都府県]$", "", _name)] = f"{_i:02d}"  # 「茨城」でも可

YEAR_RE = re.compile(r"^\d{4}(-\d{4})?$")
DATE_RE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def norm(s):
    """照合用: NFKC にして空白を除く (成分名・病害虫名・作物名)"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s or ""))


def norm_sci(s):
    """学名の照合用: 空白をそろえて小文字にする"""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s or "")).strip().lower()


# 成分名の名寄せで無視してよい語尾 (build_data.py の _SALT_SUFFIXES と同じ。src/js/core/resistance.js にも同じ表がある)
SALT_SUFFIXES = sorted(
    ["ナトリウム塩", "カリウム塩", "アンモニウム塩", "カルシウム塩", "マグネシウム塩", "銅塩", "亜鉛塩",
     "イソプロピルアミン塩", "ジメチルアミン塩", "塩酸塩", "硫酸塩", "酢酸塩", "水和物", "塩"],
    key=len, reverse=True,
)


def ingredient_stem(name):
    """成分名から塩・水和物の語尾を除いた名前 (グリホサートカリウム塩 → グリホサート)"""
    n = norm(name)
    for suf in SALT_SUFFIXES:
        if n.endswith(suf) and len(n) - len(suf) >= 2:
            return n[: -len(suf)]
    return n


def read_csv(path, columns, errors, required=True):
    """UTF-8 (BOM 可) の CSV を読む。見出しが columns と違えばエラー。空行は飛ばす"""
    if not path.exists():
        if required:
            errors.append(f"{path.relative_to(PROJECT_ROOT)} が無い")
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        missing = [c for c in columns if c not in header]
        if missing:
            errors.append(f"{path.relative_to(PROJECT_ROOT)}: 列が無い {missing}")
            return []
        rows = []
        for n, row in enumerate(reader, start=2):  # 1 行目は見出し
            row = {k: (v or "").strip() for k, v in row.items() if k}
            if not any(row.values()):
                continue
            row["_where"] = f"{path.relative_to(PROJECT_ROOT)}:{n}"
            rows.append(row)
        return rows


def codes_for_system(rac_code, system):
    """RAC コード文字列から、系統 system のコードの一覧を返す (normalize.js の splitRacCode と同じ約束)。
    "UN(I*), M2(F*)" のような印付きは印で振り分け、印の無い単独のコードはそのまま返す"""
    s = (rac_code or "").strip()
    if not s:
        return []
    if re.search(r"\((I|F|H)\*\)", s):
        out = []
        for part in re.split(r"[,、]", s):
            m = re.match(r"^\s*(.+?)\s*\((I|F|H)\*\)\s*$", part)
            if m and m.group(2) == system:
                out.append(m.group(1).strip())
        return out
    return [s]


def load_ingredient_rac():
    """登録データの成分名 → RAC コード。正規化した名前と、塩・水和物の語尾を除いた名前の両方で引ける。
    現行剤の成分だけ (失効剤は成分を持たない)"""
    with open(DB, encoding="utf-8") as f:
        db = json.load(f)
    out = {}
    for p in db["products"]:
        for ing in p.get("ingredients") or []:
            for key in {norm(ing.get("name")), ingredient_stem(ing.get("name"))}:
                if key and (key not in out or (not out[key] and ing.get("rac_code"))):
                    out[key] = ing.get("rac_code") or ""
    return out


def known_ingredient(name, ing_rac):
    """成分名が登録データにあれば、引くための名前 (正規化した名前か、語尾を除いた名前) を返す"""
    for key in (norm(name), ingredient_stem(name)):
        if key and key in ing_rac:
            return key
    return None


def load_pest_and_crop_names():
    """適用データに現れる病害虫名・作物名 (正規化)。pest_map の名前の誤記に気づくための警告に使う"""
    if not APPS.exists():
        return set(), set()
    with open(APPS, encoding="utf-8") as f:
        apps = json.load(f).get("applications", {})
    pests, crops = set(), set()
    for rows in apps.values():
        for a in rows:
            if a.get("pest"):
                pests.add(norm(re.sub(r"[(（][^()（）]*(除く|のぞく)[)）]", "", a["pest"])))
            for v in (a.get("crop"), a.get("place")):
                if v:
                    crops.add(norm(v))
                    crops.add(norm(re.sub(r"[(（].*$", "", v)))
    return pests, crops


def check_common(row, errors, where):
    """records.csv と外部データベースの行に共通する検査。正規化した値を返す"""
    out = {}
    country = row.get("country") or JAPAN
    out["country"] = country
    pref = row.get("prefecture", "")
    if country == JAPAN:
        if pref and pref not in PREF_CODE:
            errors.append(f"{where}: 都道府県の名前が不正 ({pref})")
        out["pref"] = PREF_CODE.get(pref, "")
    else:
        if pref:
            errors.append(f"{where}: 国が {country} なのに都道府県がある ({pref})")
        out["pref"] = ""
    year = row.get("survey_year", "")
    if year and not YEAR_RE.match(year):
        errors.append(f"{where}: 調査年は 2024 か 2023-2024 の形で書く ({year})")
    published = row.get("published", "")
    if published and not DATE_RE.match(published):
        errors.append(f"{where}: 公表日は 2025、2025-02、2025-02-10 のいずれかの形で書く ({published})")
    if not year and not published:
        errors.append(f"{where}: 調査年と公表日の両方が空")
    level = row.get("level", "")
    if level not in LEVELS:
        errors.append(f"{where}: 程度は {list(LEVELS)} のどれか ({level or '空'})")
    evidence = row.get("evidence", "")
    if evidence not in EVIDENCE:
        errors.append(f"{where}: 根拠の種類は {sorted(EVIDENCE)} のどれか ({evidence or '空'})")
    if not re.match(r"^https?://", row.get("source_url", "")):
        errors.append(f"{where}: 出典の URL が空か、http(s):// で始まらない ({row.get('source_url', '')})")
    accessed = row.get("accessed", "")
    if not DAY_RE.match(accessed):
        errors.append(f"{where}: 閲覧日は 2026-10-22 の形で書く ({accessed or '空'})")
    out.update({
        "year": year, "published": published, "level": LEVELS.get(level, ""), "evidence": evidence,
        "metric": row.get("metric", ""), "wording": row.get("source_wording", ""),
        "host": row.get("host_crop", ""),
        "src": {k: v for k, v in {
            "title": row.get("source_title", ""), "publisher": row.get("source_publisher", ""),
            "url": row.get("source_url", ""), "page": row.get("source_page", ""), "accessed": accessed,
        }.items() if v},
    })
    if row.get("note"):
        out["note"] = row["note"]
    return out


def resolve_rac(row, system, ing_rac, errors, where):
    """成分の RAC コード (系統 system のもの)。登録データの成分名ならそこから、無ければ CSV の rac_code"""
    name = row.get("ingredient", "")
    given = row.get("rac_code", "")
    key = known_ingredient(name, ing_rac) if name else None
    if key:
        code = ing_rac[key]
        if given and given != code:
            print(f"  注意 {where}: rac_code {given} は登録データの {code} と違う。登録データの値を使う")
        return codes_for_system(code, system)
    if not given:
        errors.append(f"{where}: 成分「{name}」が登録データに無い。rac_code を書く")
        return []
    return codes_for_system(given, system)


def sync_included(sources, errors):
    """include の設定に合わせて external/<id>.csv を included/<id>.csv へ写す、または included から外す。
    include を false にしても、external に元が無ければ included から external へ戻してから外す (データを失わない)"""
    ext_dir, inc_dir = RAW / "external", RAW / "included"
    for s in sources:
        sid = s["id"]
        ext, inc = ext_dir / f"{sid}.csv", inc_dir / f"{sid}.csv"
        if s.get("include"):
            if ext.exists():
                inc_dir.mkdir(exist_ok=True)
                if not inc.exists() or inc.read_bytes() != ext.read_bytes():
                    shutil.copyfile(ext, inc)
                    print(f"  {sid}: external → included に写した")
            elif not inc.exists():
                errors.append(f"sources.json: {sid} は include が true だが、取り込んだデータ "
                              f"(rawdata/resistance/external/{sid}.csv) が無い")
        elif inc.exists():
            if not ext.exists():
                ext_dir.mkdir(exist_ok=True)
                shutil.copyfile(inc, ext)
            inc.unlink()
            print(f"  {sid}: include が false なので included から外した (external/{sid}.csv に残る)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--check", action="store_true", help="検査だけして resistance.json を書かない")
    args = ap.parse_args()

    if not DB.exists():
        sys.exit("ERROR: pesticides.json が無い。先に scripts/build_data.py を実行してください。")

    errors, warnings = [], []
    ing_rac = load_ingredient_rac()
    known_pests, known_crops = load_pest_and_crop_names()

    with open(RAW / "sources.json", encoding="utf-8") as f:
        sources = json.load(f)["sources"]
    ids = [s.get("id") for s in sources]
    for s in sources:
        if not re.match(r"^[a-z0-9_]+$", s.get("id") or ""):
            errors.append(f"sources.json: id は英小文字・数字・_ で書く ({s.get('id')})")
        if s.get("include") and not (s.get("terms_checked") and s.get("verified_at")):
            errors.append(f"sources.json: {s['id']} を配布物に残す (include: true) には、"
                          "利用条件の確認 (terms_checked) と取り込みの確認日 (verified_at) が要る")
    if len(set(ids)) != len(ids):
        errors.append("sources.json: id が重複している")
    if not args.check and not errors:  # 設定に誤りがあれば、included/ を書き換えない
        sync_included(sources, errors)

    # --- 種 ---
    taxa = {}
    sci_index = {}
    for row in read_csv(RAW / "taxa.csv", TAXA_COLUMNS, errors):
        w = row["_where"]
        tid = row["taxon_id"]
        if not re.match(r"^[a-z0-9_]+$", tid):
            errors.append(f"{w}: taxon_id は英小文字・数字・_ で書く ({tid})")
        if tid in taxa:
            errors.append(f"{w}: taxon_id が重複 ({tid})")
        if row["kind"] not in KIND_SYSTEM:
            errors.append(f"{w}: 種類は {list(KIND_SYSTEM)} のどれか ({row['kind'] or '空'})")
        if not row["scientific_name"]:
            errors.append(f"{w}: 学名が空")
        if not (row["verified_by"] and DAY_RE.match(row["verified_at"])):
            errors.append(f"{w}: 確認者・確認日 (2026-10-22 の形) が無い。確かめていない行は入れない")
        syn = [x.strip() for x in row["synonyms"].split(";") if x.strip()]
        taxa[tid] = {"sci": row["scientific_name"], "ja": row["japanese_name"], "kind": row["kind"],
                     "sys": KIND_SYSTEM.get(row["kind"], ""), "syn": syn, "source": row["source"]}
        for name in [row["scientific_name"], *syn]:
            sci_index[norm_sci(name)] = tid

    # --- 病害虫名 → 種 ---
    pest_map = []
    seen_map = set()
    for row in read_csv(RAW / "pest_map.csv", PEST_MAP_COLUMNS, errors):
        w = row["_where"]
        tids = [x.strip() for x in row["taxon_ids"].split(";") if x.strip()]
        if not row["pest"] or not row["crop"] or not tids:
            errors.append(f"{w}: 病害虫名・作物名 (全作物なら *)・種 ID のどれかが空")
        for t in tids:
            if t not in taxa:
                errors.append(f"{w}: 種 ID {t} が taxa.csv に無い")
        if not (row["verified_by"] and DAY_RE.match(row["verified_at"])):
            errors.append(f"{w}: 確認者・確認日 (2026-10-22 の形) が無い。確かめていない行は入れない")
        key = (norm(row["pest"]), norm(row["crop"]))
        if key in seen_map:
            errors.append(f"{w}: 同じ病害虫名と作物の組が重複 ({row['pest']}, {row['crop']})")
        seen_map.add(key)
        if known_pests and norm(row["pest"]) not in known_pests:
            warnings.append(f"{w}: 病害虫名「{row['pest']}」は適用データに無い")
        if row["crop"] != "*" and known_crops and norm(row["crop"]) not in known_crops:
            warnings.append(f"{w}: 作物名「{row['crop']}」は適用データの作物欄に無い")
        entry = {"pest": row["pest"], "crop": row["crop"], "taxa": tids, "source": row["source"]}
        if row["note"]:
            entry["note"] = row["note"]
        pest_map.append(entry)

    # --- 国内の報告 ---
    records = []
    record_ids = set()
    for row in read_csv(RAW / "records.csv", RECORD_COLUMNS, errors):
        w = row["_where"]
        rid = row["record_id"]
        if not rid or rid in record_ids:
            errors.append(f"{w}: record_id が空か重複 ({rid})")
        record_ids.add(rid)
        if not (row["verified_by"] and DAY_RE.match(row["verified_at"])):
            errors.append(f"{w}: 確認者・確認日 (2026-10-22 の形) が無い。確かめていない行は入れない")
        taxon = taxa.get(row["taxon_id"])
        if not taxon:
            errors.append(f"{w}: 種 ID {row['taxon_id']} が taxa.csv に無い")
        if not row["ingredient"]:
            errors.append(f"{w}: 成分が空")
        if (row.get("country") or JAPAN) == JAPAN and not row["prefecture"]:
            errors.append(f"{w}: 国内の報告なのに都道府県が空")
        rec = {"id": rid, "taxon": row["taxon_id"], "ingredient": row["ingredient"],
               "rac": resolve_rac(row, taxon["sys"], ing_rac, errors, w) if taxon else [],
               "origin": "domestic"}
        rec.update(check_common(row, errors, w))
        records.append(rec)

    # --- 外部データベース (include が true のものだけ) ---
    en_map = {}
    for row in read_csv(RAW / "ingredient_en.csv", INGREDIENT_EN_COLUMNS, errors):
        if not known_ingredient(row["ingredient"], ing_rac):
            warnings.append(f"{row['_where']}: 成分「{row['ingredient']}」は登録データに無い")
        en_map[row["english"].strip().lower()] = row["ingredient"]
    used_sources = []
    for s in sources:
        if not s.get("include"):
            continue
        path = RAW / "included" / f"{s['id']}.csv"
        rows = read_csv(path, EXTERNAL_COLUMNS, errors, required=False)
        skipped = 0
        for row in rows:
            w = row["_where"]
            kind = row["kind"]
            if kind not in KIND_SYSTEM:
                errors.append(f"{w}: 種類は {list(KIND_SYSTEM)} のどれか ({kind or '空'})")
                continue
            tid = sci_index.get(norm_sci(row["scientific_name"]))
            if not tid:
                # taxa.csv に無い種は、外部データベースの学名のまま種を作る (和名は出どころの表記)
                tid = "ext_" + re.sub(r"[^a-z0-9]+", "_", norm_sci(row["scientific_name"])).strip("_")
                if tid not in taxa:
                    taxa[tid] = {"sci": row["scientific_name"], "ja": row["japanese_name"], "kind": kind,
                                 "sys": KIND_SYSTEM[kind], "syn": [], "source": s["name"]}
                    sci_index[norm_sci(row["scientific_name"])] = tid
            ingredient = row["ingredient"]
            if not ingredient and row["ingredient_en"]:
                ingredient = en_map.get(row["ingredient_en"].strip().lower(), "")
            if not ingredient and not row["rac_code"]:
                skipped += 1  # 成分も系統も分からない行は照合できない
                continue
            row = {**row, "ingredient": ingredient}
            rec = {"id": f"{s['id']}:{row['record_id']}", "taxon": tid,
                   "ingredient": ingredient or row["ingredient_en"],
                   "rac": resolve_rac(row, KIND_SYSTEM[kind], ing_rac, errors, w),
                   "origin": s["id"]}
            if not ingredient:
                rec["ingredient_en"] = row["ingredient_en"]  # FAMIC の成分名に対応づかない (系統だけで照合)
            rec.update(check_common(row, errors, w))
            records.append(rec)
        if skipped:
            warnings.append(f"{s['id']}: 成分名を FAMIC の名前に対応づけられず、RAC コードも無い {skipped} 行を除いた "
                            "(rawdata/resistance/ingredient_en.csv に対応を足すと入る)")
        used_sources.append({"id": s["id"], "name": s["name"], "url": s.get("url", ""),
                             "region": s.get("region", "")})

    for w in warnings:
        print(f"  警告 {w}")
    if errors:
        for e in errors:
            print(f"NG {e}")
        sys.exit(1)

    records.sort(key=lambda r: (r["origin"] != "domestic", r["origin"], r["id"]))
    out = {
        "schema_version": 1,
        "taxa": dict(sorted(taxa.items())),
        "pest_map": pest_map,
        "records": records,
        "sources": used_sources,
    }
    domestic = sum(1 for r in records if r["origin"] == "domestic")
    print(f"種 {len(taxa)} / 病害虫名の対応 {len(pest_map)} / 報告 {len(records)} "
          f"(国内の確認済み {domestic}、外部データベース {len(records) - domestic})")
    if args.check:
        print("OK 検査のみ (resistance.json は書いていない)")
        return
    text = json.dumps(out, ensure_ascii=False, indent=1) + "\n"
    if OUT.exists() and OUT.read_text(encoding="utf-8") == text:
        print(f"OK {OUT.relative_to(PROJECT_ROOT)} は変更なし")
        return
    OUT.write_text(text, encoding="utf-8")
    print(f"OK {OUT.relative_to(PROJECT_ROOT)} を書いた")


if __name__ == "__main__":
    main()
