# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

FAMIC の農薬登録情報 (現行登録 + 失効農薬) と CropLife Japan の RAC コード表を統合し、商品名・成分名・作物・病害虫・IRAC/FRAC/HRAC コードで検索する静的ブラウザアプリ。npm やバンドラは使わず、Python スクリプトで JSON を生成し、単一 HTML に埋め込んで配布する。配布形態は 3 つ: 単一 HTML (`build/これをクリック.html`)、GitHub Pages の PWA (`docs/`)、iOS アプリ (`ios/`、WKWebView で同梱 HTML を表示するだけのラッパー)。

ユーザー向けの説明は `使い方.md`、変更履歴は `更新履歴.md`。`データ更新.bat` は CP932 で書かれているため、UTF-8 として編集しない。

## コマンド

```bash
# データ更新 (FAMIC / 失効農薬 / CropLife を取得 → build_data → verify → check_rac → build_bundled)
python3 scripts/update_data.py

# 個別ステップ
python3 scripts/build_data.py          # rawdata/ → src/data/pesticides.json, applications.json
python3 scripts/verify_data.py         # 統計・整合性レポート (失敗しても止めない)
python3 scripts/check_rac_status.py    # RAC 表の版・未分類成分を確認 (--strict で警告時 exit 1, --offline)
python3 scripts/build_crop_groups.py   # 作物分類表 PDF → src/js/core/crop_groups.js (分類表の改正時だけ手動で実行。要 pdfplumber)

# ビルド (必ずこの順。build_pwa は build/これをクリック.html を入力にする)
python3 build/build_bundled.py         # src/ を 1 ファイルにインライン化 → build/これをクリック.html
python3 build/build_pwa.py             # → docs/ (index.html, sw.js, manifest, アイコン)。--regen-icons でアイコン再生成 (要 CJK フォント)

# テスト (検索ロジックの回帰テスト。1 件でも失敗で exit 1、CI の品質ゲート)
node scripts/test_search.mjs

# 開発サーバ (file:// では fetch が失敗するため HTTP 経由)
cd src && python3 -m http.server 8765

# iOS: 最新の build/これをクリック.html を ios/App/Resources/ にコピーして実機に再インストール
# (Git 管理外のローカルスクリプト。clone した環境には無い)
ios/rebuild_install.sh
```

テストに単体実行の仕組みは無い。1 ケースだけ確かめたいときは、`test_search.mjs` と同じように `src/js/core/*.js` を import する小さなスクリプトを書いて実行する。`app.js` は DOM に依存するため Node から import できない。

依存: Python 3 (`openpyxl`, `pillow`, `xlrd`。`build_crop_groups.py` だけ `pdfplumber`)、Node。`xlrd` が無いと失効農薬の `.xls` は警告 1 行だけでスキップされ、`pesticides.json` が現行剤だけに縮む。

## アーキテクチャ

### データの流れ

`scripts/update_data.py` は FAMIC の index ページの HTML から最新 zip の URL を抜き出して取得する。そのため、FAMIC 側のページ構成が変わると壊れる。`build_data.py` が生成するものは次の 2 つ。

- `src/data/pesticides.json`: `products[]`。**有効剤が先、失効剤が後**に並ぶ (結果は 500 グループで打ち切るので、この順序に依存している)。失効剤は `ingredients` が空で適用情報も無く、`expire_date` / `expire_reason` を持つ。
- `src/data/applications.json`: `applications[登録番号の文字列] = [{crop, place, pest, dosage, spray, timing, count, method}]`。有効剤のみ。

RAC コードは CropLife の表を優先し、表に無い成分は `rawdata/rac_manual.json` で補う (`rac_code` か、`rac_status` = `out_of_scope` / `legacy` / `recent`)。`rac_code` は `"UN(I*), M2(F*)"` のような複合表記を含み、`normalize.js` の `splitRacCode` が IRAC/FRAC/HRAC に振り分ける。

生成物 (`src/data/*.json`、`src/js/core/crop_groups.js`、`build/これをクリック.html`、`docs/*`、`ios/App/Resources/これをクリック.html`) は手で編集しない。ソースを直して再生成する。

### バンドルの制約

`build/build_bundled.py` は、ES module の `import` / `export` を正規表現で取り除き、`JS_ORDER` の順に 1 つのスコープへ連結する。そのため:

- モジュールを追加したら `JS_ORDER` に依存順で加える。
- トップレベルの名前はモジュールをまたいで重複させない (連結後に衝突する)。
- import は `import { ... } from "..."` の 1 文形式で書く。

データは、バンドル版では `window.PESTICIDES_DB` / `window.APPLICATIONS` に埋め込まれる。開発版では `fetch("data/...")` で読む。`app.js` と `io/applications.js` は両方に対応している。

### 検索の流れ (`src/js/core/` と `app.js`)

1. `normalize()`: NFKC → ひらがなをカタカナに → 大文字化 → 空白除去。同義語辞書や読み仮名変換は無い (作物の別名だけは下記の対応表にある)。
2. `buildIndex()`: 商品ごとに正規化済みの各欄と、適用行ごとの `{crop, pest, members}` (`app_entries`) を持つ。コーパス全体の語彙 (`index.lexicon`) も作る。作物名の `(…を除く)` は `expandSearchableCrops` が括弧の前 (「、ただし、」の前の条件は残す) だけを残す。「うり類(漬物用)(しろうり、とうがんを除く)」のように括弧が並ぶ場合は、除外の括弧だけを取り除く (`parseCropName` / `topLevelGroups`)。
   - `applicationCropMembers` が、作物欄で引ける語の Set を `members` / `crop_members` に持たせる。作物群 (「非結球あぶらな科葉菜類」「野菜類(施設栽培)」など) なら `cropGroupMembers` が所属作物とその別名を、作物群でない作物 (「みずな」「かんしょ」など) なら `cropAliasSet` がその作物の別名を返す (`crop_groups.js` が出典。除外とその別名は除く)。members は**完全一致**で照合し、作物欄の文字列は従来どおり部分一致。作物欄を照合する箇所 (`search.js`、`filter.js`、`filterApplications`) はすべて両方を見る。
   - 語彙は 3 つに分ける: `cropWords` (作物欄に実際に書かれた作物名だけ)、`virtualCropWords` (所属作物・別名)、`pestWords`。病害虫名を括弧の外の「、・」で区切った各語は `pestHeads` に持つ。
3. `search()`: 空白で分割し、`IRAC` / `FRAC` / `HRAC` 単独の語は直後の語の系統指定として扱う。
   - AND では、作物の語と病害虫の語の組が**同じ適用行**に共起することを要求する。語の役割は語彙で判定する。
   - `cropFlags`: 病害虫名の頭にも現れる語 (「アザミ」→ アザミウマ類、「クロウリ」→ クロウリハムシ。`cropWords` と完全一致する語は除く) は、作物の指定 (`scope.crop`、または AND で他の語が作物と確定する) があれば作物欄と一切一致させない (members とも、作物名の部分一致とも)。作物の指定が無ければ作物としても一致させる。所属作物・別名を `cropWords` に混ぜると「なす アザミ」が作物 2 語と判定され、1.7.0 でこの回帰が起きた。
   - サイドバーの作物・病害虫 (`scope`) を指定すると、検索語の病害虫や作物もその指定と同じ適用行で成立しなければならない。
4. `applyFilters()`: 用途、登録状態 (既定は有効・失効の両方)、家庭向けの除外、屋号付きの除外 (既定 ON)、剤型、混合剤、サイドバーの作物×病害虫の共起。
5. `app.js` の `groupByTypeAndIngredients()`: 種類名と成分構成 (成分名 + 濃度) でカードにまとめる。

`app.js` は、`attachCropsPests` (`_crops_norm` / `_crop_members` / `_app_pairs`) と `attachBrandedFlags` (`_branded`、同じ種類名・同じ成分構成の中で他商品名を末尾に含む商品) で、商品オブジェクトに派生欄を付ける。`filter.js` はこれらの欄を前提にしている。テストでフィルタを再現するときは、この付与処理も再現する必要がある。

詳細の適用表は `buildRowCondition` / `filterApplications` で、指定した作物・病害虫の行だけに絞って表示する。

検索対象は商品名・成分名・会社名・種類名・作物・病害虫・RAC コードだけで、**登録番号 (`reg_no`) は検索対象に入っていない**。`test_search.mjs` の登録番号ケースは `expectSomeMatch: "maybe"` で、結果にかかわらず合格になる。

## CI と公開

`.github/workflows/update-data.yml` が毎週月曜 03:00 JST と手動実行で動く。手順は `update_data.py` → `test_search.mjs` → `build_pwa.py`。差分があれば `famic-data-bot` が main へ直接 push し、GitHub Pages が `docs/` を配信する。PWA の Service Worker は HTML を network-first で取得し、キャッシュ名に `VERSION` を埋め込む。

## リリースとコミット

- バージョンの正本は `VERSION`。`sw.js` はビルド時に `VERSION` から生成される。ただし手書きの表記も合わせて更新する: `src/index.html` (2 箇所)、`更新履歴.md`、`docs/manual.html`、`スマホ版_使い方.html`、`ios/README.md`。その後 `build_bundled.py` → `build_pwa.py` の順で再生成する。
- `.git/hooks/commit-msg` は Conventional Commits 形式 (`feat|fix|docs|chore|...(scope): ...`) を強制する。
- `.git/hooks/pre-commit` は 5MB を超えるファイルと、秘密情報らしき文字列を拒否する。サイズの例外は、毎回コミットする生成物 (`docs/index.html`、`src/data/*.json`、`build/これをクリック.html`、`ios/App/Resources/これをクリック.html`) だけなので、リリースのコミットに `--no-verify` は要らない。フックは `.git/hooks/` にあるローカルのもので、Git 管理外 (clone した環境には無い)。1.7.1 までのフックは、Git が日本語のファイル名を引用符付きの 8 進エスケープで渡すため (`core.quotepath` が既定のまま)、日本語名のファイルのサイズ検査を素通りしていた。今は `git -c core.quotepath=false` で名前を受け取り、1 行ずつ `read` で回している。
