# iOS アプリ版 — 農薬簡易検索 Ver. 1.3.0

自分の iPhone に「農薬簡易検索」アプリをインストールするための Xcode プロジェクトです。
バンドル版 HTML を WKWebView で表示するシンプルなラッパーで、**追加課金ゼロ（無料の
Personal Team 署名）** で 7 日間動作します。7 日経過後は Xcode から再ビルドすれば延長できます。

## 必要なもの

- **Mac** (Apple Silicon / Intel どちらでも可)
- **Xcode 15 以上** (Mac App Store から無料、約 7 GB)
- **iPhone** (iOS 16.0 以上 / iPad も可)
- **Lightning または USB-C ケーブル** (初回のみ、以降 Wi-Fi 経由も可)
- **Apple ID** (有料の Apple Developer Program は**不要**)

## 手順

### 1. Xcode で開く

```
open /Volumes/tkg\ SSD/browser-pesticide-search/ios/PesticideSearch.xcodeproj
```

もしくは Finder で `PesticideSearch.xcodeproj` をダブルクリック。

### 2. 署名 (Signing) を設定

左上の **PesticideSearch** プロジェクト (青いアイコン) をクリック →
中央で **TARGETS → PesticideSearch** を選択 → **Signing & Capabilities** タブ:

- ✅ **Automatically manage signing** にチェック
- **Team**: 自分の Apple ID を選択 (初回は「Add an Account…」で Apple ID ログイン)
  - 無料の **Personal Team** が自動的に選ばれます
- **Bundle Identifier**: 他のアプリと被らないよう変更 (例: `jp.local.yourname.pesticidesearch`)

Personal Team の場合、以下の警告が出ることがありますが**無視で OK**:
- 「Personal Team not supported...」→ 機能を使わない限り影響なし
- 「App requires provisioning profile...」→ Team 選択後に自動解決

### 3. iPhone を接続

iPhone を Mac に USB 接続 → iPhone 側で「このコンピュータを信頼しますか?」→ 信頼

Xcode 上部のスキーム選択 (デバイス選択)で、接続した iPhone を選択。

### 4. ビルド & インストール

Xcode メニュー **Product → Run** (または `⌘R`)

初回ビルドは 1〜2 分。iPhone 側で:

- ⚠️ 「信頼されていないデベロッパ」と表示される場合:
  **iPhone 設定 → 一般 → VPNとデバイス管理** → 自分の Apple ID を選択 → **「信頼」**
- 初回起動時に「開発元を確認できません」と出ることがあります。同じく設定から信頼。

ホーム画面に「**農薬簡易検索**」アイコンが追加されます。タップして起動。

### 5. 7 日後の更新 (無料 Personal Team 制限)

Personal Team で署名されたアプリは **7 日間で失効** します。失効後は起動できなくなる
ので、Xcode で再度 `⌘R` するだけで 7 日延長されます (USB 接続必要)。

恒久的に使いたい場合は以下のいずれか:
- **Apple Developer Program** ($99/年) に加入して「App Store Connect」経由で
  プロビジョニング → 1 年間有効
- **TestFlight** (同じく Developer Program 加入後) → 90 日有効、招待制で 10,000 人まで配布可

## アプリの構造

```
ios/
├── project.yml                    # xcodegen 設定 (再生成用)
├── PesticideSearch.xcodeproj/     # Xcode プロジェクト
└── App/
    ├── Info.plist
    ├── Sources/
    │   ├── PesticideSearchApp.swift   # @main エントリ
    │   └── ContentView.swift          # WKWebView ラッパー
    └── Resources/
        ├── これをクリック.html          # バンドル版 (24 MB)
        └── 使い方.html                  # 使い方ガイド
```

- アプリ起動 → `これをクリック.html` を WKWebView で表示
- 右上の「使い方」ボタン → `使い方.html` を sheet モーダルで表示
- JPP-NET 等の外部リンク → Safari に委譲

## トラブル

### 「No account for team」「Team needs to be selected」
→ 手順 2 の Team 選択が未完了。Apple ID でログインし直す。

### 「Bundle identifier already in use」
→ 他の人が同じ `jp.local.pesticidesearch` を使用済み。
   `jp.local.yourname.pesticidesearch` 等に変更。

### ビルドはできたが iPhone にインストールできない
→ 「Untrusted Developer」状態。設定 → 一般 → VPNとデバイス管理 → 信頼。

### HTML 内の検索が動かない / データが読み込まれない
→ `App/Resources/` に `これをクリック.html` がコピーされているか確認。
   `build/これをクリック.html` を更新した場合は `cp` で再コピー:
   ```
   cp "/Volumes/tkg SSD/browser-pesticide-search/build/これをクリック.html" \
      "/Volumes/tkg SSD/browser-pesticide-search/ios/App/Resources/"
   ```
   Xcode で `⌘R` 再ビルド。

### Xcode が起動しない / App Store にない
→ Xcode は Mac App Store から「Xcode」で検索 (無料、約 7 GB)。
   macOS の最小要件 (Sonoma 以降) を満たす必要があります。

## データ更新について

iOS アプリ版は **バンドル時点のデータで固定** です (FAMIC を fetch しないため)。
最新データで更新したい場合:

1. Mac 側で `データ更新.command` を実行 → `build/これをクリック.html` が最新化
2. 上記 `cp` コマンドで iOS リソースに再コピー
3. Xcode で `⌘R` → iPhone に再インストール

ライブ更新 (サーバから JSON を fetch) を希望する場合は別実装が必要です
(FAMIC の CORS 問題のため中継サーバが必要)。
