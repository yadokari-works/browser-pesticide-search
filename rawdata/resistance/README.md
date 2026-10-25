# 抵抗性・耐性のデータ (rawdata/resistance/)

`scripts/build_resistance.py` が、このフォルダの CSV から `src/data/resistance.json` を作る。
アプリはそれを使い、登録情報 (作物 × 病害虫 × 成分) と照合して、どの程度の抵抗性・耐性がどこで報告されているかを出す。

CSV は UTF-8 (BOM 付き) で、Excel では「CSV UTF-8 (コンマ区切り)」で保存する。1 行目の見出しは変えない。
編集したら `python3 scripts/build_resistance.py` を実行する。誤りがあれば、ファイル名と行番号を出して止まる。

## 決まりごと

- **確かめた行だけを入れる。** `taxa.csv`・`pest_map.csv`・`records.csv` の各行は、確認者 (`verified_by`) と
  確認日 (`verified_at`、`2026-10-22` の形) が無いとビルドが止まる。Claude が PDF などから作った下書きは
  `review/resistance-intake/` (Git 管理外) に置き、確かめてからここへ移す。確認者は、利用者が照合した行は「管理者」
  (公開リポジトリなので個人名は書かない)、AI が照合した行は「AI照合 (Claude Haiku・Claude Opus)」のように照合したモデルを書く。
- **推測で補わない。** 病害虫名から種が決まらない組は、アプリに「未登録」と出る。それで正しい。
- **出典の言葉を残す。** 程度は下の 4 段階に分けるが、出典の判定の言葉 (`source_wording`) と数値 (`metric`) も残す。

## taxa.csv (病原菌・害虫・雑草の種)

| 列 | 内容 |
|---|---|
| taxon_id | 英小文字・数字・`_` の ID (例 `tetranychus_urticae`) |
| scientific_name | 学名 |
| synonyms | 異名 (`;` 区切り)。外部データベースの学名との対応づけにも使う |
| japanese_name | 和名 (病原菌は空でよい)。FAMIC の病害虫名と同じ和名なら、`pest_map.csv` に行が無くても引ける |
| kind | `昆虫` `ダニ` `線虫` `糸状菌` `卵菌` `細菌` `雑草` のどれか (照合する RAC の系統が決まる) |
| source | 学名・和名の根拠 (日本植物病名データベースのレコード ID など) |
| verified_by / verified_at | 確認者・確認日 |
| note | メモ |

## pest_map.csv (FAMIC の病害虫名 → 種)

同じ病名でも作物で病原菌が違う (うどんこ病: きゅうりは *Podosphaera xanthii*、トマトは *Pseudoidium neolycopersici* と
*Leveillula taurica*) ため、作物ごとに持つ。「アブラムシ類」「ハダニ類」のような群名も、作物で主な種が違うので同じ扱いにする。

| 列 | 内容 |
|---|---|
| pest | FAMIC の病害虫名 (「…を除く」の括弧は付けない) |
| crop | 作物名 (作物分類表の名前)。作物群の名前 (うり類 など) なら所属作物すべてに効く。全作物共通なら `*` |
| taxon_ids | 種 ID (`;` 区切りで複数可) |
| source | 根拠 (文献、日本植物病名データベースのレコード ID など) |
| verified_by / verified_at | 確認者・確認日 |
| note | メモ |

引く順: その作物の行 → その作物を含む作物群の行 → `*` の行 → 種の和名が病害虫名と同じ種。どれも無ければ未登録。

## records.csv (国内の報告。1 行 = 1 つの種 × 1 つの成分 × 1 つの地域・年)

| 列 | 内容 |
|---|---|
| record_id | 重複しない ID (例 `tochigi-2025-ichigo-tanso-01`) |
| taxon_id | 種 ID |
| host_crop | 報告に書かれた作物 (例 いちご) |
| country | 空なら日本 |
| prefecture | 都道府県名 (`茨城県` でも `茨城` でも可)。国内なら必須 |
| survey_year | 調査年 (`2024` か `2023-2024`) |
| published | 公表日 (`2025`、`2025-02`、`2025-02-10` のいずれか) |
| ingredient | 検定した成分の FAMIC の成分名 (塩・水和物の語尾は違ってよい) |
| rac_code | 成分が登録データに無い (失効など) ときだけ書く。あれば登録データの値を使う |
| evidence | `圃場での効果低下` `生物検定` `遺伝子診断` のどれか |
| metric | 数値 (例 `耐性菌率 91/99 (91.9%)`、`抵抗性比 120`、`G143A`) |
| level | 程度。下の 4 段階のどれか |
| source_wording | 出典の判定の言葉 (例「高率に耐性を示した」) |
| source_title / source_publisher / source_url / source_page | 出典の題名・発行者・URL (http(s)://)・ページ |
| accessed | 閲覧日 (`2026-10-22` の形) |
| verified_by / verified_at | 確認者・確認日 |
| note | メモ |

### 程度の 4 段階 (出典に書かれたことだけで決める)

| level | 条件 |
|---|---|
| 効果低下 | 圃場で防除効果の低下が確認されたと出典に書かれている |
| 抵抗性あり | 耐性菌・抵抗性個体群を検出した (耐性菌率などは metric に書く) |
| 感受性低下 | 感受性の低下にとどまる、と出典が書いている |
| 検出されず | 検定したが抵抗性・耐性は認められなかった (これも記録する) |

## 外部データベース (sources.json、external/、included/)

- 取り込み役 (`scripts/import_resistance/`) が、外部データベースの行を `external/<id>.csv` (Git 管理外) に書く。
  - 日本雑草学会の一覧: `python3 scripts/import_resistance/wssj_japan.py`
  - APRD・WeedScience.org・FRAC など: 書き出したファイルを
    `python3 scripts/import_resistance/generic_csv.py --map scripts/import_resistance/maps/<id>.json --input <ファイル>`
    で読む。対応表の列名は、実際に書き出したファイルの見出しに合わせて直す (2026-10-22 時点で未確認)。
- **配布物に残すかは `sources.json` の `include` で選ぶ。** 既定は `false`。`true` にするには、利用条件を確かめた記録
  (`terms_checked`) と、取り込んだ件数・主な項目を照合した日 (`verified_at`) が要る。
  `true` にしてビルドすると `external/<id>.csv` が `included/<id>.csv` (Git 管理) に写り、配布物に入る。
  `false` に戻してビルドすると `included/` から外れる (`external/` には残る)。
- 外部の行は件数が多いので、確認は取り込みの単位で行う。アプリでは出どころの名前を付けて表示する。
- 英語の成分名は `ingredient_en.csv` で FAMIC の成分名に対応づける。対応が無く RAC コードも無い行は取り込まない (件数は警告で出る)。
