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

ストアアプリ（UWP）は実行ファイルのパスを直接指定できないため、Windows の
`IApplicationActivationManager.ActivateForFile`（COM）経由でファイルを渡して起動します。
内部的に一時 PowerShell スクリプトを利用します（Windows のみ）。

インストール済みアプリの一覧は `Get-StartApps` から取得しています。

## データの保存先

関連付けは拡張子（例: `.pdf`）をキーに `globalState` に保存されます（全ワークスペース共通）。
拡張子の無いファイル（例: `Dockerfile`）はファイル名をキーにします。
