#!/usr/bin/env python3
"""
生成された pesticides.json の整合性・統計をレポートする。
"""

import json
import sys
from pathlib import Path
from collections import Counter

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB = PROJECT_ROOT / "src" / "data" / "pesticides.json"
APPS = PROJECT_ROOT / "src" / "data" / "applications.json"


def main():
    if not DB.exists():
        sys.exit("ERROR: pesticides.json が無い。先に build_data.py を実行してください。")

    with open(DB, encoding="utf-8") as f:
        db = json.load(f)

    products = db["products"]
    stats = db["stats"]

    print(f"=== 農薬データベース検証 ===")
    print(f"Generated: {db['generated_at']}")
    print(f"Sources: {json.dumps(db['sources'], ensure_ascii=False)}")
    print()

    print(f"商品総数: {len(products)}")
    print(f"用途別: {stats['by_category']}")
    print(f"家庭向け除外: {stats['household_excluded_by_default']}")
    print(f"RAC マッチ: {stats['rac_matched']} ({stats['rac_match_rate']*100:.1f}%)")
    print()

    # 検証1: reg_no 重複チェック
    reg_nos = [p["reg_no"] for p in products]
    dup = [n for n, c in Counter(reg_nos).items() if c > 1]
    print(f"[1] 登録番号重複: {'OK なし' if not dup else f'NG あり: {dup[:5]}...'}")

    # 検証2: 必須フィールド
    missing_name = [p for p in products if not p.get("product_name")]
    missing_ing = [p for p in products if not p.get("ingredients")]
    print(f"[2] 商品名欠落: {'OK なし' if not missing_name else f'NG {len(missing_name)}件'}")
    print(f"[3] 成分欠落: {'OK なし' if not missing_ing else f'NG {len(missing_ing)}件'}")

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
    if APPS.exists():
        with open(APPS, encoding="utf-8") as f:
            apps_data = json.load(f)
        app_map = apps_data.get("applications", {})
        reg_with_apps = sum(1 for p in products if str(p["reg_no"]) in app_map)
        total_app_rows = sum(len(app_map.get(str(p["reg_no"]), [])) for p in products)
        print(f"[6] 適用部: {reg_with_apps}/{len(products)} 商品 ({total_app_rows} エントリ)")

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

    print()
    print("OK 検証完了")


if __name__ == "__main__":
    main()
