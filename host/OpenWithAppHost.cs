using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;

// OpenWithAppHost — purpose-built launcher for the "open-with-app" VSCode extension.
//
// It exists for ONE reason: to perform a Store/packaged-app file activation from a
// process whose name is NOT a known console host (powershell.exe / cmd.exe / ...).
// A single-instance viewer such as SkimDown self-relaunches when it detects that it
// was launched by a console host, and that relaunch turns the proper Windows.File
// activation into a plain command-line one — so an already-open window then ignores
// the newly opened file. Launched from this neutrally-named exe, the File-contract
// activation reaches the app and it switches the displayed file IN PLACE, keeping the
// existing window — exactly like Explorer's "Open with".
//
// Usage:  OpenWithAppHost.exe <AppUserModelId> <filePath>
// Build:  csc /nologo /target:winexe /out:OpenWithAppHost.exe OpenWithAppHost.cs
//         (see host/build.ps1)
public static class OpenWithAppHost {
    // ---- ShellExecuteEx with SEE_MASK_CLASSNAME (file with a registered ProgID) ----
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHELLEXECUTEINFO {
        public int cbSize; public uint fMask; public IntPtr hwnd;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpVerb;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpParameters;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpDirectory;
        public int nShow; public IntPtr hInstApp; public IntPtr lpIDList;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpClass;
        public IntPtr hkeyClass; public uint dwHotKey; public IntPtr hIcon; public IntPtr hProcess;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO info);

    // SEE_MASK_CLASSNAME(0x1): use lpClass as the ProgID and open the file via its
    // shell\open\command (the Windows.File contract's DelegateExecute handler).
    static void ShellOpen(string progId, string file) {
        var s = new SHELLEXECUTEINFO(); s.cbSize = Marshal.SizeOf(s);
        s.fMask = 0x00000001; s.lpClass = progId; s.lpVerb = "open"; s.lpFile = file; s.nShow = 1;
        if (!ShellExecuteExW(ref s)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    // Find the file-type ProgID registered for this AUMID (same lookup Explorer uses).
    static string ResolveProgId(string aumid, string path) {
        if (Directory.Exists(path)) return null;                 // folders have no extension ProgID
        string ext = Path.GetExtension(path);
        if (string.IsNullOrEmpty(ext)) return null;              // no extension -> not a file ProgID
        var cands = new List<string>();
        var roots = new RegistryKey[] {
            Registry.ClassesRoot.OpenSubKey(ext + "\\OpenWithProgids"),
            Registry.CurrentUser.OpenSubKey("Software\\Classes\\" + ext + "\\OpenWithProgids")
        };
        foreach (var r in roots) if (r != null) { foreach (var n in r.GetValueNames()) if (!string.IsNullOrEmpty(n) && !cands.Contains(n)) cands.Add(n); r.Close(); }
        foreach (var c in cands) {
            using (var k = Registry.ClassesRoot.OpenSubKey(c + "\\shell\\open")) {
                if (k != null) { var a = k.GetValue("AppUserModelID") as string; if (a != null && string.Equals(a, aumid, StringComparison.OrdinalIgnoreCase)) return c; }
            }
        }
        return null;
    }

    // ---- UWP activation fallback (folders, or packaged apps with no file ProgID) ----
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem { void BindToHandler(); void GetParent(); void GetDisplayName(); void GetAttributes(); void Compare(); }
    [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemArray { }
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager {
        int ActivateApplication(string appUserModelId, string arguments, int options, out uint processId);
        int ActivateForFile(string appUserModelId, IShellItemArray itemArray, string verb, out uint processId);
        int ActivateForProtocol(string appUserModelId, IShellItemArray itemArray, out uint processId);
    }
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] class AAM { }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
    [DllImport("shell32.dll", PreserveSig = false)]
    static extern void SHCreateShellItemArrayFromShellItem(IShellItem psi, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemArray ppv);
    static Guid IID_IShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
    static Guid IID_IShellItemArray = new Guid("b63ea76d-1f85-456f-a19c-48159efa858b");

    static void UwpActivate(string aumid, string path) {
        var mgr = (IApplicationActivationManager)(new AAM());
        uint pid;
        try {
            IShellItem item; SHCreateItemFromParsingName(path, IntPtr.Zero, ref IID_IShellItem, out item);
            IShellItemArray arr; SHCreateShellItemArrayFromShellItem(item, ref IID_IShellItemArray, out arr);
            int hr = mgr.ActivateForFile(aumid, arr, null, out pid);
            if (hr != 0) throw new Exception("ActivateForFile 0x" + hr.ToString("X8"));
        } catch {
            int hr = mgr.ActivateApplication(aumid, path, 0, out pid);   // fall back to passing the path as an argument
            if (hr != 0) throw new Exception("ActivateApplication 0x" + hr.ToString("X8"));
        }
    }

    [STAThread]
    static int Main(string[] argv) {
        if (argv.Length < 2) { Console.Error.WriteLine("usage: OpenWithAppHost <AppUserModelId> <filePath>"); return 2; }
        string aumid = argv[0], path = argv[1];
        try {
            string progId = ResolveProgId(aumid, path);
            if (progId != null) {
                ShellOpen(progId, path);
                // ShellExecuteEx delegates the launch to the shell and returns immediately;
                // stay alive briefly so the shell takes ownership before this process exits.
                System.Threading.Thread.Sleep(3000);
            } else {
                UwpActivate(aumid, path);
            }
            return 0;
        } catch (Exception ex) {
            while (ex.InnerException != null) ex = ex.InnerException;
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }
}
