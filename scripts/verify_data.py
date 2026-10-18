#!/usr/bin/env python3
"""
生成された pesticides.json の整合性・統計をレポートする。
明らかな異常 (登録番号の重複、成分や商品名の無い有効剤、失効剤 0 件、前回のコミットからの件数の急減) が
あれば終了コード 1 で止める。update_data.py はこの終了コードで更新を止める。
"""

import json
import subprocess
import sys
from pathlib import Path
from collections import Counter

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB = PROJECT_ROOT / "src" / "data" / "pesticides.json"
APPS = PROJECT_ROOT / "src" / "data" / "applications.json"

# 前回のコミットのデータから、有効剤の数・適用行の数がこの割合を下回ったら異常とする
MIN_RATIO_TO_PREVIOUS = 0.9


def load_previous(rel_path):
    """前回のコミット (HEAD) のデータを読む。Git が無い、ファイルが無いときは None"""
    try:
        out = subprocess.run(["git", "show", f"HEAD:{rel_path}"], cwd=PROJECT_ROOT,
                             capture_output=True, check=True)
        return json.loads(out.stdout.decode("utf-8"))
    except (OSError, subprocess.CalledProcessError, ValueError):
        return None


def count_app_rows(apps_data, products):
    app_map = apps_data.get("applications", {})
    return sum(len(app_map.get(str(p["reg_no"]), [])) for p in products)


def main():
    if not DB.exists():
        sys.exit("ERROR: pesticides.json が無い。先に build_data.py を実行してください。")

    with open(DB, encoding="utf-8") as f:
        db = json.load(f)

    products = db["products"]
    stats = db["stats"]
    active = [p for p in products if p.get("status") != "失効"]
    cancelled = [p for p in products if p.get("status") == "失効"]
    errors = []  # 異常 (終了コード 1)

    print(f"=== 農薬データベース検証 ===")
    print(f"Generated: {db['generated_at']}")
    print(f"Sources: {json.dumps(db['sources'], ensure_ascii=False)}")
    print()

    print(f"商品総数: {len(products)} (有効 {len(active)} / 失効 {len(cancelled)})")
    print(f"用途別: {stats['by_category']}")
    print(f"家庭向け除外: {stats['household_excluded_by_default']}")
    print(f"RAC マッチ: {stats['rac_matched']} ({stats['rac_match_rate']*100:.1f}%)")
    print()

    # 検証1: reg_no 重複チェック
    reg_nos = [p["reg_no"] for p in products]
    dup = [n for n, c in Counter(reg_nos).items() if c > 1]
    print(f"[1] 登録番号重複: {'OK なし' if not dup else f'NG あり: {dup[:5]}...'}")
    if dup:
        errors.append(f"登録番号の重複 {len(dup)} 件")

    # 検証2: 必須フィールド。失効剤は成分データが無いのが正常なので、成分は有効剤だけを見る
    missing_name = [p for p in products if not p.get("product_name")]
    missing_ing = [p for p in active if not p.get("ingredients")]
    print(f"[2] 商品名欠落: {'OK なし' if not missing_name else f'NG {len(missing_name)}件'}")
    print(f"[3] 有効剤の成分欠落: {'OK なし' if not missing_ing else f'NG {len(missing_ing)}件 (例: {missing_ing[0]['product_name']})'}")
    print(f"    (失効剤 {len(cancelled)} 件は成分データが無いのが正常)")
    if missing_name:
        errors.append(f"商品名の無い剤 {len(missing_name)} 件")
    if missing_ing:
        errors.append(f"成分の無い有効剤 {len(missing_ing)} 件")
    if not cancelled:
        errors.append("失効剤が 0 件 (失効農薬一覧の読み込みに失敗した可能性。xlrd を確認)")

    # 検証3: RAC コード分布
    rac_codes = Counter()
    for p in products:
        for ing in p["ingredients"]:
            if ing.get("rac_code"):
                rac_codes[ing["rac_code"]] += 1
    print(f"[4] RACコード種類: {len(rac_codes)}")
    print(f"   Top 10: {rac_codes.most_common(10)}")

    # 検証4: 剤型分布
    forms = Counter(p["formulation"] for p in products)
    print(f"[5] 剤型種類: {len(forms)}")
    print(f"   Top 10: {forms.most_common(10)}")

    # 検証5: 適用部整合性
    total_app_rows = None
    if APPS.exists():
        with open(APPS, encoding="utf-8") as f:
            apps_data = json.load(f)
        app_map = apps_data.get("applications", {})
        reg_with_apps = sum(1 for p in products if str(p["reg_no"]) in app_map)
        total_app_rows = count_app_rows(apps_data, products)
        print(f"[6] 適用部: {reg_with_apps}/{len(products)} 商品 ({total_app_rows} エントリ)")
        if total_app_rows == 0:
            errors.append("適用行が 0 件")
    else:
        errors.append("applications.json が無い")

    # 検証6: 混合剤の割合
    mix = sum(1 for p in products if len(p["ingredients"]) >= 2)
    print(f"[7] 混合剤: {mix} ({mix/len(products)*100:.1f}%)")

    # 検証7: RAC なし成分サンプル
    unmatched_ings = []
    for p in products:
        for ing in p["ingredients"]:
            if ing.get("rac_code") is None:
                unmatched_ings.append(ing["name"])
    unmatched_c = Counter(unmatched_ings)
    print(f"[8] RAC未分類の成分種類: {len(unmatched_c)}")
    if unmatched_c:
        print(f"   サンプル: {unmatched_c.most_common(5)}")

    # 検証8: 前回のコミットからの件数の急減 (FAMIC 側の形式変更などで取り込みが崩れたときに止める)
    prev_db = load_previous("src/data/pesticides.json")
    if prev_db is None:
        print("[9] 前回のコミットとの比較: 前回のデータを読めないため省略")
    else:
        prev_active = [p for p in prev_db["products"] if p.get("status") != "失効"]
        line = f"[9] 前回のコミットとの比較: 有効剤 {len(prev_active)} → {len(active)}"
        if len(active) < len(prev_active) * MIN_RATIO_TO_PREVIOUS:
            errors.append(f"有効剤が前回 {len(prev_active)} 件から {len(active)} 件に減った")
        prev_apps = load_previous("src/data/applications.json")
        if prev_apps is not None and total_app_rows is not None:
            prev_rows = count_app_rows(prev_apps, prev_db["products"])
            line += f" / 適用行 {prev_rows} → {total_app_rows}"
            if total_app_rows < prev_rows * MIN_RATIO_TO_PREVIOUS:
                errors.append(f"適用行が前回 {prev_rows} 行から {total_app_rows} 行に減った")
        print(line)

    print()
    if errors:
        for e in errors:
            print(f"NG {e}")
        sys.exit(1)
    print("OK 検証完了")


if __name__ == "__main__":
    main()
