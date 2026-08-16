'use strict'

/* Adds a modern Windows Explorer-style folder chooser for the browser UI.
 * Loaded after bulk-upload-preload so this wrapper composes on top of the existing
 * Express wrapper instead of competing with it.
 */
if (!global.__fileGramNativeFolderPickerInstalled) {
  global.__fileGramNativeFolderPickerInstalled = true

  const { spawn } = require('node:child_process')
  const expressPath = require.resolve('express')
  const priorExpress = require(expressPath)

  function pickFolderWindows () {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') {
        const error = new Error('Native folder selection is currently available on Windows only')
        error.status = 501
        reject(error)
        return
      }

      // IFileOpenDialog + FOS_PICKFOLDERS is the modern Explorer shell dialog.
      // FolderBrowserDialog is intentionally not used: it is the tiny legacy tree
      // window and does not match the rest of FileGram's picker experience.
      const script = String.raw`
$source = @"
using System;
using System.Runtime.InteropServices;

[Flags]
public enum FOS : uint {
  FOS_PICKFOLDERS = 0x00000020,
  FOS_FORCEFILESYSTEM = 0x00000040,
  FOS_PATHMUSTEXIST = 0x00000800,
  FOS_DONTADDTORECENT = 0x02000000
}

public enum SIGDN : uint {
  FILESYSPATH = 0x80058000
}

[ComImport]
[Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
public class FileOpenDialogRCW { }

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
public interface IShellItem {
  void BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
  void GetParent(out IShellItem ppsi);
  void GetDisplayName(SIGDN sigdnName, out IntPtr ppszName);
  void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
  void Compare(IShellItem psi, uint hint, out int piOrder);
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
public interface IFileDialog {
  [PreserveSig] int Show(IntPtr parent);
  void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
  void SetFileTypeIndex(uint iFileType);
  void GetFileTypeIndex(out uint piFileType);
  void Advise(IntPtr pfde, out uint pdwCookie);
  void Unadvise(uint dwCookie);
  void SetOptions(FOS fos);
  void GetOptions(out FOS pfos);
  void SetDefaultFolder(IShellItem psi);
  void SetFolder(IShellItem psi);
  void GetFolder(out IShellItem ppsi);
  void GetCurrentSelection(out IShellItem ppsi);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
  void GetResult(out IShellItem ppsi);
}

public static class FileGramFolderPicker {
  public static string Pick() {
    IFileDialog dialog = (IFileDialog)new FileOpenDialogRCW();
    dialog.GetOptions(out FOS options);
    dialog.SetOptions(options | FOS.FOS_PICKFOLDERS | FOS.FOS_FORCEFILESYSTEM | FOS.FOS_PATHMUSTEXIST | FOS.FOS_DONTADDTORECENT);
    dialog.SetTitle("Select FileGram download folder");
    dialog.SetOkButtonLabel("Select folder");
    int hr = dialog.Show(IntPtr.Zero);
    if (hr != 0) return null;
    dialog.GetResult(out IShellItem item);
    item.GetDisplayName(SIGDN.FILESYSPATH, out IntPtr ptr);
    try { return Marshal.PtrToStringUni(ptr); }
    finally { if (ptr != IntPtr.Zero) Marshal.FreeCoTaskMem(ptr); }
  }
}
"@
Add-Type -TypeDefinition $source -Language CSharp
$selected = [FileGramFolderPicker]::Pick()
if ($selected) { [Console]::Out.Write($selected) }
`
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        finish(reject, new Error('Folder picker timed out'))
      }, 5 * 60 * 1000)
      if (timer.unref) timer.unref()
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
      child.on('error', error => finish(reject, error))
      child.on('close', code => {
        if (code !== 0) return finish(reject, new Error(stderr.trim() || `Folder picker exited with code ${code}`))
        finish(resolve, stdout.trim() || null)
      })
    })
  }

  function wrappedExpress (...args) {
    const app = priorExpress(...args)
    app.post('/api/filegram/pick-download-folder-modern', async (req, res) => {
      try {
        const selectedPath = await pickFolderWindows()
        res.json({ ok: true, cancelled: !selectedPath, path: selectedPath })
      } catch (error) {
        res.status(Number(error && error.status || 500)).json({ ok: false, error: String(error && error.message ? error.message : error) })
      }
    })
    return app
  }

  Object.setPrototypeOf(wrappedExpress, priorExpress)
  for (const name of Object.keys(priorExpress)) wrappedExpress[name] = priorExpress[name]
  require.cache[expressPath].exports = wrappedExpress
}
