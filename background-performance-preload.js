'use strict'

/* FileGram's transfer engine is Node + TDLib, not the browser tab. On Windows the
 * local server is normally launched hidden and may spend hours with its browser
 * tab minimized or behind another application. Windows can apply execution-speed
 * power throttling to background processes; when that happens TDLib's network and
 * file-processing callbacks can be serviced much less aggressively even though the
 * download queue itself is healthy.
 *
 * Apply the policy to THIS Node process, so it also works when FileGram is started
 * with `npm start` rather than through the desktop launcher. This is intentionally
 * process-scoped: it does not change the user's global Windows power plan and does
 * not touch Chrome/Edge settings.
 */

if (!global.__fileGramBackgroundPerformanceInstalled) {
  global.__fileGramBackgroundPerformanceInstalled = true

  if (process.platform === 'win32') {
    const { spawn } = require('node:child_process')

    const pid = process.pid
    const ps = String.raw`
$ErrorActionPreference = 'Stop'
$pidToTune = ${pid}

try {
  $process = Get-Process -Id $pidToTune -ErrorAction Stop
  $process.PriorityClass = 'AboveNormal'
} catch {}

try {
  if (-not ('FileGram.NativePower' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace FileGram {
  public static class NativePower {
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_POWER_THROTTLING_STATE {
      public UInt32 Version;
      public UInt32 ControlMask;
      public UInt32 StateMask;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(UInt32 access, bool inheritHandle, UInt32 processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetProcessInformation(
      IntPtr process,
      Int32 informationClass,
      ref PROCESS_POWER_THROTTLING_STATE information,
      UInt32 informationSize);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static bool DisableExecutionSpeedThrottling(UInt32 processId) {
      const UInt32 PROCESS_SET_INFORMATION = 0x0200;
      const UInt32 PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
      const Int32 ProcessPowerThrottling = 4;
      const UInt32 PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
      const UInt32 PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;

      IntPtr handle = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
      if (handle == IntPtr.Zero) return false;
      try {
        var state = new PROCESS_POWER_THROTTLING_STATE {
          Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION,
          ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
          StateMask = 0
        };
        return SetProcessInformation(
          handle,
          ProcessPowerThrottling,
          ref state,
          (UInt32)Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE)));
      } finally {
        CloseHandle(handle);
      }
    }
  }
}
'@
  }
  [void][FileGram.NativePower]::DisableExecutionSpeedThrottling([uint32]$pidToTune)
} catch {}
`

    try {
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', ps
      ], {
        windowsHide: true,
        stdio: 'ignore'
      })
      child.once('error', () => {})
      child.once('exit', code => {
        if (code === 0) console.log(`[performance] background transfer policy active for pid ${pid}`)
      })
      child.unref()
    } catch {}
  }
}
