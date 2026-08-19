$ErrorActionPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\FileGram'
$StopScript = Join-Path $PSScriptRoot 'filegram-stop.ps1'

& $StopScript
Remove-Item -Force (Join-Path $Desktop 'FileGram.lnk') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $StartMenu -ErrorAction SilentlyContinue

Write-Host 'FileGram shortcuts were removed and the local server was stopped.' -ForegroundColor Green
Write-Host 'Telegram login/session data, .td_database, .td_files, downloads, config.json, settings.json and .filegram_state were preserved.'
Write-Host 'Delete the repository folder manually only if you intentionally want to remove the application files.'
