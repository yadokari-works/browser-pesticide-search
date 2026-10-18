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
python3 scripts/build_data.py          # rawdata/ → src/data/pesticides.json, applications.json (失効農薬一覧を読めないと止まる。--allow-no-cancelled で続行)
python3 scripts/verify_data.py         # 統計・整合性の検査 (登録番号の重複、成分の無い有効剤、失効剤 0 件、前回のコミットから 10% 以上の件数の急減で exit 1)
python3 scripts/check_rac_status.py    # RAC 表の版・未分類成分を確認 (--strict で警告時 exit 1, --offline, --prev-edition 前回の版)
python3 scripts/build_crop_groups.py   # 作物分類表 PDF → src/js/core/crop_groups.js (分類表の改正時だけ手動で実行。要 pdfplumber)

# ビルド (必ずこの順。build_pwa は build/これをクリック.html を入力にする)
python3 build/build_bundled.py         # src/ を 1 ファイルにインライン化 → build/これをクリック.html
python3 build/build_pwa.py             # → docs/ (index.html, sw.js, manifest, アイコン)。--regen-icons でアイコン再生成 (要 CJK フォント)

# テスト (検索ロジックの回帰テスト。1 件でも失敗で exit 1、CI の品質ゲート)
node scripts/test_search.mjs
# 配布物の検査 (build/これをクリック.html と docs/index.html の script の構文、埋め込んだデータが src/data と同じか、版の表記)
node scripts/check_bundle.mjs

# 開発サーバ (file:// では fetch が失敗するため HTTP 経由)
cd src && python3 -m http.server 8765

# iOS: 最新の build/これをクリック.html を ios/App/Resources/ にコピーして実機に再インストール
# (Git 管理外のローカルスクリプト。clone した環境には無い)
ios/rebuild_install.sh
```

テストに単体実行の仕組みは無い。1 ケースだけ確かめたいときは、`test_search.mjs` と同じように `src/js/core/*.js` を import する小さなスクリプトを書いて実行する。`app.js` は DOM に依存するため Node から import できない。

依存: Python 3 (`openpyxl`, `pillow`, `xlrd`。`build_crop_groups.py` だけ `pdfplumber`)、Node。`xlrd` が無いか失効農薬の `.xls` が無いと、`build_data.py` はエラーで止まる (`pesticides.json` が現行剤だけに縮むのを防ぐため)。失効剤なしで作るときだけ `--allow-no-cancelled` を付ける。

## アーキテクチャ

### データの流れ

`scripts/update_data.py` は FAMIC の index ページの HTML から最新 zip の URL を抜き出して取得する。そのため、FAMIC 側のページ構成が変わると壊れる。`build_data.py` が生成するものは次の 2 つ。

- `src/data/pesticides.json`: `products[]`。**有効剤が先、失効剤が後**に並ぶ (結果は 500 グループで打ち切るので、この順序に依存している)。失効剤は `ingredients` が空で適用情報も無く、`expire_date` / `expire_reason` を持つ。失効農薬の成分ファイル (`sikkouseibun_*.xls`) は登録番号の列が無い「失効有効成分一覧」なので、商品の成分には使えない。
  - 用途が殺虫・殺菌・除草のどれでもない剤は捨てる。ただし用途「農薬肥料」は、成分が用途 1 つだけの現行剤で使われている用途から推定して取り込む (`infer_categories_from_ingredients`。`original_category` は「農薬肥料」のまま。成分が植調剤のウニコナゾールP だけの剤は推定できず捨てる)。用途「その他」は取り込まない。
  - `formulation` は FAMIC の剤型名 (乳剤・液剤・くん蒸剤など) を使い、商品名の末尾でフロアブル剤・ジャンボ剤・ベイト剤を分ける。
  - `total_usage_names`: 適用部の「有効成分①〜⑤を含む農薬の総使用回数」の①〜⑤が指す成分名 (基本部の成分の行の順)。
- `src/data/applications.json`: `applications[登録番号の文字列] = [{crop, place, pest, purpose, dosage, spray, timing, count, method, fumi_time, fumi_temp, soil, zone, totals}]`。有効剤のみ。**空の項目は書き出さない** (読む側は `a.place` などが無い前提で書く)。`totals` は成分ごとの総使用回数の配列で、どの成分も本剤の使用回数と同じ行では省き、総使用回数が無い行は `[]` にする (`app.js` の `totalUsageHtml` がこの約束で表示する)。

RAC コードは CropLife の表を優先し、表に無い成分は `rawdata/rac_manual.json` で補う (`rac_code` か、`rac_status` = `out_of_scope` / `legacy` / `recent`)。成分名での名寄せは完全一致と、塩・水和物の語尾を除いた一致だけ (部分一致は使わない)。`rac_code` は `"UN(I*), M2(F*)"` のような複合表記を含み、`normalize.js` の `splitRacCode` が IRAC/FRAC/HRAC に振り分ける。印の無いコードは商品の用途すべてに振り分けるので、用途が 2 つ以上の剤 (殺虫殺菌剤など) では `tag_rac_systems` が、用途 1 つの現行剤での成分の用途から系統の印を付ける (タネサンGT のダイアジノン → `1B(I*)`)。

生成物 (`src/data/*.json`、`src/js/core/crop_groups.js`、`build/これをクリック.html`、`docs/*`、`ios/App/Resources/これをクリック.html`) は手で編集しない。ソースを直して再生成する。

### バンドルの制約

`build/build_bundled.py` は、ES module の `import` / `export` を正規表現で取り除き、`JS_ORDER` の順に 1 つのスコープへ連結する。そのため:

- モジュールを追加したら `JS_ORDER` に依存順で加える。
- トップレベルの名前はモジュールをまたいで重複させない (連結後に衝突する)。
- import は `import { ... } from "..."` の 1 文形式で書く。

データは、バンドル版では `window.PESTICIDES_DB` / `window.APPLICATIONS` に埋め込まれる。開発版では `fetch("data/...")` で読む。`app.js` と `io/applications.js` は両方に対応している。

### 検索の流れ (`src/js/core/` と `app.js`)

1. `normalize()`: NFKC → ひらがなをカタカナに → 大文字化 → 空白除去。同義語辞書や読み仮名変換は無い (作物の別名と、漢字の作物名の読み `CROP_READINGS` (ちゃ→茶、いね→稲 など) だけはある)。
2. `buildIndex()`: 商品ごとに正規化済みの各欄と、適用行ごとの `appEntry` (`app_entries`) を持つ。`appEntry` (normalize.js) は適用行の照合用の形を 1 か所で作り、検索・サイドバーの絞り込み・適用表の絞り込みが共用する。病害虫は `searchablePest` で「を除く」で終わる括弧を取り除いた名前で照合する (「一年生イネ科雑草(スズメノカタビラを除く)」は スズメノカタビラ に一致しない。表示は原文)。コーパス全体の語彙 (`index.lexicon`) も作る。作物名の `(…を除く)` は `expandSearchableCrops` が括弧の前 (「、ただし、」の前の条件は残す) だけを残す。「うり類(漬物用)(しろうり、とうがんを除く)」のように括弧が並ぶ場合は、除外の括弧だけを取り除く (`parseCropName` / `topLevelGroups`)。
   - `applicationCropMembers` が、作物欄で引ける語の Set を `members` / `crop_members` に持たせる。作物群 (「非結球あぶらな科葉菜類」「野菜類(施設栽培)」「きのこ類(…を除く)(菌床栽培)」など) なら `cropGroupMembers` が所属作物とその別名を、作物群でない作物 (「みずな」「かんしょ」など) なら `cropAliasSet` がその作物の別名を返す (`crop_groups.js` が出典。除外とその別名は除く)。members は**完全一致**で照合する。
   - 作物欄の作物名は `entryHasCrop` / `cropInfoMatches` で照合する。完全一致 (名前全体・括弧の前・「・」で並ぶ各語・括弧の中身、「類」を付けると一致する語) は一致。部分一致は、照合する文字列に「検索語を含む分類表の別の作物名」(`cropBlockers`) が現れないときだけ認める。分類表に無い作物名 (移植水稲) と、分類表が検索語に含める作物 (`cropRelatives`: なし → 日本なし、まつ → まつ類の所属作物、核果類 → 小粒核果類) には当たり、別の作物 (ちゃ → かぼちゃ、ねぎ → たまねぎ、トマト → ミニトマト) と括弧の中の栽培条件には当たらない。この規則は 2026-10-18 に利用者が「分類表の判断に全部従う」と決めた。作物欄を照合する箇所 (`search.js`、`filter.js`、`filterApplications`) はすべて `entryHasCrop` を使う。
   - 語彙は 3 つに分ける: `cropWords` (作物欄に実際に書かれた作物名だけ)、`virtualCropWords` (所属作物・別名)、`pestWords`。病害虫名を括弧の外の「、・」で区切った各語は `pestHeads` に持つ。
3. `search()`: 空白で分割し、`IRAC` / `FRAC` / `HRAC` 単独の語は直後の語の系統指定として扱う。
   - AND では、作物の語と病害虫の語の組が**同じ適用行**に共起することを要求する。語の役割は語彙で判定する。作物は作物欄 (所属作物・別名を含む) と病害虫欄の括弧の中、病害虫は病害虫欄で照合し、作物名を病害虫名そのもので照合しない (「なし シンクイ」が びわ×ナシヒメシンクイ で成立しない)。
   - 作物と確定した語 (`isCropToken`。読みを含む) は、2 語以上の AND では商品名・成分名などで成立させず作物欄で判定する (「ばら うどんこ病」が商品名 バラライカ で成立しない)。作物名・病害虫名の一部に当たる語が 2 つ以上ある AND では、それらの語も適用行で判定する (「らん アブラムシ」が オルトラン で、「キャベツ カメムシ」が成分 ナミヒメハナカメムシ で成立しない)。1 語だけの検索は商品名なども照合するが、作物と確定した語の作物側は作物欄だけで見る (AND と OR で同じ)。
   - RAC コードは完全一致か、直後が数字でない前方一致 (`racCodeMatches`。「1」は 1A・1B に当たり 11・14 に当たらない)。系統を検索語で明示した語 (「IRAC UN」「IRAC4A」) は RAC コードだけで判定し、ラジオで系統を選んだだけのときは商品名などとも照合する。
   - `cropFlags`: 病害虫名の頭にも現れる語 (「アザミ」→ アザミウマ類、「クロウリ」→ クロウリハムシ。`cropWords` と完全一致する語は除く) は、作物の指定 (`scope.crop`、または AND で他の語が作物と確定する) があれば作物欄と一切一致させない (members とも、作物名の部分一致とも)。作物の指定が無ければ作物としても一致させる。所属作物・別名を `cropWords` に混ぜると「なす アザミ」が作物 2 語と判定され、1.7.0 でこの回帰が起きた。
   - サイドバーの作物・病害虫 (`scope`) を指定すると、検索語の病害虫や作物もその指定と同じ適用行で成立しなければならない。
4. `applyFilters()`: 用途、登録状態 (既定は有効・失効の両方)、家庭向けの除外、屋号付きの除外 (既定 ON。同じグループの屋号の無い商品が結果に残るときだけ隠す)、剤型、混合剤、サイドバーの作物×病害虫の共起。
5. `app.js` の `groupByTypeAndIngredients()`: 種類名と成分構成 (成分名 + 濃度) でカードにまとめる。

`app.js` は、`attachCropsPests` (`buildIndex` の `norm_crops` / `crop_members` / `app_entries` を `_crops_norm` / `_crop_members` / `_app_pairs` として付ける) と、filter.js の `attachBrandedFlags` (`_branded`、同じ種類名・同じ成分構成の中で他商品名を末尾に含む商品。`_group` にグループのキー) で、商品オブジェクトに派生欄を付ける。`filter.js` はこれらの欄を前提にしている。テストでフィルタを再現するときは、この付与処理も再現する (`test_search.mjs` の冒頭)。

詳細の適用表は `buildRowCondition` / `filterApplications` で、指定した作物・病害虫の行だけに絞って表示する。列は `APP_COLUMNS` で、適用場所・散布液量・総使用回数・条件 (使用目的・適用地帯・適用土壌・くん蒸) は、表示する行のどれにも値 (「-」以外) が無ければ出さない。

検索対象は商品名・成分名・会社名・種類名・作物・病害虫・RAC コードだけで、**登録番号 (`reg_no`) は検索対象に入っていない**。`test_search.mjs` の登録番号ケースは `expectSomeMatch: "maybe"` で、結果にかかわらず合格になる。

## CI と公開

`.github/workflows/update-data.yml` が毎週月曜 03:00 JST と手動実行で動く。手順は `update_data.py` (中で `verify_data.py` が失敗すると止まる) → `test_search.mjs` → `build_pwa.py` → `check_bundle.mjs`。差分があれば `famic-data-bot` が main へ直接 push し、GitHub Pages が `docs/` を配信する。PWA の Service Worker は HTML を network-first で取得し (4 秒で応答が無ければキャッシュを返し、裏で更新する)、キャッシュ名に `VERSION` を埋め込む。古いキャッシュは `pesticide-search-` で始まるものだけ消す (同じ origin の PDF Tool などのキャッシュを消さないため)。

## リリースとコミット

- バージョンの正本は `VERSION`。`sw.js` はビルド時に `VERSION` から生成される。ただし手書きの表記も合わせて更新する: `src/index.html` (2 箇所)、`更新履歴.md`、`docs/manual.html`、`スマホ版_使い方.html`、`ios/README.md`。その後 `build_bundled.py` → `build_pwa.py` の順で再生成し、`node scripts/check_bundle.mjs` で確かめる。
- `.git/hooks/commit-msg` は Conventional Commits 形式 (`feat|fix|docs|chore|...(scope): ...`) を強制する。
- `.git/hooks/pre-commit` は 5MB を超えるファイルと、秘密情報らしき文字列を拒否する。サイズの例外は、毎回コミットする生成物 (`docs/index.html`、`src/data/*.json`、`build/これをクリック.html`、`ios/App/Resources/これをクリック.html`) だけなので、リリースのコミットに `--no-verify` は要らない。フックは `.git/hooks/` にあるローカルのもので、Git 管理外 (clone した環境には無い)。1.7.1 までのフックは、Git が日本語のファイル名を引用符付きの 8 進エスケープで渡すため (`core.quotepath` が既定のまま)、日本語名のファイルのサイズ検査を素通りしていた。今は `git -c core.quotepath=false` で名前を受け取り、1 行ずつ `read` で回している。
