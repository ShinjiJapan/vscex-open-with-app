# Open With App

VSCode のエクスプローラーの右クリックメニューから、**拡張子ごとに記憶したアプリケーション**でファイルを開く拡張機能です。

## 機能

エクスプローラーでファイルを右クリックすると、次のメニューが表示されます。

- **指定したアプリケーションで開く**
  - その拡張子に記憶したアプリで開きます。
  - 初めての拡張子の場合は、まず「アプリの種類」を選びます。
    - **実行ファイルを選択** — `.exe` などをファイルダイアログで選択
    - **インストール済みアプリから選択（ストアアプリ含む）** — `Get-StartApps` のアプリ一覧から選択
  - 選んだアプリを拡張子ごとに記憶します。
  - 記憶した実行ファイルが見つからない場合は、自動で選択し直しを促します。
- **別のアプリケーションで開く...**
  - 記憶を無視して必ずアプリを選び直し、その拡張子の関連付けを上書きします。

### ストアアプリ対応について

ストアアプリ（UWP）は実行ファイルのパスを直接指定できないため、Windows の
`IApplicationActivationManager.ActivateForFile`（COM）経由でファイルを渡して起動します。
内部的に一時 PowerShell スクリプトを利用します（Windows のみ）。

コマンドパレット（`Ctrl+Shift+P`）には次のコマンドがあります。

- **Open With App: 拡張子とアプリの関連付けを管理**
  - 記憶した関連付けの一覧表示・個別削除・全削除ができます。

## 仕組み

- 関連付けは拡張子（例: `.pdf`）をキーに、`globalState` に保存されます（全ワークスペース共通）。
- 拡張子の無いファイル（例: `Dockerfile`）はファイル名をキーにします。
- 複数ファイルを選択して開けます。同じ拡張子なら1回だけアプリを選べば全部に適用されます。

## 多言語対応（ローカライズ）

VSCode の表示言語に合わせて、メニューラベルもダイアログ/メッセージも自動で切り替わります。

- **メニューラベル**: `package.json` の `%キー%` を `package.nls.json`（英語=既定）/ `package.nls.<locale>.json`（例: `package.nls.ja.json`）で解決
- **実行時メッセージ**: `vscode.l10n.t()` を使用し、`l10n/bundle.l10n.<locale>.json` で翻訳（英語=既定）

### 言語を追加するには

1. `package.nls.<locale>.json` を作成し、メニューラベルを翻訳
2. `l10n/bundle.l10n.<locale>.json` を作成し、`l10n/bundle.l10n.ja.json` のキー（英語原文）を翻訳

`<locale>` は VSCode のロケール ID（`ja`, `zh-cn`, `ko`, `de`, `fr` など）。
表示言語はコマンドパレットの「Configure Display Language」で切り替えられます。

## 開発・実行

1. このフォルダを VSCode で開く
2. `F5` を押して「拡張機能を実行」（Extension Development Host が起動）
3. 起動したウィンドウのエクスプローラーでファイルを右クリックして動作確認

## インストール（任意）

`vsce` でパッケージ化できます。

```powershell
npm install -g @vscode/vsce
vsce package
code --install-extension open-with-app-0.1.0.vsix
```
