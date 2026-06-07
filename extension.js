const vscode = require('vscode');
const path = require('path');
const cp = require('child_process');
const fs = require('fs');

const STORE_KEY = 'extensionAppAssociations';
const isWin = process.platform === 'win32';

// フォルダはすべて同じ関連付け（1つのアプリ）で開けるよう、共通のキーで記憶する。
const FOLDER_KEY = '<folder>';

/** @returns {Record<string, any>} 拡張子 -> 関連付け の対応表 */
function getAssociations(context) {
  return context.globalState.get(STORE_KEY, {});
}

async function setAssociation(context, ext, entry) {
  const assoc = getAssociations(context);
  assoc[ext] = entry;
  await context.globalState.update(STORE_KEY, assoc);
}

/**
 * 保存値を正規化する。
 * 旧形式（文字列＝実行ファイルパス）も { kind:'exe', target, label } に変換。
 */
function normalizeEntry(value) {
  if (!value) return undefined;
  if (typeof value === 'string') {
    return { kind: 'exe', target: value, label: path.basename(value) };
  }
  return value;
}

/** パスがディレクトリかどうか。判定できなければ false。 */
function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 関連付けのキー。
 * フォルダはすべて共通キー（FOLDER_KEY）、
 * ファイルは拡張子があれば小文字の拡張子（例: ".pdf"）、
 * なければファイル名そのもの（例: "dockerfile"）。
 * ※ フォルダ名に "." が含まれても拡張子扱いしないよう、先にディレクトリ判定する。
 */
function extKeyFor(filePath) {
  if (isDirectory(filePath)) return FOLDER_KEY;
  const ext = path.extname(filePath).toLowerCase();
  return ext || path.basename(filePath).toLowerCase();
}

/** PowerShell をテキスト出力で実行（Promise） */
function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** インストール済みストアアプリ等（Get-StartApps）の一覧を取得 */
async function listStartApps() {
  // 日本語アプリ名が文字化けしないよう出力を UTF-8 に強制する
  const out = await runPowerShell([
    '-Command',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-StartApps | Select-Object Name,AppID) | ConvertTo-Json -Compress',
  ]);
  const trimmed = (out || '').trim();
  if (!trimmed) return [];
  let parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed.filter((a) => a && a.AppID);
}

/**
 * 同梱のヘルパー実行ファイル OpenWithAppHost.exe のパスを返す。
 * ストアアプリのアクティベーションを PowerShell など「コンソールホスト」と判定される
 * プロセスから行うと、単一インスタンスのビューア（例: SkimDown）が自分自身を再起動し、
 * すでに開いているウィンドウが新しく開いたファイルに切り替わらない（再起動の過程で
 * 正規の Windows.File アクティベーションがコマンドライン渡しに化けるため）。中立な名前の
 * このヘルパーから起動すると再起動が起きず、エクスプローラーの「プログラムから開く」と
 * 同じく、既存ウィンドウを保ったまま表示ファイルが切り替わる。
 *
 * ヘルパーのソースと再ビルド手順は host/OpenWithAppHost.cs / host/build.ps1 を参照。
 */
function getStoreLauncherExe() {
  return path.join(__dirname, 'host', 'OpenWithAppHost.exe');
}

/**
 * 子プロセス用に「掃除した」環境変数を返す。
 * 拡張機能ホスト（VSCode 本体）は ELECTRON_RUN_AS_NODE や VSCODE_* を設定しており、
 * これをそのまま継承すると Electron 製アプリが GUI ではなく Node として起動してしまう
 * （= 何も表示されない）。これらを取り除いて、通常のシェルから起動したのと同じ状態にする。
 */
function sanitizedEnv() {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) continue;
    env[key] = process.env[key];
  }
  return env;
}

/**
 * 実行ファイルが VSCode 系（VSCode / VSCodium / Cursor など Electron 製エディタ）なら、
 * 同梱の CLI 本体 cli.js のパスを返す。これらは Code.exe を直接たたいてもフォルダーを
 * 開けず、cli.js 経由（= bin\code.cmd と同じ起動方法）でないと正しく開けない。
 */
function findVscodeCliJs(appPath) {
  const dir = path.dirname(appPath);
  const binDir = path.join(dir, 'bin');
  let binEntries;
  try {
    binEntries = fs.readdirSync(binDir);
  } catch {
    binEntries = undefined; // bin フォルダーが無い（＝ほとんどの非 VSCode アプリ）
  }

  // 1) 公式 CLI ランチャー bin\*.cmd は cli.js の正確なパスを内部に持っている。
  //    インストール形態（フラット/コミットハッシュ配下）に依存せず最も確実なので最優先で読む。
  //    例: "%~dp0..\<...>\resources\app\out\cli.js"（%~dp0 は bin\、.. でインストール直下）
  if (binEntries) {
    for (const name of binEntries) {
      if (!/\.cmd$/i.test(name)) continue;
      try {
        const text = fs.readFileSync(path.join(binDir, name), 'utf8');
        const m = text.match(/%~dp0\.\.[\\/]([^"]*cli\.js)/i);
        if (m) {
          const cli = path.join(dir, m[1].replace(/\//g, '\\'));
          if (fs.existsSync(cli)) return cli;
        }
      } catch {
        // この .cmd は読めなかった。次へ。
      }
    }
  }

  // 2) フラット配置（古い VSCode など）: <dir>\resources\app\out\cli.js
  const flat = path.join(dir, 'resources', 'app', 'out', 'cli.js');
  if (fs.existsSync(flat)) return flat;

  // 3) コミットハッシュ配下: <dir>\<hash>\resources\app\out\cli.js。
  //    通常のアプリのフォルダー（System32 等）を無駄に走査しないよう、
  //    VSCode らしい構成（bin\ か resources\ がある）のときだけ走査する。
  if (binEntries || fs.existsSync(path.join(dir, 'resources'))) {
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory() && /^[0-9a-f]{7,}$/i.test(ent.name)) {
          const cli = path.join(dir, ent.name, 'resources', 'app', 'out', 'cli.js');
          if (fs.existsSync(cli)) return cli;
        }
      }
    } catch {
      // 読めなければ諦める（通常起動にフォールバック）
    }
  }
  return undefined;
}

/**
 * 子プロセスを detached で起動し、失敗時のみ通知する。
 * ※ windowsHide は付けない。これは STARTUPINFO に SW_HIDE を渡すため、
 *   メモ帳など多くのデスクトップ GUI アプリのウィンドウが表示されなくなる。
 */
function spawnDetached(command, args, env) {
  const child = cp.spawn(command, args, { detached: true, stdio: 'ignore', env });
  child.on('error', (err) => {
    vscode.window.showErrorMessage(vscode.l10n.t('Failed to launch the application: {0}', err.message));
  });
  child.unref();
}

/** 実行ファイル（exe 等）でファイルを起動 */
function launchExe(appPath, filePath) {
  const env = sanitizedEnv();
  const cliJs = isWin ? findVscodeCliJs(appPath) : undefined;
  if (cliJs) {
    // VSCode 系: Code.exe に cli.js を渡し、ELECTRON_RUN_AS_NODE=1 で CLI として実行させる
    env.ELECTRON_RUN_AS_NODE = '1';
    spawnDetached(appPath, [cliJs, filePath], env);
  } else {
    spawnDetached(appPath, [filePath], env);
  }
}

/** AUMID らしくない（＝実在する実行ファイルのパス）かどうか */
function looksLikeExePath(target) {
  return /[\\/]/.test(target) && fs.existsSync(target) && !isDirectory(target);
}

/**
 * インストール済みアプリ（Get-StartApps の AppID）の実行ファイルパスを解決する。
 * VSCode などのデスクトップアプリは AppsFolder 経由で実行ファイルを取得でき、解決できれば
 * exe として起動する。本物のパッケージ（UWP）アプリは解決できず undefined を返す。
 */
// 解決結果はセッション中変わらないのでメモ化する（複数ファイル選択時に PowerShell を毎回起動しない）
const installedAppExeCache = new Map();

function resolveInstalledAppExe(appId) {
  if (installedAppExeCache.has(appId)) {
    return Promise.resolve(installedAppExeCache.get(appId));
  }
  // AppID は環境変数経由で渡し、PowerShell へのコード差し込みを避ける
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
    "$id=$env:OWA_APPID;" +
    "$item=(New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder').Items()" +
    " | Where-Object { $_.Path -eq $id } | Select-Object -First 1;" +
    "if ($item) { $t=$item.ExtendedProperty('System.Link.TargetParsingPath'); if ($t) { Write-Output $t } }";
  return new Promise((resolve) => {
    cp.execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, OWA_APPID: appId } },
      (err, stdout) => {
        const p = err ? '' : (stdout || '').trim();
        const result = p && fs.existsSync(p) && !isDirectory(p) ? p : undefined;
        installedAppExeCache.set(appId, result);
        resolve(result);
      }
    );
  });
}

/** ストアアプリ（AUMID）でファイルを起動。失敗時はエラーを通知する */
async function launchStore(aumid, filePath) {
  // 実行ファイルのパスがそのまま保存されている場合（旧データなど）は exe として起動
  if (looksLikeExePath(aumid)) {
    launchExe(aumid, filePath);
    return;
  }
  // Get-StartApps のデスクトップアプリ（VSCode 等）は実行ファイルを解決して exe として起動する。
  // UWP アクティベーション API では起動できず ArgumentException になるため。
  const resolvedExe = await resolveInstalledAppExe(aumid);
  if (resolvedExe) {
    launchExe(resolvedExe, filePath);
    return;
  }
  // UWP（パッケージ）アプリの AUMID は "PackageFamilyName!AppId" の形で "!" を含む。
  // "!" が無いのに実行ファイルを特定できなかった＝デスクトップアプリだが解決に失敗した
  // （COM がポリシーでブロックされている環境など）。専用 API では起動できないので、
  // 実行ファイルを選び直すよう分かりやすく案内する。
  if (!aumid.includes('!')) {
    vscode.window.showErrorMessage(
      vscode.l10n.t('Could not determine how to launch "{0}". Please use "Select an executable..." and choose the app .exe instead.', aumid)
    );
    return;
  }
  // パッケージ（UWP/ストア）アプリは同梱のヘルパー OpenWithAppHost.exe で開く。
  // PowerShell から開くと SkimDown 等が「コンソールホストから起動された」と判定して
  // 自分自身を再起動し、既に開いているウィンドウが新しいファイルに切り替わらないため、
  // 中立な名前のこのヘルパーを使う（エクスプローラーの「プログラムから開く」と同じ挙動になる）。
  const launcher = getStoreLauncherExe();
  if (!fs.existsSync(launcher)) {
    vscode.window.showErrorMessage(vscode.l10n.t('The launcher helper was not found: {0}', launcher));
    return;
  }
  // ヘルパーはアクティベーションをシェルへ委譲後すぐ終了する（アプリ本体は独立して動く）。
  // 結果を受け取ってエラーを握り潰さないよう execFile を使う。
  cp.execFile(
    launcher,
    [aumid, filePath],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
    (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').trim();
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to launch the Store app: {0}', detail));
      }
    }
  );
}

/** 関連付けエントリでファイルを開く */
async function launchEntry(entry, filePath) {
  try {
    if (entry.kind === 'store') {
      await launchStore(entry.target, filePath);
    } else {
      launchExe(entry.target, filePath);
    }
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Failed to launch: {0}', err.message));
  }
}

/** 実行ファイルを選択 */
async function pickExe(extKey) {
  const filters = isWin
    ? {
        [vscode.l10n.t('Applications')]: ['exe', 'bat', 'cmd', 'com'],
        [vscode.l10n.t('All Files')]: ['*'],
      }
    : undefined;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: false,
    canSelectFiles: true,
    openLabel: vscode.l10n.t('Select'),
    title: vscode.l10n.t('Select the executable to open "{0}" files', extKey),
    filters,
  });
  if (!picked || picked.length === 0) return undefined;
  const p = picked[0].fsPath;
  return { kind: 'exe', target: p, label: path.basename(p) };
}

/** インストール済みストアアプリから選択 */
async function pickStoreApp() {
  let apps;
  try {
    apps = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Getting installed apps...') },
      () => listStartApps()
    );
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Failed to get the app list: {0}', err.message));
    return undefined;
  }
  if (!apps || apps.length === 0) {
    vscode.window.showWarningMessage(vscode.l10n.t('No installed apps were found.'));
    return undefined;
  }
  const items = apps
    .map((a) => ({ label: a.Name, description: a.AppID, appId: a.AppID }))
    .sort((x, y) => x.label.localeCompare(y.label));

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Select an app to open the file (Store apps and desktop apps)'),
    matchOnDescription: true,
  });
  if (!choice) return undefined;
  return { kind: 'store', target: choice.appId, label: choice.label };
}

/** アプリの種類を選んでから選択。戻り値は関連付けエントリ or undefined */
async function pickApplication(extKey) {
  if (!isWin) {
    return pickExe(extKey);
  }
  const kind = await vscode.window.showQuickPick(
    [
      { label: '$(file-binary) ' + vscode.l10n.t('Select an executable...'), value: 'exe' },
      { label: '$(window) ' + vscode.l10n.t('Select from installed apps (including Store apps)'), value: 'store' },
    ],
    { placeHolder: vscode.l10n.t('Select the type of app to open "{0}"', extKey) }
  );
  if (!kind) return undefined;
  return kind.value === 'store' ? pickStoreApp() : pickExe(extKey);
}

/** コマンド引数から対象URI配列を取り出す */
function resolveUris(uri, uris) {
  // エクスプローラ右クリックでは uri=クリックしたファイル、uris=選択範囲 が渡る。
  // ただし explorer.autoReveal によりアクティブエディタのファイルが自動選択されていると、
  // 別のファイルを右クリックしても uris は元のまま（クリックした uri を含まない）ことがある。
  // その場合に uris を優先すると「何を右クリックしても同じファイルが開く」不具合になるため、
  // クリックした uri が選択範囲に含まれないときはクリックしたファイルだけを対象にする。
  if (Array.isArray(uris) && uris.length > 0) {
    if (uri && !uris.some((u) => u.toString() === uri.toString())) {
      return [uri];
    }
    return uris;
  }
  if (uri) return [uri];
  const active = vscode.window.activeTextEditor;
  return active ? [active.document.uri] : [];
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {vscode.Uri[]} targets
 * @param {boolean} forcePick 記憶を無視して必ず選択し直す
 */
async function openFiles(context, targets, forcePick) {
  if (targets.length === 0) {
    vscode.window.showWarningMessage(vscode.l10n.t('No file to open was found.'));
    return;
  }

  // 同一拡張子で複数選択された場合に何度も聞かないよう、この呼び出し内でキャッシュ
  const pickedThisRun = {};

  for (const target of targets) {
    if (target.scheme !== 'file') {
      vscode.window.showWarningMessage(vscode.l10n.t('Cannot open because it is not a local file: {0}', target.toString()));
      continue;
    }
    const filePath = target.fsPath;
    const key = extKeyFor(filePath);

    let entry = forcePick ? pickedThisRun[key] : normalizeEntry(getAssociations(context)[key]);

    // exe の場合、登録パスが存在しなければ選び直し
    const exeMissing = entry && entry.kind === 'exe' && !fs.existsSync(entry.target);

    if (!entry || exeMissing) {
      if (pickedThisRun[key]) {
        entry = pickedThisRun[key];
      } else {
        if (exeMissing) {
          vscode.window.showWarningMessage(
            vscode.l10n.t('The remembered app was not found: {0}. Please select it again.', entry.target)
          );
        }
        const picked = await pickApplication(key);
        if (!picked) continue; // このファイルはスキップ
        entry = picked;
        pickedThisRun[key] = entry;
        await setAssociation(context, key, entry);
        vscode.window.setStatusBarMessage(
          vscode.l10n.t('Remembered to open "{0}" with {1}', key, entry.label),
          4000
        );
      }
    }

    await launchEntry(entry, filePath);
  }
}

/** 関連付けの一覧表示・削除を行う管理コマンド */
async function manageAssociations(context) {
  const assoc = getAssociations(context);
  const entries = Object.entries(assoc);
  if (entries.length === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('There are no remembered associations.'));
    return;
  }

  const items = entries.map(([ext, raw]) => {
    const e = normalizeEntry(raw);
    const kindLabel = e.kind === 'store' ? vscode.l10n.t('[Store app]') : vscode.l10n.t('[Executable]');
    const missing = e.kind === 'exe' && !fs.existsSync(e.target) ? '  ⚠ ' + vscode.l10n.t('not found') : '';
    return {
      label: ext,
      description: `${kindLabel} ${e.label || e.target}`,
      detail: e.kind === 'exe' ? `${e.target}${missing}` : e.target,
      ext,
    };
  });
  items.push({ label: '$(trash) ' + vscode.l10n.t('Delete all'), ext: '__CLEAR_ALL__', description: '' });

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Select an association to delete (selecting an extension deletes its association)'),
  });
  if (!choice) return;

  if (choice.ext === '__CLEAR_ALL__') {
    await context.globalState.update(STORE_KEY, {});
    vscode.window.showInformationMessage(vscode.l10n.t('Deleted all associations.'));
    return;
  }

  delete assoc[choice.ext];
  await context.globalState.update(STORE_KEY, assoc);
  vscode.window.showInformationMessage(vscode.l10n.t('Deleted the association for "{0}".', choice.ext));
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('openWithApp.open', (uri, uris) =>
      openFiles(context, resolveUris(uri, uris), false)
    ),
    vscode.commands.registerCommand('openWithApp.openWith', (uri, uris) =>
      openFiles(context, resolveUris(uri, uris), true)
    ),
    vscode.commands.registerCommand('openWithApp.manage', () =>
      manageAssociations(context)
    )
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
