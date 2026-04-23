#!/bin/bash
# ==============================================================
#  browser-pesticide-search - macOS データ更新ランチャー
#  ダブルクリックで scripts/update_data.py を実行します。
# ==============================================================

cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
    echo
    echo "[エラー] python3 が見つかりません。"
    echo
    echo "Xcode Command Line Tools をインストールしてください:"
    echo "  $ xcode-select --install"
    echo "または Homebrew で:  brew install python"
    echo
    read -p "Enter キーで閉じる..."
    exit 1
fi

python3 scripts/update_data.py
RC=$?

echo
if [ "$RC" -eq 0 ]; then
    echo "============================================================"
    echo " 完了。build/pesticide_search_bundled.html を開いて下さい。"
    echo "============================================================"
else
    echo "============================================================"
    echo " エラーで終了しました (exit code $RC)"
    echo "============================================================"
fi

read -p "Enter キーで閉じる..."
exit $RC
