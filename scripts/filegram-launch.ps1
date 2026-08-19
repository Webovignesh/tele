$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$BaseUrl = 'http://127.0.0.1:3000'
$HealthUrl = "$BaseUrl/api/filegram/asset-hashes"
$StateDir = Join-Path $Root '.filegram_state'
$LauncherDir = Join-Path $StateDir 'launcher'
$OutLog = Join-Path $LauncherDir 'server.out.log'
$ErrLog = Join-Path $LauncherDir 'server.err.log'
$PidFile = Join-Path $LauncherDir 'server.pid'

New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null

function Show-FileGramMessage([string]$Message, [int]$Icon = 48) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, 'FileGram', $Icon)
  } catch {}
}

function Get-FileGramStatus {
  try {
    $status = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 2
    if ($status -and $status.ok -eq $true -and $status.serverPid) { return $status }
  } catch {}
  return $null
}

$status = Get-FileGramStatus
if (-not $status) {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) {
    Show-FileGramMessage 'Node.js/npm was not found. Install Node.js, then run Install FileGram.cmd once.' 16
    exit 1
  }

  try {
    $process = Start-Process -FilePath $npm.Source -ArgumentList 'start' -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
  } catch {
    Show-FileGramMessage ("FileGram could not start.`n`n" + $_.Exception.Message) 16
    exit 1
  }

  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 250
    $status = Get-FileGramStatus
    if ($status) { break }
    if ($process.HasExited) { break }
  }

  if (-not $status) {
    $detail = ''
    if (Test-Path $ErrLog) {
      try { $detail = (Get-Content $ErrLog -Tail 8 -ErrorAction SilentlyContinue) -join "`n" } catch {}
    }
    $message = "FileGram did not become ready.`n`nLogs:`n$ErrLog"
    if ($detail) { $message += "`n`n$detail" }
    Show-FileGramMessage $message 16
    exit 1
  }
}

try { Set-Content -Path $PidFile -Value ([string]$status.serverPid) -Encoding ASCII } catch {}
Start-Process $BaseUrl
