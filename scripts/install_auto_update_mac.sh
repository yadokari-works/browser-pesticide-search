#!/bin/bash
# ==============================================================
#  パソコン版 (build/これをクリック.html) のデータを、この Mac で自動更新する設定 (launchd)。
#  毎日 12:00 に確認し、前回の成功から 7 日たっていれば update_data.py を実行する
#  (Mac が眠っていた時刻の分は、起きたときに実行される)。
#
#  使い方: scripts/install_auto_update_mac.sh install | uninstall | status | run
#    install   登録する (やり直しも同じ。auto_update_mac.sh を直したら再実行する)
#    uninstall 登録を外す (ログは残す)
#    status    登録の状態と、直近の結果を表示する
#    run       今すぐ 1 回実行する (7 日の間隔を無視する)。結果は status で見る
#
#  リポジトリが外付けドライブにある場合、launchd から起動したプログラムはそのままでは
#  ドライブを読めない (macOS のプライバシー保護)。システム設定 → プライバシーとセキュリティ →
#  フルディスクアクセス に /bin/bash を加える必要がある。
# ==============================================================
set -eu

LABEL="io.github.yadokari-works.browser-pesticide-search.update"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/Library/Application Support/browser-pesticide-search"
LOG_DIR="$HOME/Library/Logs/browser-pesticide-search"
RUNNER="$STATE_DIR/auto_update.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<< "$1"; }

case "${1:-}" in
  install)
    PY="$(command -v python3 || true)"
    if [ -z "$PY" ]; then
      echo "[エラー] python3 が見つかりません" >&2; exit 1
    fi
    if ! "$PY" -c "import openpyxl, xlrd, PIL" 2>/dev/null; then
      echo "[エラー] $PY に openpyxl・xlrd・pillow がありません: $PY -m pip install openpyxl xlrd pillow" >&2; exit 1
    fi
    mkdir -p "$STATE_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
    install -m 755 "$REPO/scripts/auto_update_mac.sh" "$RUNNER"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml_escape "$RUNNER")</string>
    <string>$(xml_escape "$REPO")</string>
    <string>$(xml_escape "$PY")</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PYTHONUTF8</key><string>1</string>
    <key>LANG</key><string>ja_JP.UTF-8</string>
  </dict>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_DIR/launchd.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_DIR/launchd.log")</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "登録しました: $LABEL"
    echo "  リポジトリ: $REPO"
    echo "  python3   : $PY"
    echo "  実行役    : $RUNNER"
    echo "  結果      : $LOG_DIR/history.log"
    case "$REPO" in
      /Volumes/*)
        echo
        echo "リポジトリが外付けドライブにあります。システム設定 → プライバシーとセキュリティ →"
        echo "フルディスクアクセス に /bin/bash を加えてください (Finder で Cmd+Shift+G → /bin/bash)。"
        echo "加えた後、$0 run で 1 回実行し、$0 status で「成功」を確かめてください。" ;;
    esac
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST" "$RUNNER"
    echo "登録を外しました (ログは $LOG_DIR に残っています)"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "登録: あり ($PLIST)"
      launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|last exit code|runs) =' || true
    else
      echo "登録: なし"
    fi
    if [ -f "$STATE_DIR/last_success" ]; then
      echo "前回の成功: $(date -r "$(cat "$STATE_DIR/last_success")" '+%Y-%m-%d %H:%M')"
    fi
    echo "--- 直近の結果 ($LOG_DIR/history.log)"
    tail -n 5 "$LOG_DIR/history.log" 2>/dev/null || echo "(まだ実行していません)"
    ;;
  run)
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { echo "[エラー] 未登録です。先に install" >&2; exit 1; }
    mkdir -p "$STATE_DIR"
    touch "$STATE_DIR/force"
    launchctl kickstart "$DOMAIN/$LABEL"
    echo "実行を始めました (数分かかります)。終わったら $0 status で結果を確かめてください"
    ;;
  *)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
