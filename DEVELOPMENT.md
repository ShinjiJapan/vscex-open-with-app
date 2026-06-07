# 開発者向けドキュメント

Open With App の開発・ビルド・公開・ローカライズに関するメモです。
利用者向けの説明は [README.md](README.md) を参照してください。

## 開発・実行

1. このフォルダを VSCode で開く
2. `F5` を押して「拡張機能を実行」（Extension Development Host が起動）
3. 起動したウィンドウのエクスプローラーでファイルを右クリックして動作確認

## パッケージング

`vsce` でローカル用の `.vsix` を作成できます。

```powershell
npm install -g @vscode/vsce
vsce package
code --install-extension open-with-app-<version>.vsix
```

## 公開（Marketplace）

```powershell
vsce login shinjijapan      # 初回のみ。PAT を入力
vsce publish                # 現在のバージョンで公開
vsce publish patch          # 0.0.x を上げて公開（minor / major も可）
```

公開ページ（Marketplace）には `README.md` の内容がそのまま表示されます。
利用者向けの記述は README.md に、開発者向けの記述はこのファイルに分けています。

## ローカライズ（多言語対応）

VSCode の表示言語に合わせて、メニューラベルもダイアログ/メッセージも自動で切り替わります。

- **メニューラベル**: `package.json` の `%キー%` を `package.nls.json`（英語=既定）/ `package.nls.<locale>.json`（例: `package.nls.ja.json`）で解決
- **実行時メッセージ**: `vscode.l10n.t()` を使用し、`l10n/bundle.l10n.<locale>.json` で翻訳（英語=既定）

### 言語を追加するには

1. `package.nls.<locale>.json` を作成し、メニューラベルを翻訳
2. `l10n/bundle.l10n.<locale>.json` を作成し、`l10n/bundle.l10n.ja.json` のキー（英語原文）を翻訳

`<locale>` は VSCode のロケール ID（`ja`, `zh-cn`, `ko`, `de`, `fr` など）。
表示言語はコマンドパレットの「Configure Display Language」で切り替えられます。

## ストアアプリ対応について

ストアアプリ（UWP/パッケージアプリ）は実行ファイルのパスを直接指定できないため、同梱の
ヘルパー実行ファイル **`host/OpenWithAppHost.exe`** 経由でファイルを開きます（Windows のみ）。

ヘルパーは、拡張子に対応する ProgID が見つかれば `ShellExecuteEx`（Windows.File コントラクト）で
開き、見つからなければ（フォルダー等）`IApplicationActivationManager` で起動します。

### なぜ専用ヘルパーが必要か

`powershell.exe` から直接アクティベートすると、単一インスタンスのビューア（例: SkimDown）が
「コンソールホストから起動された」と判定して自分自身を再起動し、その過程で正規の
Windows.File アクティベーションがコマンドライン渡しに化けます。すると、すでに開いている
ウィンドウが新しく開いたファイルに**切り替わりません**。`powershell.exe` 等の既知のコンソール
ホスト名**以外**の中立な名前のプロセスから起動すれば再起動が起きず、エクスプローラーの
「プログラムから開く」と同じく、既存ウィンドウを保ったまま表示ファイルが切り替わります。
（`powershell.exe` をリネームして使う手は AV/EDR にマルウェアの常套手段として検知されるため
採用していません。）

### ヘルパーのビルド

ソースは `host/OpenWithAppHost.cs`。Windows 同梱の .NET Framework C# コンパイラでビルドします
（外部 SDK 不要）。`host/OpenWithAppHost.exe` は VSIX に同梱するため、ソース変更後はビルドして
コミットしてください。

```powershell
host\build.ps1
```

インストール済みアプリの一覧は `Get-StartApps` から取得しています（PowerShell 経由）。

## データの保存先

関連付けは拡張子（例: `.pdf`）をキーに `globalState` に保存されます（全ワークスペース共通）。
拡張子の無いファイル（例: `Dockerfile`）はファイル名をキーにします。
