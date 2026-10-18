#!/bin/bash
# ==============================================================
#  macOS の定期実行 (launchd) から呼ばれ、データ更新 (update_data.py) を行う。
#  install_auto_update_mac.sh が ~/Library/Application Support/browser-pesticide-search/ に
#  コピーして使う (外付けドライブ上のスクリプトは、launchd からは読めないことがあるため)。
#
#  使い方: auto_update_mac.sh <リポジトリのパス> <python3 のパス>
#  - 毎日呼ばれ、前回の成功から 7 日たっていなければ何もしない (Mac が止まっていた週も取りこぼさない)
#  - main 以外のブランチや、生成物以外に未コミットの変更があるときは見送る (開発中の src/ からバンドルしない)
#  - 失敗したら src/data/*.json を実行前に戻し、通知を出す。結果は ~/Library/Logs/browser-pesticide-search/
# ==============================================================
set -u

REPO="${1:?リポジトリのパスを指定}"
PY="${2:?python3 のパスを指定}"
STATE_DIR="$HOME/Library/Application Support/browser-pesticide-search"
LOG_DIR="$HOME/Library/Logs/browser-pesticide-search"
HISTORY="$LOG_DIR/history.log"   # 1 回 1 行の結果
LAST_LOG="$LOG_DIR/last_run.log" # 直近の update_data.py の出力
STAMP="$STATE_DIR/last_success"
FORCE_FLAG="$STATE_DIR/force"    # install_auto_update_mac.sh run が置く (間隔を無視して今すぐ実行)
INTERVAL_SEC=$((7 * 24 * 3600 - 3600))
# 自動更新で書き換わる生成物。これ以外に未コミットの変更があれば見送る
GENERATED='^.. (src/data/pesticides\.json|src/data/applications\.json|build/これをクリック\.html)$'

mkdir -p "$STATE_DIR" "$LOG_DIR"

now() { date "+%Y-%m-%d %H:%M:%S"; }
notify() {  # 本文に " を含めない
  /usr/bin/osascript -e "display notification \"$1\" with title \"農薬簡易検索 データ自動更新\"" >/dev/null 2>&1 || true
}
record() { echo "$(now) $1" >> "$HISTORY"; }
fail() { record "失敗: $1"; notify "失敗: $1"; exit 1; }
skip() { record "見送り: $1"; notify "見送り: $1"; exit 0; }

# 間隔の確認 (強制実行の印があれば無視する)
if [ -e "$FORCE_FLAG" ]; then
  rm -f "$FORCE_FLAG"
elif [ -f "$STAMP" ]; then
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - ${last:-0} )) -lt "$INTERVAL_SEC" ]; then
    exit 0
  fi
fi

# 二重起動の防止
LOCK="$STATE_DIR/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  record "見送り: 前回の実行が終わっていない (残っていれば $LOCK を消す)"
  exit 0
fi
BACKUP=""
cleanup() { rmdir "$LOCK" 2>/dev/null; [ -n "$BACKUP" ] && rm -rf "$BACKUP"; }
trap cleanup EXIT

# 外付けドライブ: 存在は分かっても、権限が無いと中身を読めない (存在の判定だけでは成功にしない)
if [ ! -e "$REPO" ]; then
  fail "フォルダが見つからない。SSD が接続されているか確認してください ($REPO)"
fi
if ! head -c 1 "$REPO/VERSION" >/dev/null 2>&1; then
  fail "SSD のファイルを読めない。システム設定のフルディスクアクセスに /bin/bash を加えてください"
fi

# 開発中なら見送る
branch=$(/usr/bin/git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null) || fail "git でリポジトリを読めない ($REPO)"
if [ "$branch" != "main" ]; then
  skip "ブランチ $branch で作業中のため。main に戻すと次の実行で更新します"
fi
dirty=$(/usr/bin/git -C "$REPO" -c core.quotepath=false status --porcelain --untracked-files=no | grep -Ev "$GENERATED")
if [ -n "$dirty" ]; then
  skip "生成物以外に未コミットの変更があるため ($(echo "$dirty" | head -1 | sed 's/^...//'))"
fi

# 失敗したときに戻せるよう、今の JSON を控える
BACKUP=$(mktemp -d "${TMPDIR:-/tmp}/pesticide-auto-update.XXXXXX") || fail "一時フォルダを作れない"
cp "$REPO/src/data/pesticides.json" "$REPO/src/data/applications.json" "$BACKUP/" || fail "src/data の控えを取れない"
famic_of() {
  "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); print(d.get("sources",{}).get("famic",""), d.get("stats",{}).get("active",""))' "$1" 2>/dev/null
}
before=$(famic_of "$BACKUP/pesticides.json")

started=$(date +%s)
(cd "$REPO" && "$PY" scripts/update_data.py) > "$LAST_LOG" 2>&1 < /dev/null
rc=$?
if [ "$rc" -ne 0 ]; then
  cp "$BACKUP/pesticides.json" "$BACKUP/applications.json" "$REPO/src/data/" 2>/dev/null
  fail "update_data.py が終了コード $rc で止まった。src/data は実行前に戻した。ログ: $LAST_LOG"
fi

# 成功は肯定的な証拠で判定する: 配布 HTML が今回書き直されていること
html="$REPO/build/これをクリック.html"
mtime=$(stat -f %m "$html" 2>/dev/null || echo 0)
if [ "$mtime" -lt "$started" ]; then
  fail "update_data.py は終わったが build/これをクリック.html が更新されていない。ログ: $LAST_LOG"
fi
after=$(famic_of "$REPO/src/data/pesticides.json")
date +%s > "$STAMP"
size=$(( $(stat -f %z "$html") / 1000000 ))
record "成功: FAMIC ${after% *} 版 / 有効剤 ${after#* } 件 / これをクリック.html ${size} MB (前回 ${before% *} 版)"
if [ "$before" != "$after" ]; then
  notify "新しいデータに更新しました (FAMIC ${after% *} 版)"
fi
exit 0
