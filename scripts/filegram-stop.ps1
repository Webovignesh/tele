$ErrorActionPreference = 'SilentlyContinue'

$BaseUrl = 'http://127.0.0.1:3000'
$HealthUrl = "$BaseUrl/api/filegram/asset-hashes"

try {
  $status = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 2
  if ($status -and $status.ok -eq $true -and $status.serverPid) {
    Stop-Process -Id ([int]$status.serverPid) -Force -ErrorAction SilentlyContinue
  }
} catch {}
