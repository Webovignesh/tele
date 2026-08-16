'use strict'

/* Full-size Windows Explorer-style folder chooser.
 *
 * FolderBrowserDialog is intentionally avoided because Windows renders it as the
 * tiny legacy tree window. OpenFileDialog uses the normal Explorer shell surface;
 * ValidateNames=false lets us use that modern full-size dialog as a folder
 * chooser while still returning a filesystem directory to FileGram.
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

      const script = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select FileGram download folder'
$dialog.Filter = 'Folder|*.filegramfolder'
$dialog.ValidateNames = $false
$dialog.CheckFileExists = $false
$dialog.CheckPathExists = $true
$dialog.Multiselect = $false
$dialog.FileName = 'Select this folder'
$dialog.RestoreDirectory = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  $selected = Split-Path -Parent $dialog.FileName
  if ($selected) { [Console]::Out.Write($selected) }
}
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
