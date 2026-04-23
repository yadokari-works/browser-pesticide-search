@echo off
chcp 65001 >nul
setlocal
set "PYTHONIOENCODING=utf-8"

rem ==============================================================
rem  browser-pesticide-search - Windows データ更新ランチャー
rem  ダブルクリックで scripts\update_data.py を実行します。
rem ==============================================================

cd /d "%~dp0"

rem Python を検出: py ランチャー → python → python3 の順
set "PYTHON="
where py >nul 2>&1 && set "PYTHON=py -3"
if "%PYTHON%"=="" where python >nul 2>&1 && set "PYTHON=python"
if "%PYTHON%"=="" where python3 >nul 2>&1 && set "PYTHON=python3"

if "%PYTHON%"=="" (
    echo.
    echo [エラー] Python 3 が見つかりません。
    echo.
    echo 以下のいずれかから Python 3 をインストールしてください:
    echo   - Microsoft Store で "Python 3" を検索
    echo   - https://www.python.org/downloads/windows/
    echo.
    echo インストール時は "Add Python to PATH" にチェックを入れてください。
    echo.
    pause
    exit /b 1
)

echo Python: %PYTHON%
echo.

%PYTHON% "%~dp0scripts\update_data.py"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo ============================================================
    echo  完了。build\pesticide_search_bundled.html を開いて下さい。
    echo ============================================================
) else (
    echo ============================================================
    echo  エラーで終了しました (exit code %RC%)
    echo ============================================================
)
pause
exit /b %RC%
