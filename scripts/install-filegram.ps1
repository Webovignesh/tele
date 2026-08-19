$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $Root 'FileGram.vbs'
$StopScript = Join-Path $PSScriptRoot 'filegram-stop.ps1'
$Desktop = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\FileGram'
$Wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$PowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$WorkingDirectory) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Description = 'FileGram local Telegram media manager'
  $shortcut.Save()
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  throw 'Node.js/npm is required. Install Node.js first, then run Install FileGram.cmd again.'
}

# A developer may still have `npm start` running. Stop only the FileGram process
# identified by its local health endpoint before npm ci replaces node_modules.
& $StopScript
Start-Sleep -Milliseconds 500

Push-Location $Root
try {
  Write-Host 'Preparing FileGram local release dependencies...'
  & $npm.Source ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null
New-Shortcut (Join-Path $Desktop 'FileGram.lnk') $Wscript ('"' + $Launcher + '"') $Root
New-Shortcut (Join-Path $StartMenu 'FileGram.lnk') $Wscript ('"' + $Launcher + '"') $Root
New-Shortcut (Join-Path $StartMenu 'Stop FileGram.lnk') $PowerShell ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $StopScript + '"') $Root

Write-Host ''
Write-Host 'FileGram is installed for this Windows account.' -ForegroundColor Green
Write-Host 'Use the FileGram desktop shortcut from now on. No npm start command is required.'
Write-Host 'Telegram session/database/download state was not changed.'

Start-Process -FilePath $Wscript -ArgumentList ('"' + $Launcher + '"') -WorkingDirectory $Root
