#!/usr/bin/env python3
"""
FAMIC + CropLife Japan + 失効農薬の最新データを取得し、JSON を再生成し、
シングル HTML をリビルドする。

- FAMIC index ページを取得 → 3本の zip URL を自動抽出
- zip を rawdata/ にダウンロード → rawdata/famic/ に展開（stdlib zipfile）
- 失効農薬 index ページを取得 → 2本の zip URL を自動抽出
- zip を rawdata/ にダウンロード → rawdata/sikkou/ に展開（stdlib zipfile）
- CropLife RAC xlsx を rawdata/mechanism_rac.xlsx にダウンロード
- build_data.py → verify_data.py → build_bundled.py を順に実行

依存: Python 3.8+、openpyxl（build_data.py が要求）
         → 無ければ自動で pip install を提案

Windows / macOS / Linux いずれでも動作します。外部コマンド (curl, unzip) は
使いません。
"""

import re
import shutil
import subprocess
import sys
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = PROJECT_ROOT / "rawdata"
FAMIC_DIR = RAW_DIR / "famic"
SIKKOU_DIR = RAW_DIR / "sikkou"
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
BUILD_DIR = PROJECT_ROOT / "build"

FAMIC_INDEX_URL = "https://www.acis.famic.go.jp/ddata/index2.htm"
FAMIC_BASE_URL = "https://www.acis.famic.go.jp/ddata/"
TOROKU_INDEX_URL = "https://www.acis.famic.go.jp/toroku/index.htm"
TOROKU_BASE_URL = "https://www.acis.famic.go.jp/toroku/"
CROPLIFE_RAC_URL = (
    "https://www.croplifejapan.org/assets/file/labo/mechanism/mechanism_rac.xlsx"
)

USER_AGENT = "browser-pesticide-search-updater/1.0 (+https://github.com/)"


def log(msg: str) -> None:
    print(msg, flush=True)


def http_get(url: str, binary: bool = False):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    if binary:
        return data
    # FAMIC index ページは Shift_JIS
    for enc in ("utf-8", "shift_jis", "cp932"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def discover_famic_zips() -> dict:
    """FAMIC index ページから 3 本の zip URL を抽出。

    Returns:
        {'basic': url, 'app1': url, 'app2': url}
    末尾1桁 (0/1/2) で識別。
    """
    log(f"[1/7] FAMIC index を取得: {FAMIC_INDEX_URL}")
    html = http_get(FAMIC_INDEX_URL)
    matches = re.findall(r'datacsv/(R\d+[012])\.zip', html)
    if not matches:
        sys.exit("ERROR: FAMIC index から zip URL を抽出できませんでした。URL 構造が変わった可能性があります。")
    by_suffix = {}
    for name in matches:
        by_suffix[name[-1]] = name  # 末尾1桁
    required = {"0": "basic", "1": "app1", "2": "app2"}
    result = {}
    for digit, label in required.items():
        if digit not in by_suffix:
            sys.exit(f"ERROR: FAMIC index から suffix {digit} の zip が見つかりません。")
        result[label] = FAMIC_BASE_URL + "datacsv/" + by_suffix[digit] + ".zip"
    return result


def discover_sikkou_zips() -> dict:
    """失効農薬 index ページから 2 本の zip URL を抽出。

    Returns:
        {'nouyaku': url, 'seibun': url}
    """
    log(f"[3/7] 失効農薬 index を取得: {TOROKU_INDEX_URL}")
    html = http_get(TOROKU_INDEX_URL)
    result = {}
    for label, pattern in (
        ("nouyaku", r"sikkounouyaku_\d{8}\.zip"),
        ("seibun", r"sikkouseibun_\d{8}\.zip"),
    ):
        m = re.search(pattern, html)
        if not m:
            sys.exit(
                f"ERROR: 失効農薬 index から {label} の zip URL を抽出できませんでした。"
                f"URL 構造が変わった可能性があります。"
            )
        result[label] = TOROKU_BASE_URL + m.group(0)
    return result


def clean_old_sikkou_xls() -> None:
    """古い失効農薬 .xls を削除（ファイル名の日付が更新ごとに変わるので残骸が溜まるのを防ぐ）。"""
    if not SIKKOU_DIR.exists():
        return
    for old in SIKKOU_DIR.glob("sikkou*.xls"):
        old.unlink()


def download(url: str, dest: Path) -> None:
    log(f"    取得中: {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        data = http_get(url, binary=True)
    except urllib.error.URLError as e:
        sys.exit(f"ERROR: ダウンロード失敗: {url}\n        {e}")
    dest.write_bytes(data)
    log(f"    保存: {dest.relative_to(PROJECT_ROOT)} ({len(data):,} bytes)")


def clean_old_famic_csvs() -> None:
    """古い CSV を削除（ファイル名が月によって変わるので残骸が溜まるのを防ぐ）。"""
    if not FAMIC_DIR.exists():
        return
    for old in FAMIC_DIR.glob("R*.csv"):
        old.unlink()


def extract_zip(zip_path: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest_dir)


def run_step(step_no: int, total: int, desc: str, cmd: list) -> None:
    log(f"[{step_no}/{total}] {desc}")
    log(f"    $ {' '.join(str(c) for c in cmd)}")
    result = subprocess.run(cmd, cwd=PROJECT_ROOT)
    if result.returncode != 0:
        sys.exit(f"ERROR: {desc} が失敗しました (exit {result.returncode})")


def ensure_openpyxl() -> None:
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        log("openpyxl が未インストール。pip install を試みます...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "openpyxl"])


def main() -> int:
    log("=" * 60)
    log("browser-pesticide-search データ更新")
    log("=" * 60)

    ensure_openpyxl()

    urls = discover_famic_zips()
    log(f"    basic: {urls['basic']}")
    log(f"    app1 : {urls['app1']}")
    log(f"    app2 : {urls['app2']}")

    log("[2/7] FAMIC zip をダウンロード・展開")
    clean_old_famic_csvs()
    for label, url in urls.items():
        zip_path = RAW_DIR / f"famic_{label}.zip"
        download(url, zip_path)
        extract_zip(zip_path, FAMIC_DIR)
        zip_path.unlink()  # 展開後は削除

    sikkou_urls = discover_sikkou_zips()
    log(f"    nouyaku: {sikkou_urls['nouyaku']}")
    log(f"    seibun : {sikkou_urls['seibun']}")

    log("[4/7] 失効農薬 zip をダウンロード・展開")
    clean_old_sikkou_xls()
    for label, url in sikkou_urls.items():
        zip_path = RAW_DIR / f"sikkou_{label}.zip"
        download(url, zip_path)
        extract_zip(zip_path, SIKKOU_DIR)
        zip_path.unlink()  # 展開後は削除

    log("[5/7] CropLife RAC xlsx をダウンロード")
    download(CROPLIFE_RAC_URL, RAW_DIR / "mechanism_rac.xlsx")

    run_step(6, 7, "JSON 生成 (build_data.py)",
             [sys.executable, str(SCRIPTS_DIR / "build_data.py")])

    # verify_data.py は情報出力のみで失敗させない（アラートあっても続行）
    log("[6.5/7] データ検証 (verify_data.py)")
    subprocess.run([sys.executable, str(SCRIPTS_DIR / "verify_data.py")],
                   cwd=PROJECT_ROOT)

    run_step(7, 7, "シングルHTML 再生成 (build_bundled.py)",
             [sys.executable, str(BUILD_DIR / "build_bundled.py")])

    bundled = BUILD_DIR / "pesticide_search_bundled.html"
    if bundled.exists():
        size_mb = bundled.stat().st_size / 1024 / 1024
        log("")
        log("=" * 60)
        log(f"完了: {bundled.relative_to(PROJECT_ROOT)} ({size_mb:.1f} MB)")
        log("=" * 60)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("\n中断されました")
        sys.exit(130)
