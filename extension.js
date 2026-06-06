const vscode = require('vscode');
const path = require('path');
const os = require('os');
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

/** ストアアプリ（UWP）を AppUserModelID 経由でファイル付きで起動するための一時 .ps1 を用意 */
function ensureStoreLauncherScript() {
  const scriptPath = path.join(os.tmpdir(), 'open-with-app-store-launch.ps1');
  const content = `param(
  [Parameter(Mandatory=$true)][string]$Aumid,
  [Parameter(Mandatory=$true)][string]$FilePath
)
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

public static class StoreLauncher {
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(int sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemArray { }

    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager {
        int ActivateApplication(string appUserModelId, string arguments, int options, out uint processId);
        int ActivateForFile(string appUserModelId, IShellItemArray itemArray, string verb, out uint processId);
        int ActivateForProtocol(string appUserModelId, IShellItemArray itemArray, out uint processId);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    class ApplicationActivationManager { }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(
        string pszPath, IntPtr pbc, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    [DllImport("shell32.dll", PreserveSig = false)]
    static extern void SHCreateShellItemArrayFromShellItem(
        IShellItem psi, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemArray ppv);

    static Guid IID_IShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
    static Guid IID_IShellItemArray = new Guid("b63ea76d-1f85-456f-a19c-48159efa858b");

    // 拡張子を登録しているアプリ向けの正式なファイル起動
    static uint ActivateForFile(string aumid, string filePath) {
        IShellItem item;
        SHCreateItemFromParsingName(filePath, IntPtr.Zero, ref IID_IShellItem, out item);
        IShellItemArray array;
        SHCreateShellItemArrayFromShellItem(item, ref IID_IShellItemArray, out array);
        var mgr = (IApplicationActivationManager)(new ApplicationActivationManager());
        uint pid;
        int hr = mgr.ActivateForFile(aumid, array, null, out pid);
        if (hr != 0) throw new Exception("ActivateForFile failed: 0x" + hr.ToString("X8"));
        return pid;
    }

    // ファイルパスを起動引数として渡す汎用フォールバック
    static uint ActivateApp(string aumid, string filePath) {
        var mgr = (IApplicationActivationManager)(new ApplicationActivationManager());
        uint pid;
        int hr = mgr.ActivateApplication(aumid, filePath, 0, out pid);
        if (hr != 0) throw new Exception("ActivateApplication failed: 0x" + hr.ToString("X8"));
        return pid;
    }

    public static uint Open(string aumid, string filePath) {
        try {
            return ActivateForFile(aumid, filePath);
        } catch {
            // 拡張子未登録などで ForFile が失敗した場合は引数渡しで起動
            return ActivateApp(aumid, filePath);
        }
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[StoreLauncher]::Open($Aumid, $FilePath) | Out-Null
`;
  // Windows PowerShell 5.1 は BOM 無し .ps1 を ANSI(Shift-JIS) として読むため、
  // 日本語コメントが化けて C# のコンパイルに失敗する。UTF-8 BOM 付きで書き出す。
  fs.writeFileSync(scriptPath, '﻿' + content, 'utf8');
  return scriptPath;
}

/** 実行ファイル（exe 等）でファイルを起動 */
function launchExe(appPath, filePath) {
  const child = cp.spawn(appPath, [filePath], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    vscode.window.showErrorMessage(vscode.l10n.t('Failed to launch the application: {0}', err.message));
  });
  child.unref();
}

/** ストアアプリ（AUMID）でファイルを起動。失敗時はエラーを通知する */
function launchStore(aumid, filePath) {
  let scriptPath;
  try {
    scriptPath = ensureStoreLauncherScript();
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Failed to prepare the Store app launch script: {0}', err.message));
    return;
  }
  // PowerShell プロセスはアクティベート後すぐ終了する（アプリ本体は独立して動く）。
  // 結果を受け取ってエラーを握り潰さないよう execFile を使う。
  cp.execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Aumid', aumid,
      '-FilePath', filePath,
    ],
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
function launchEntry(entry, filePath) {
  try {
    if (entry.kind === 'store') {
      launchStore(entry.target, filePath);
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
  if (Array.isArray(uris) && uris.length > 0) return uris;
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

    launchEntry(entry, filePath);
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
